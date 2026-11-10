import { DatabaseSync, backup } from "node:sqlite";
import lockfile from "proper-lockfile";
import { mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Config, Contract, RuntimeRoute } from "./contracts.ts";
import {
  hash,
  apiTaskReservation,
  contractSchema,
  pathInScope,
  canonicalPath,
} from "./contracts.ts";

export type AttemptState =
  | "INTENT"
  | "SENDING"
  | "RUNNING"
  | "UNKNOWN"
  | "PERMISSION"
  | "TURN_COMPLETE"
  | "WAITING_PROCESSES"
  | "NEEDS_CONFIRMATION"
  | "VERIFY"
  | "FAILED"
  | "COMPLETE";
export interface Attempt {
  id: string;
  task_key: string;
  sequence: number;
  status: AttemptState;
  route_json: string;
  agent_id: string | null;
  fence: number;
  session_key: string;
  created_ms: number;
  result_hash: string | null;
  error_kind: string | null;
  reused: number;
  run_accepted: number;
}
export interface TaskRow {
  key: string;
  contract_json: string;
  contract_hash: string;
  config_hash: string;
  config_json: string;
  state: string;
  rework: number;
}
export const liveStates = [
  "INTENT",
  "SENDING",
  "RUNNING",
  "UNKNOWN",
  "PERMISSION",
  "TURN_COMPLETE",
  "WAITING_PROCESSES",
  "NEEDS_CONFIRMATION",
];

interface Ownership {
  attempt_id: string;
  state: string;
  status: AttemptState;
  task_key: string;
  contract_json: string;
}
interface CheckApproval {
  contractHash: string;
  checks: Contract["checks"];
  scriptHashes?: Record<string, string>;
}
const activeReviewStates =
  "'INTENT','SENDING','UNKNOWN','RUNNING','PERMISSION','NEEDS_CONFIRMATION','WAITING_PROCESSES'";

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  return normalize(path.resolve(left)) === normalize(path.resolve(right));
}

function sameCohort(left: Contract, right: Contract): boolean {
  return (
    !!left.workspace &&
    !!right.workspace &&
    left.workspace.id === right.workspace.id &&
    left.workspace.mainAgentId === right.workspace.mainAgentId &&
    samePath(left.workspace.directory, right.workspace.directory) &&
    left.workflowId === right.workflowId &&
    samePath(left.repository, right.repository) &&
    samePath(left.worktree, right.worktree) &&
    left.baseCommit === right.baseCommit &&
    left.dataScope === right.dataScope
  );
}

function scopesOverlap(left: string[], right: string[]): boolean {
  return left.some((a) => right.some((b) => pathInScope(a, b) || pathInScope(b, a)));
}

function lockStoreInitialization(filename: string): () => void {
  const deadline = Date.now() + 5000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      return lockfile.lockSync(`${path.resolve(filename)}.initialization`, {
        realpath: false,
        stale: 120000,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
      if (Date.now() >= deadline) throw Error("CONTROLLER_STATE_BUSY", { cause: error });
      Atomics.wait(wait, 0, 0, 50);
    }
  }
}

export class Store {
  readonly db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ":memory:")
      mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    // First RPCs use separate processes. Serialize the WAL transition and the
    // complete version check/migration sequence, including fresh database creation.
    const release = filename === ":memory:" ? undefined : lockStoreInitialization(filename);
    try {
      this.db = new DatabaseSync(filename);
      try {
        this.initializeSchema(filename);
      } catch (error) {
        this.db.close();
        throw error;
      }
    } finally {
      release?.();
    }
  }
  private initializeSchema(filename: string): void {
    this.db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
    );
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    if (version !== 0 && ![2, 3, 4, 5, 6, 7, 8, 9].includes(version)) {
      throw Error("Unsupported database version; no automatic migration");
    }
    if (version !== 0 && version !== 9)
      this.db.prepare("VACUUM INTO ?").run(filename + ".before-v9-" + Date.now() + ".sqlite");
    if (version === 2 || version === 3) {
      this.transaction(() =>
        this.db.exec(
          "DROP INDEX one_live_attempt; CREATE UNIQUE INDEX one_live_attempt ON attempts(task_key) WHERE status IN ('INTENT','SENDING','RUNNING','UNKNOWN','PERMISSION','TURN_COMPLETE','WAITING_PROCESSES','NEEDS_CONFIRMATION'); CREATE TABLE turn_checks(attempt_id TEXT PRIMARY KEY REFERENCES attempts(id), diff_hash TEXT NOT NULL, result_json TEXT NOT NULL); PRAGMA user_version=4;",
        ),
      );
    }
    if (version === 0)
      this.transaction(() =>
        this.db.exec(`
      CREATE TABLE workflows(id TEXT PRIMARY KEY, repository TEXT NOT NULL, scope TEXT NOT NULL, config_hash TEXT NOT NULL);
      CREATE TABLE tasks(key TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id), contract_json TEXT NOT NULL,
        contract_hash TEXT NOT NULL, config_hash TEXT NOT NULL, config_json TEXT NOT NULL, state TEXT NOT NULL, rework INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE attempts(id TEXT PRIMARY KEY, task_key TEXT NOT NULL REFERENCES tasks(key), sequence INTEGER NOT NULL,
        status TEXT NOT NULL, route_json TEXT NOT NULL, agent_id TEXT, fence INTEGER NOT NULL, session_key TEXT NOT NULL,
        created_ms INTEGER NOT NULL, result_hash TEXT, error_kind TEXT,
        reused INTEGER NOT NULL DEFAULT 0, run_accepted INTEGER NOT NULL DEFAULT 0, UNIQUE(task_key,sequence));
      CREATE UNIQUE INDEX one_live_attempt ON attempts(task_key) WHERE status IN ('INTENT','SENDING','RUNNING','UNKNOWN','PERMISSION','TURN_COMPLETE','WAITING_PROCESSES','NEEDS_CONFIRMATION');
      CREATE TABLE leases(worktree TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, fence INTEGER NOT NULL, state TEXT NOT NULL, heartbeat_ms INTEGER NOT NULL);
      CREATE TABLE outbox(attempt_id TEXT PRIMARY KEY REFERENCES attempts(id), state TEXT NOT NULL);
      CREATE TABLE sessions(key TEXT PRIMARY KEY, agent_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, context_fraction REAL,
        reconciled_ms INTEGER NOT NULL, usage_json TEXT);
      CREATE TABLE circuits(access TEXT PRIMARY KEY, until_ms INTEGER, reason TEXT NOT NULL);
      CREATE TABLE grants(account TEXT PRIMARY KEY, cycle TEXT NOT NULL, granted INTEGER NOT NULL, remaining INTEGER NOT NULL,
        verified_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL, approved INTEGER NOT NULL);
      CREATE TABLE reservations(id TEXT PRIMARY KEY REFERENCES attempts(id), cycle TEXT NOT NULL, bucket TEXT NOT NULL,
        reserved INTEGER NOT NULL, settled INTEGER, state TEXT NOT NULL);
      CREATE TABLE reviews(attempt_id TEXT PRIMARY KEY REFERENCES attempts(id), diff_hash TEXT NOT NULL, evidence_json TEXT NOT NULL);
      CREATE TABLE turn_checks(attempt_id TEXT PRIMARY KEY REFERENCES attempts(id), diff_hash TEXT NOT NULL, result_json TEXT NOT NULL);
      CREATE TABLE review_runs(attempt_id TEXT PRIMARY KEY REFERENCES attempts(id), request_key TEXT NOT NULL UNIQUE,
        route_json TEXT NOT NULL, agent_id TEXT, state TEXT NOT NULL, diff_hash TEXT NOT NULL, result_json TEXT);
      CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, kind TEXT NOT NULL, attempt_id TEXT);
      CREATE TABLE switches(id INTEGER PRIMARY KEY CHECK(id=1), stopped INTEGER NOT NULL);
      INSERT INTO switches VALUES(1,0);
      PRAGMA user_version=4;
    `),
      );
    if (version < 5)
      this.transaction(() =>
        this.db.exec(
          "CREATE TABLE check_locks(worktree TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id)); PRAGMA user_version=5;",
        ),
      );
    if (version < 6)
      this.transaction(() =>
        this.db.exec(`CREATE TABLE decision_calls(
      key TEXT PRIMARY KEY, cycle TEXT NOT NULL, state TEXT NOT NULL, reserved INTEGER NOT NULL,
      charged INTEGER, result_json TEXT, error_kind TEXT, created_ms INTEGER NOT NULL);
      PRAGMA user_version=6;`),
      );
    if (version < 7)
      this.transaction(() =>
        this.db.exec(`
      CREATE TABLE assessments(id TEXT PRIMARY KEY,kind TEXT NOT NULL,owner_id TEXT NOT NULL,
        facts_hash TEXT NOT NULL,facts_json TEXT NOT NULL,result_json TEXT,state TEXT NOT NULL,created_ms INTEGER NOT NULL);
      CREATE INDEX assessments_by_owner ON assessments(owner_id,kind,created_ms);
      CREATE TABLE internal_messages(agent_id TEXT NOT NULL,message_id TEXT NOT NULL,kind TEXT NOT NULL,
        PRIMARY KEY(agent_id,message_id));
      CREATE TABLE main_checkpoints(agent_id TEXT PRIMARY KEY,message_id TEXT,turn_count INTEGER NOT NULL DEFAULT 0,
        reminder_count INTEGER NOT NULL DEFAULT 0,last_reminder_facts TEXT);
      CREATE TABLE research_requests(id TEXT PRIMARY KEY,request_json TEXT NOT NULL,result_json TEXT NOT NULL,
        source_revision TEXT NOT NULL,expires_ms INTEGER NOT NULL);
      CREATE TABLE task_assessments(task_key TEXT PRIMARY KEY REFERENCES tasks(key),intake_id TEXT NOT NULL REFERENCES assessments(id),
        package_id TEXT NOT NULL REFERENCES assessments(id),effective_class TEXT NOT NULL,created_ms INTEGER NOT NULL);
      PRAGMA user_version=7;
    `),
      );
    if (version < 8)
      this.transaction(() =>
        this.db.exec(`
      ALTER TABLE main_checkpoints ADD COLUMN work_intake_id TEXT;
      CREATE TABLE main_turns(agent_id TEXT NOT NULL,turn_id TEXT NOT NULL,PRIMARY KEY(agent_id,turn_id));
      PRAGMA user_version=8;
    `),
      );
    if (version < 9)
      this.transaction(() =>
        this.db.exec(`
      CREATE TABLE research_calls(id TEXT PRIMARY KEY,cycle TEXT NOT NULL,bucket TEXT NOT NULL,
        reserved INTEGER NOT NULL,settled INTEGER,state TEXT NOT NULL);
      CREATE VIEW api_reservations AS SELECT id,cycle,bucket,reserved,settled,state FROM reservations
        UNION ALL SELECT id,cycle,bucket,reserved,settled,state FROM research_calls;
      PRAGMA user_version=9;
    `),
      );
  }
  close(): void {
    this.db.close();
  }
  async backupTo(filename: string): Promise<void> {
    await backup(this.db, filename);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  event(kind: string, attemptId: string | null = null): void {
    this.db
      .prepare("INSERT INTO events(at_ms,kind,attempt_id) VALUES(?,?,?)")
      .run(Date.now(), kind, attemptId);
  }
  stopped(): boolean {
    return !!(this.db.prepare("SELECT stopped FROM switches").get() as { stopped: number }).stopped;
  }
  stop(stopped: boolean): void {
    this.db.prepare("UPDATE switches SET stopped=?").run(Number(stopped));
    this.event(stopped ? "STOP_DISPATCH" : "RESUME_DISPATCH");
  }
  add(c: Contract, config: Config): string {
    if (c.amendsTaskKey || c.amendsContractHash || c.amendsDiffHash)
      throw Error("AMENDMENT_REQUIRES_SETTLEMENT");
    const key = `${c.workflowId}/${c.taskId}/${c.role}`;
    return this.transaction(() => {
      const w = this.db.prepare("SELECT * FROM workflows WHERE id=?").get(c.workflowId) as
        | { repository: string; scope: string; config_hash: string }
        | undefined;
      if (
        w &&
        (w.repository !== c.repository || w.scope !== c.dataScope || w.config_hash !== hash(config))
      )
        throw Error("Workflow identity changed");
      this.db
        .prepare("INSERT OR IGNORE INTO workflows VALUES(?,?,?,?)")
        .run(c.workflowId, c.repository, c.dataScope, hash(config));
      const existing = this.task(key);
      if (existing && (existing.contract_hash !== hash(c) || existing.config_hash !== hash(config)))
        throw Error("Immutable contract/config changed; use a new task ID");
      this.db
        .prepare(
          "INSERT OR IGNORE INTO tasks(key,workflow_id,contract_json,contract_hash,config_hash,config_json,state) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          key,
          c.workflowId,
          JSON.stringify(c),
          hash(c),
          hash(config),
          JSON.stringify(config),
          "READY",
        );
      this.event("TASK_ADDED");
      return key;
    });
  }
  addAmendment(c: Contract, config: Config, predecessorKey: string, authorize: () => void): string {
    const key = `${c.workflowId}/${c.taskId}/${c.role}`;
    return this.transaction(() => {
      authorize();
      if (
        !c.amendsTaskKey ||
        !c.amendsContractHash ||
        !c.amendsDiffHash ||
        !c.intakeId ||
        !c.packageAssessmentId
      )
        throw Error("AMENDMENT_LINEAGE_REQUIRED");
      if (c.amendsTaskKey !== predecessorKey || key === predecessorKey)
        throw Error("AMENDMENT_TARGET_MISMATCH");
      const predecessor = this.task(predecessorKey),
        attempt = this.latest(predecessorKey);
      if (
        !predecessor ||
        predecessor.contract_hash !== c.amendsContractHash ||
        predecessor.contract_hash !== hash(JSON.parse(predecessor.contract_json))
      )
        throw Error("AMENDMENT_PREDECESSOR_CHANGED");
      const prior = contractSchema.parse(JSON.parse(predecessor.contract_json));
      if (
        prior.workflowId !== c.workflowId ||
        prior.repository !== c.repository ||
        prior.worktree !== c.worktree ||
        prior.baseCommit !== c.baseCommit ||
        prior.dataScope !== c.dataScope
      )
        throw Error("AMENDMENT_WORKTREE_IDENTITY_MISMATCH");
      if (
        predecessor.state !== "NEEDS_CONFIRMATION" ||
        !attempt ||
        attempt.status !== "NEEDS_CONFIRMATION" ||
        this.latest(predecessorKey)?.id !== attempt.id
      )
        throw Error("AMENDMENT_WAITING_WORKER_SETTLEMENT");
      const lease = this.db
        .prepare("SELECT state,fence FROM leases WHERE worktree=? AND attempt_id=?")
        .get(prior.worktree, attempt.id) as { state: string; fence: number } | undefined;
      if (!lease || lease.fence !== attempt.fence || !["HELD", "SUSPECT"].includes(lease.state))
        throw Error("AMENDMENT_WAITING_LEASE_SETTLEMENT");
      if (
        this.db.prepare("SELECT 1 FROM reservations WHERE id=? AND state='PENDING'").get(attempt.id)
      )
        throw Error("AMENDMENT_WAITING_BUDGET_SETTLEMENT");
      const owners = this.ownership(c);
      if (owners.length !== 1 || owners[0].attempt_id !== attempt.id)
        throw Error("AMENDMENT_WAITING_PEER_LEASE");
      const otherActive = this.active().some((active) => {
        if (active.id === attempt.id) return false;
        const task = this.task(active.task_key);
        return !!task && samePath(JSON.parse(task.contract_json).worktree, prior.worktree);
      });
      if (otherActive) throw Error("AMENDMENT_WAITING_PEER_LEASE");
      if (
        this.db.prepare("SELECT 1 FROM check_locks WHERE worktree=?").get(c.worktree) ||
        this.reviewInWorktree(c)
      )
        throw Error("AMENDMENT_WAITING_REVIEW_OR_CHECK");
      const packageAssessment = this.db
        .prepare(
          "SELECT owner_id FROM assessments WHERE id=? AND kind='package' AND result_json IS NOT NULL",
        )
        .get(c.packageAssessmentId) as { owner_id: string } | undefined;
      const intakeAssessment = this.db
        .prepare(
          "SELECT owner_id FROM assessments WHERE id=? AND kind='intake' AND result_json IS NOT NULL",
        )
        .get(c.intakeId) as { owner_id: string } | undefined;
      if (
        !packageAssessment ||
        !intakeAssessment ||
        packageAssessment.owner_id !== intakeAssessment.owner_id
      )
        throw Error("TASK_ASSESSMENT_REQUIRED");
      const workflow = this.db.prepare("SELECT * FROM workflows WHERE id=?").get(c.workflowId) as
        | { repository: string; scope: string; config_hash: string }
        | undefined;
      if (
        workflow &&
        (workflow.repository !== c.repository ||
          workflow.scope !== c.dataScope ||
          workflow.config_hash !== hash(config))
      )
        throw Error("Workflow identity changed");
      const existing = this.task(key);
      if (existing) throw Error("AMENDMENT_TASK_ID_ALREADY_REGISTERED");
      this.db
        .prepare("INSERT OR IGNORE INTO workflows VALUES(?,?,?,?)")
        .run(c.workflowId, c.repository, c.dataScope, hash(config));
      const updatedAttempt = this.db
        .prepare(
          "UPDATE attempts SET status='FAILED',error_kind='task-amended',result_hash=? WHERE id=? AND fence=? AND status='NEEDS_CONFIRMATION'",
        )
        .run(c.amendsDiffHash, attempt.id, attempt.fence).changes;
      const updatedTask = this.db
        .prepare("UPDATE tasks SET state='SUPERSEDED' WHERE key=? AND state='NEEDS_CONFIRMATION'")
        .run(predecessorKey).changes;
      const releasedLease = this.db
        .prepare(
          "UPDATE leases SET state='RELEASED',heartbeat_ms=? WHERE worktree=? AND attempt_id=? AND fence=? AND state IN ('HELD','SUSPECT')",
        )
        .run(Date.now(), prior.worktree, attempt.id, attempt.fence).changes;
      if (updatedAttempt !== 1 || updatedTask !== 1 || releasedLease !== 1)
        throw Error("AMENDMENT_STATE_CHANGED");
      this.db
        .prepare(
          "INSERT INTO tasks(key,workflow_id,contract_json,contract_hash,config_hash,config_json,state) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          key,
          c.workflowId,
          JSON.stringify(c),
          hash(c),
          hash(config),
          JSON.stringify(config),
          "READY",
        );
      this.db
        .prepare("INSERT INTO task_assessments VALUES(?,?,?,?,?)")
        .run(key, c.intakeId, c.packageAssessmentId, c.role, Date.now());
      this.event(
        `TASK_SUPERSEDED_BY_AMENDMENT:${JSON.stringify({
          priorTaskKey: predecessorKey,
          priorContractHash: c.amendsContractHash,
          priorDiffHash: c.amendsDiffHash,
          newTaskKey: key,
          newContractHash: hash(c),
          intakeId: c.intakeId,
          packageAssessmentId: c.packageAssessmentId,
        })}`,
        attempt.id,
      );
      this.event("TASK_ADDED");
      return key;
    });
  }
  task(key: string): TaskRow | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE key=?").get(key) as TaskRow | undefined;
  }
  attempt(id: string): Attempt {
    const a = this.db.prepare("SELECT * FROM attempts WHERE id=?").get(id) as Attempt | undefined;
    if (!a) throw Error("Attempt not found");
    return a;
  }
  active(): Attempt[] {
    return this.db
      .prepare(
        "SELECT * FROM attempts WHERE status IN ('INTENT','SENDING','RUNNING','UNKNOWN','PERMISSION','TURN_COMPLETE','WAITING_PROCESSES','NEEDS_CONFIRMATION') ORDER BY created_ms",
      )
      .all() as unknown as Attempt[];
  }
  latest(key: string): Attempt | undefined {
    return this.db
      .prepare("SELECT * FROM attempts WHERE task_key=? ORDER BY sequence DESC LIMIT 1")
      .get(key) as Attempt | undefined;
  }
  completionReason(attemptId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT kind FROM events WHERE attempt_id=? AND kind LIKE 'COMPLETION_CHECK:%' ORDER BY sequence DESC LIMIT 1",
      )
      .get(attemptId) as { kind: string } | undefined;
    const reason = row?.kind.slice("COMPLETION_CHECK:".length);
    return reason && /^[a-z-]{1,80}$/.test(reason) ? reason : null;
  }
  scopePaths(c: Contract): string[] {
    const key = `${c.workflowId}/${c.taskId}/${c.role}`;
    const prefix = "OPERATOR_SCOPE_EXTENSION:";
    const rows = this.db
      .prepare(`SELECT e.kind FROM events e JOIN attempts a ON a.id=e.attempt_id
      WHERE a.task_key=? AND e.kind LIKE 'OPERATOR_SCOPE_EXTENSION:%' ORDER BY e.rowid`)
      .all(key) as { kind: string }[];
    const paths = [...c.allowedPaths];
    for (const row of rows) {
      if (!row.kind.startsWith(prefix)) continue;
      const approval = JSON.parse(row.kind.slice(prefix.length)) as {
        contractHash: string;
        paths: string[];
      };
      if (approval.contractHash !== hash(c)) continue;
      // Audit records are not an alternative path-validation or contract channel.
      paths.push(...contractSchema.parse({ ...c, allowedPaths: approval.paths }).allowedPaths);
    }
    return [...new Set(paths)];
  }
  scopeRevision(c: Contract): string {
    return hash({ contractHash: hash(c), paths: this.scopePaths(c).sort() });
  }
  private checkApproval(c: Contract): CheckApproval | undefined {
    const key = `${c.workflowId}/${c.taskId}/${c.role}`,
      prefix = "OPERATOR_CHECK_COMMANDS:";
    const rows = this.db
      .prepare(`SELECT e.kind FROM events e JOIN attempts a ON a.id=e.attempt_id
      WHERE a.task_key=? AND e.kind LIKE 'OPERATOR_CHECK_COMMANDS:%' ORDER BY e.rowid DESC`)
      .all(key) as { kind: string }[];
    for (const row of rows) {
      const approval = JSON.parse(row.kind.slice(prefix.length)) as CheckApproval;
      if (approval.contractHash === hash(c)) return approval;
    }
    return undefined;
  }
  private checkScriptHashes(c: Contract, checks: Contract["checks"]): Record<string, string> {
    const hashes: Record<string, string> = {};
    try {
      for (const command of [checks.build, checks.test])
        for (const argument of command) {
          if (!path.isAbsolute(argument) || !/\.(?:ps1|[cm]?js|ts)$/i.test(argument)) continue;
          const file = canonicalPath(argument),
            relative = path.relative(c.worktree, file);
          if (
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          )
            hashes[file] = createHash("sha256").update(readFileSync(file)).digest("hex");
        }
    } catch {
      throw Error("CHECK_COMMAND_SCRIPT_UNAVAILABLE");
    }
    return hashes;
  }
  checkCommands(c: Contract): Contract["checks"] {
    const approval = this.checkApproval(c);
    if (!approval) return c.checks;
    const checks = contractSchema.parse({ ...c, checks: approval.checks }).checks;
    if (hash(approval.scriptHashes ?? {}) !== hash(this.checkScriptHashes(c, checks)))
      throw Error("CHECK_COMMAND_SCRIPT_CHANGED");
    return checks;
  }
  approveCheckCommands(key: string, checks: Contract["checks"], reason: string): string {
    return this.transaction(() => {
      const task = this.task(key),
        attempt = this.latest(key);
      if (
        !task ||
        !attempt?.agent_id ||
        attempt.status !== "NEEDS_CONFIRMATION" ||
        !reason.trim() ||
        reason.length > 500
      )
        throw Error("CHECK_COMMAND_APPROVAL_REQUIRES_PAUSED_TASK");
      const c: Contract = JSON.parse(task.contract_json);
      if (task.contract_hash !== hash(c) || !c.mutation || !c.role.startsWith("implement-"))
        throw Error("CHECK_COMMAND_CONTRACT_INVALID");
      const validated = contractSchema.parse({ ...c, checks }).checks;
      for (const command of [validated.build, validated.test]) {
        const worktreeIndex = command.findIndex(
          (argument) => argument.toLowerCase() === "-worktree",
        );
        if (
          worktreeIndex >= 0 &&
          (!command[worktreeIndex + 1] ||
            canonicalPath(command[worktreeIndex + 1]) !== canonicalPath(c.worktree))
        )
          throw Error("CHECK_COMMAND_WORKTREE_MISMATCH");
        const resultsIndex = command.findIndex(
          (argument) => argument.toLowerCase() === "-resultsroot",
        );
        if (resultsIndex >= 0) {
          const relative = path.relative(
            canonicalPath(c.worktree),
            canonicalPath(command[resultsIndex + 1]),
          );
          if (
            relative === "" ||
            (relative !== ".." &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative))
          )
            throw Error("CHECK_COMMAND_RESULTS_INSIDE_WORKTREE");
        }
      }
      const scriptHashes = this.checkScriptHashes(c, validated),
        previous = this.checkApproval(c);
      if (
        !this.db
          .prepare(
            "SELECT 1 FROM leases WHERE attempt_id=? AND fence=? AND state IN ('HELD','SUSPECT')",
          )
          .get(attempt.id, attempt.fence)
      )
        throw Error("CHECK_COMMAND_LEASE_LOST");
      if (
        this.db.prepare("SELECT 1 FROM check_locks WHERE worktree=?").get(c.worktree) ||
        this.db.prepare("SELECT 1 FROM turn_checks WHERE attempt_id=?").get(attempt.id) ||
        this.db.prepare("SELECT 1 FROM review_runs WHERE attempt_id=?").get(attempt.id)
      )
        throw Error("CHECK_COMMAND_EVIDENCE_EXISTS");
      if (
        hash(previous?.checks ?? c.checks) !== hash(validated) ||
        hash(previous?.scriptHashes ?? {}) !== hash(scriptHashes)
      )
        this.event(
          `OPERATOR_CHECK_COMMANDS:${JSON.stringify({ contractHash: hash(c), checks: validated, scriptHashes, reason })}`,
          attempt.id,
        );
      return hash({ contractHash: hash(c), checks: validated, scriptHashes });
    });
  }
  approveScopeExtension(key: string, paths: string[], reason: string): string {
    return this.transaction(() => {
      const task = this.task(key);
      if (!task) throw Error("SCOPE_EXTENSION_TASK_REQUIRED");
      const c: Contract = JSON.parse(task.contract_json);
      if (task.contract_hash !== hash(c) || !c.mutation || !c.role.startsWith("implement-"))
        throw Error("SCOPE_EXTENSION_CONTRACT_INVALID");
      if (!reason.trim() || reason.length > 500 || paths.length === 0)
        throw Error("SCOPE_EXTENSION_REASON_AND_PATHS_REQUIRED");
      const validated = contractSchema.parse({ ...c, allowedPaths: paths }).allowedPaths;
      const current = this.scopePaths(c);
      const additional = [...new Set(validated)].filter(
        (candidate) => !current.some((allowed) => pathInScope(candidate, allowed)),
      );
      if (additional.length > 10) throw Error("SCOPE_EXTENSION_TOO_MANY_PATHS");
      if (!additional.length) return this.scopeRevision(c);
      const attempt = this.latest(key);
      if (!attempt?.agent_id || attempt.status !== "NEEDS_CONFIRMATION")
        throw Error("SCOPE_EXTENSION_WORKER_MUST_BE_PAUSED");
      if (
        !this.db
          .prepare(
            "SELECT 1 FROM leases WHERE attempt_id=? AND fence=? AND state IN ('HELD','SUSPECT')",
          )
          .get(attempt.id, attempt.fence)
      )
        throw Error("SCOPE_EXTENSION_LEASE_LOST");
      if (
        this.db.prepare("SELECT 1 FROM check_locks WHERE worktree=?").get(c.worktree) ||
        this.db.prepare("SELECT 1 FROM review_runs WHERE attempt_id=?").get(attempt.id) ||
        this.reviewInWorktree(c)
      )
        throw Error("SCOPE_EXTENSION_VERIFICATION_EXISTS");
      for (const peer of this.ownership(c).filter((row) => row.task_key !== key)) {
        const other: Contract = JSON.parse(peer.contract_json);
        if (
          !sameCohort(c, other) ||
          peer.state !== "HELD" ||
          scopesOverlap([...current, ...additional], this.scopePaths(other))
        )
          throw Error("SCOPE_EXTENSION_PEER_OWNERSHIP");
      }
      this.event(
        `OPERATOR_SCOPE_EXTENSION:${JSON.stringify({ contractHash: hash(c), paths: additional, reason })}`,
        attempt.id,
      );
      return this.scopeRevision(c);
    });
  }
  private ownership(c: Contract): Ownership[] {
    // leases.worktree remains the schema-compatible resource key. The actual Git
    // directory always comes from its immutable task, including legacy leases.
    const rows = this.db
      .prepare(`SELECT l.attempt_id,l.state,a.status,a.task_key,t.contract_json
      FROM leases l JOIN attempts a ON a.id=l.attempt_id JOIN tasks t ON t.key=a.task_key
      WHERE l.state!='RELEASED'`)
      .all() as unknown as Ownership[];
    return rows.filter((row) => samePath(JSON.parse(row.contract_json).worktree, c.worktree));
  }
  private reviewInWorktree(c: Contract): boolean {
    const rows = this.db
      .prepare(`SELECT t.contract_json FROM review_runs r
      JOIN attempts a ON a.id=r.attempt_id JOIN tasks t ON t.key=a.task_key
      WHERE r.state IN (${activeReviewStates})`)
      .all() as { contract_json: string }[];
    return rows.some((row) => samePath(JSON.parse(row.contract_json).worktree, c.worktree));
  }
  coordinationBlock(c: Contract): string | undefined {
    if (this.db.prepare("SELECT 1 FROM check_locks WHERE worktree=?").get(c.worktree))
      return "check-process-ownership-unresolved";
    if (this.reviewInWorktree(c)) return "combined-review-in-progress";
    const key = `${c.workflowId}/${c.taskId}/${c.role}`;
    for (const peer of this.ownership(c).filter((row) => row.task_key !== key)) {
      const other: Contract = JSON.parse(peer.contract_json);
      if (!sameCohort(c, other)) return "worktree-lease-held-or-suspect";
      if (
        peer.state !== "HELD" ||
        ["UNKNOWN", "PERMISSION", "NEEDS_CONFIRMATION"].includes(peer.status)
      )
        return "peer-process-state-unclear";
      if (peer.status === "VERIFY") return "combined-verification-in-progress";
      if (
        !c.mutation ||
        !other.mutation ||
        scopesOverlap(this.scopePaths(c), this.scopePaths(other))
      )
        return "file-ownership-overlap";
    }
    return undefined;
  }
  verificationBlocked(c: Contract, attemptId: string): boolean {
    if (
      this.ownership(c).some(
        (peer) =>
          peer.attempt_id !== attemptId &&
          (peer.state !== "HELD" || !["VERIFY", "COMPLETE"].includes(peer.status)),
      )
    )
      return true;
    if (!c.workspace) return false;
    // Released leases do not remove failed changes from the shared checkout.
    const rows = this.db
      .prepare(`SELECT t.contract_json,a.status FROM tasks t JOIN attempts a ON a.task_key=t.key
      WHERE a.sequence=(SELECT MAX(sequence) FROM attempts WHERE task_key=t.key)`)
      .all() as { contract_json: string; status: string }[];
    return rows.some((row) => {
      const peer: Contract = JSON.parse(row.contract_json);
      return peer.mutation && sameCohort(c, peer) && !["VERIFY", "COMPLETE"].includes(row.status);
    });
  }
  peerAllowedPaths(c: Contract): string[] {
    if (!c.workspace) return [];
    const key = `${c.workflowId}/${c.taskId}/${c.role}`;
    const rows = this.db
      .prepare(`SELECT t.key,t.contract_json FROM tasks t
      WHERE EXISTS(SELECT 1 FROM attempts a WHERE a.task_key=t.key)`)
      .all() as { key: string; contract_json: string }[];
    return [
      ...new Set(
        rows
          .filter((row) => row.key !== key)
          .flatMap((row) => {
            const other: Contract = JSON.parse(row.contract_json);
            return other.mutation && sameCohort(c, other) ? this.scopePaths(other) : [];
          }),
      ),
    ];
  }
  // Source-workspace placement omits workspace IDs, so sameCohort cannot find its leased writer.
  sourceWorkspaceWriterPathsForAdvisor(c: Contract): string[] {
    if (c.role !== "advisor" || c.mutation || c.workspace) return [];
    const key = `${c.workflowId}/${c.taskId}/${c.role}`;
    const paths: string[] = [];
    for (const peer of this.ownership(c)) {
      if (
        peer.task_key === key ||
        peer.state !== "HELD" ||
        (peer.status !== "VERIFY" && !liveStates.includes(peer.status))
      )
        continue;
      const other: Contract = JSON.parse(peer.contract_json);
      if (
        !other.mutation ||
        !other.role.startsWith("implement-") ||
        other.workspace ||
        other.workflowId !== c.workflowId ||
        !samePath(other.repository, c.repository) ||
        other.baseCommit !== c.baseCommit ||
        other.dataScope !== c.dataScope
      )
        continue;
      paths.push(...this.scopePaths(other));
    }
    return [...new Set(paths)];
  }
  private routeOwner(contract: Contract): string {
    if (contract.workspace) return `main:${contract.workspace.mainAgentId}`;
    const intake = contract.intakeId
      ? (this.db.prepare("SELECT owner_id FROM assessments WHERE id=?").get(contract.intakeId) as
          | { owner_id: string }
          | undefined)
      : undefined;
    return intake ? `main:${intake.owner_id}` : `workflow:${contract.workflowId}`;
  }
  routeOccupied(
    route: RuntimeRoute,
    excludeReviewAttemptId?: string,
    contract?: Contract,
  ): boolean {
    const computing = new Set(["INTENT", "SENDING", "RUNNING", "UNKNOWN"]);
    const owner = contract ? this.routeOwner(contract) : undefined;
    const reviews = this.db
      .prepare(`SELECT r.attempt_id,r.route_json,r.state,a.task_key FROM review_runs r
      JOIN attempts a ON a.id=r.attempt_id WHERE r.state IN (${activeReviewStates})`)
      .all() as { attempt_id: string; route_json: string; state: string; task_key: string }[];
    const candidates = [
      ...this.active().filter((attempt) => computing.has(attempt.status)),
      ...reviews.filter(
        (review) => review.attempt_id !== excludeReviewAttemptId && computing.has(review.state),
      ),
    ];
    const occupied = candidates.filter((attempt) => {
      if ((JSON.parse(attempt.route_json) as RuntimeRoute).id !== route.id) return false;
      if (!owner) return true;
      const task = this.task(attempt.task_key);
      return !!task && this.routeOwner(JSON.parse(task.contract_json)) === owner;
    }).length;
    return occupied >= route.maxConcurrent;
  }
  circuitOpen(access: string, now: number): boolean {
    const row = this.db.prepare("SELECT * FROM circuits WHERE access=?").get(access) as
      | { until_ms: number | null }
      | undefined;
    return !!row && (row.until_ms === null || row.until_ms > now);
  }
  blockAccess(access: string, reason: string, until: number | null): void {
    this.db
      .prepare(
        "INSERT INTO circuits VALUES(?,?,?) ON CONFLICT(access) DO UPDATE SET until_ms=excluded.until_ms,reason=excluded.reason",
      )
      .run(access, until, reason);
  }
  private budgetCycle(category: string, amount: number, config: Config, now: number): string {
    if (config.apiFunding) {
      const funding = config.apiFunding;
      const cycle = new Date(now).toISOString().slice(0, 7);
      if (
        !config.apiEnabled ||
        !funding.confirmed ||
        funding.cycle !== cycle ||
        Date.parse(funding.validUntil) <= now ||
        !Number.isSafeInteger(amount) ||
        amount <= 0
      )
        throw Error("Unverified API grant");
      const rows = this.db
        .prepare(
          "SELECT bucket,reserved,settled FROM api_reservations WHERE cycle=? AND state!='RELEASED'",
        )
        .all(cycle) as { bucket: string; reserved: number; settled: number | null }[];
      const total = rows.reduce((sum, row) => sum + (row.settled ?? row.reserved), 0);
      const spent = rows
        .filter((row) => row.bucket === category)
        .reduce((sum, row) => sum + (row.settled ?? row.reserved), 0);
      const limit = config.budgets[category as keyof Config["budgets"]];
      if (
        category === "decisions" ||
        limit === undefined ||
        spent + amount > limit ||
        total + amount + config.budgets.decisions > funding.availableMicroUsd
      )
        throw Error("API budget exhausted");
      return cycle;
    }
    const g = this.db.prepare("SELECT * FROM grants WHERE account='openai-api'").get() as
      | {
          cycle: string;
          granted: number;
          remaining: number;
          verified_ms: number;
          expires_ms: number;
          approved: number;
        }
      | undefined;
    if (
      !g ||
      !g.approved ||
      now < g.verified_ms ||
      now - g.verified_ms > 900000 ||
      now >= g.expires_ms ||
      !Number.isSafeInteger(amount) ||
      amount <= 0
    )
      throw Error("Unverified API grant");
    if (Object.values(config.budgets).reduce((a, b) => a + b, 0) > g.granted)
      throw Error("Allocations exceed actual grant");
    const rows = this.db
      .prepare(
        "SELECT bucket,reserved,settled,state FROM api_reservations WHERE cycle=? AND state!='RELEASED'",
      )
      .all(g.cycle) as {
      bucket: keyof Config["budgets"];
      reserved: number;
      settled: number | null;
      state: string;
    }[];
    const spent = rows
      .filter((r) => r.bucket === category)
      .reduce((n, r) => n + (r.settled ?? r.reserved), 0);
    const pending = rows.filter((r) => r.state === "PENDING").reduce((n, r) => n + r.reserved, 0);
    if (
      !(category in config.budgets) ||
      spent + amount > config.budgets[category as keyof Config["budgets"]] ||
      pending + amount > g.remaining
    )
      throw Error("API budget exhausted");
    return g.cycle;
  }
  canReserveBudget(category: string, amount: number, config: Config, now: number): boolean {
    try {
      this.budgetCycle(category, amount, config, now);
      return true;
    } catch {
      return false;
    }
  }
  apiReservation(
    contract: Contract,
    route: RuntimeRoute,
    config: Config,
    now = Date.now(),
  ): number {
    if (route.access !== "openai-api" || !route.bucket) throw Error("API route required");
    const cycle = this.budgetCycle(route.bucket, 1, config, now);
    const rows = this.db
      .prepare(
        "SELECT bucket,reserved,settled,state FROM api_reservations WHERE cycle=? AND state!='RELEASED'",
      )
      .all(cycle) as { bucket: string; reserved: number; settled: number | null; state: string }[];
    const total = rows.reduce((sum, row) => sum + (row.settled ?? row.reserved), 0);
    const spent = rows
      .filter((row) => row.bucket === route.bucket)
      .reduce((sum, row) => sum + (row.settled ?? row.reserved), 0);
    const remaining = config.apiFunding
      ? config.apiFunding.availableMicroUsd - total - config.budgets.decisions
      : (
          this.db.prepare("SELECT remaining FROM grants WHERE account='openai-api'").get() as {
            remaining: number;
          }
        ).remaining -
        rows.filter((row) => row.state === "PENDING").reduce((sum, row) => sum + row.reserved, 0);
    return apiTaskReservation(
      contract,
      route,
      Math.min(config.budgets[route.bucket] - spent, remaining),
    );
  }
  reserveBudget(id: string, category: string, amount: number, config: Config, now: number): void {
    const cycle = this.budgetCycle(category, amount, config, now);
    this.db
      .prepare("INSERT INTO reservations VALUES(?,?,?,?,NULL,?)")
      .run(id, cycle, category, amount, "PENDING");
  }
  reserveResearch(id: string, route: RuntimeRoute, config: Config): void {
    this.transaction(() => {
      if (
        route.access !== "openai-api" ||
        route.bucket !== "implementation" ||
        !id.startsWith("research:")
      )
        throw Error("Research API route invalid");
      const amount = Math.min(100000, route.maxTaskMicroUsd ?? 100000);
      const cycle = this.budgetCycle(route.bucket, amount, config, Date.now());
      this.db
        .prepare("INSERT INTO research_calls VALUES(?,?,?,?,NULL,?)")
        .run(id, cycle, route.bucket, amount, "PENDING");
    });
  }
  settleResearch(id: string, actual: number): void {
    this.transaction(() => {
      const row = this.db
        .prepare("SELECT reserved,cycle FROM research_calls WHERE id=? AND state='PENDING'")
        .get(id) as { reserved: number; cycle: string } | undefined;
      if (!row || !Number.isSafeInteger(actual) || actual < 0 || actual > row.reserved)
        throw Error("Research settlement invalid");
      this.db
        .prepare("UPDATE research_calls SET settled=?,state='SETTLED' WHERE id=?")
        .run(actual, id);
      this.db
        .prepare(
          "UPDATE grants SET remaining=MAX(0,remaining-?) WHERE account='openai-api' AND cycle=?",
        )
        .run(actual, row.cycle);
    });
  }
  settle(id: string, actual: number): void {
    if (!Number.isSafeInteger(actual) || actual < 0) throw Error("Invalid actual cost");
    this.transaction(() => {
      const r = this.db
        .prepare("SELECT * FROM reservations WHERE id=? AND state='PENDING'")
        .get(id) as { reserved: number; cycle: string } | undefined;
      if (!r) throw Error("Reservation not pending");
      this.db
        .prepare("UPDATE reservations SET settled=?,state='SETTLED' WHERE id=?")
        .run(actual, id);
      this.db
        .prepare(
          "UPDATE grants SET remaining=MAX(0,remaining-?),approved=CASE WHEN ? > ? THEN 0 ELSE approved END WHERE account='openai-api' AND cycle=?",
        )
        .run(actual, actual, r.reserved, r.cycle);
    });
  }
  claim(
    key: string,
    route: RuntimeRoute,
    config: Config,
    sessionKey: string,
    agentId?: string,
  ): Attempt {
    return this.transaction(() => {
      if (this.stopped()) throw Error("Dispatch stopped");
      const row = this.task(key);
      if (!row || !["READY", "REWORK"].includes(row.state)) throw Error("Task not dispatchable");
      if (row.config_hash !== hash(config)) throw Error("Configuration fingerprint changed");
      const c: Contract = JSON.parse(row.contract_json);
      if (this.active().some((a) => a.task_key === key)) throw Error("Task already active");
      const active = this.active();
      const owned = active.filter(
        (attempt) =>
          this.routeOwner(JSON.parse(this.task(attempt.task_key)!.contract_json)) ===
          this.routeOwner(c),
      );
      if (
        new Set(owned.map((a) => a.task_key.split("/")[0])).size >= config.maxWorkflows &&
        !owned.some((a) => a.task_key.startsWith(`${c.workflowId}/`))
      )
        throw Error("Workflow concurrency limit for main");
      if (this.routeOccupied(route, undefined, c)) throw Error("Route slot limit");
      if (this.circuitOpen(route.access, Date.now())) throw Error("Account circuit open");
      if (this.circuitOpen(`route:${route.id}`, Date.now())) throw Error("Route circuit open");
      const blocked = this.coordinationBlock(c);
      if (blocked) throw Error(`Worktree coordination blocked: ${blocked}`);
      const resource = c.workspace ? `scope:${hash({ worktree: c.worktree, key })}` : c.worktree;
      const lease = this.db.prepare("SELECT * FROM leases WHERE worktree=?").get(resource) as
        | { fence: number; state: string }
        | undefined;
      if (lease && lease.state !== "RELEASED") throw Error("Worktree lease held or suspect");
      const fence = (lease?.fence ?? 0) + 1;
      const sequence = (this.latest(key)?.sequence ?? 0) + 1;
      const id = `${key}/${sequence}`;
      this.db
        .prepare(
          "INSERT INTO attempts(id,task_key,sequence,status,route_json,agent_id,fence,session_key,created_ms,reused) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          key,
          sequence,
          "INTENT",
          JSON.stringify(route),
          agentId ?? null,
          fence,
          sessionKey,
          Date.now(),
          Number(!!agentId),
        );
      if (route.access === "openai-api" && route.bucket)
        this.reserveBudget(
          id,
          route.bucket,
          this.apiReservation(c, route, config),
          config,
          Date.now(),
        );
      this.db
        .prepare(
          "INSERT INTO leases VALUES(?,?,?,?,?) ON CONFLICT(worktree) DO UPDATE SET attempt_id=excluded.attempt_id,fence=excluded.fence,state=excluded.state,heartbeat_ms=excluded.heartbeat_ms",
        )
        .run(resource, id, fence, "HELD", Date.now());
      this.db.prepare("INSERT INTO outbox VALUES(?,?)").run(id, "PENDING");
      this.db.prepare("UPDATE tasks SET state='ACTIVE' WHERE key=?").run(key);
      this.event("SPAWN_INTENT", id);
      return this.attempt(id);
    });
  }
  beginSend(id: string): boolean {
    return this.transaction(() => {
      if (this.stopped()) return false;
      const a = this.attempt(id);
      if (a.status !== "INTENT") return false;
      const lease = this.db
        .prepare("SELECT 1 FROM leases WHERE attempt_id=? AND fence=? AND state='HELD'")
        .get(id, a.fence);
      if (!lease) throw Error("Stale fencing token");
      const result = this.db
        .prepare("UPDATE outbox SET state='SENDING' WHERE attempt_id=? AND state='PENDING'")
        .run(id);
      if (result.changes !== 1) return false;
      this.db
        .prepare("UPDATE attempts SET status='SENDING' WHERE id=? AND status='INTENT'")
        .run(id);
      this.event("SEND_BEGIN", id);
      return true;
    });
  }
  bind(id: string, agentId: string): void {
    this.transaction(() => {
      const a = this.attempt(id);
      if (!liveStates.includes(a.status) || (a.agent_id && a.agent_id !== agentId))
        throw Error("Invalid agent binding");
      this.db.prepare("UPDATE attempts SET agent_id=? WHERE id=?").run(agentId, id);
      this.db.prepare("UPDATE outbox SET state='BOUND' WHERE attempt_id=?").run(id);
      this.event("AGENT_BOUND", id);
    });
  }
  observe(
    id: string,
    status: AttemptState,
    context: number | null = null,
    usage: unknown = null,
  ): void {
    this.transaction(() => {
      const a = this.attempt(id);
      if (
        !liveStates.includes(a.status) &&
        !(a.status === "VERIFY" && status === "NEEDS_CONFIRMATION")
      )
        throw Error("Attempt already terminal");
      const held = this.db
        .prepare("SELECT 1 FROM leases WHERE attempt_id=? AND fence=? AND state!='RELEASED'")
        .get(id, a.fence);
      if (!held) throw Error("Stale fencing token");
      this.db.prepare("UPDATE attempts SET status=? WHERE id=?").run(status, id);
      this.db.prepare("UPDATE tasks SET state=? WHERE key=?").run(status, a.task_key);
      if (a.agent_id)
        this.db
          .prepare(
            "INSERT INTO sessions VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET agent_id=excluded.agent_id,status=excluded.status,context_fraction=excluded.context_fraction,reconciled_ms=excluded.reconciled_ms,usage_json=excluded.usage_json",
          )
          .run(
            a.session_key,
            a.agent_id,
            status === "VERIFY" ? "idle" : status,
            context,
            Date.now(),
            JSON.stringify(usage),
          );
      // VERIFY keeps the lease through tests and exact-diff review; an idle agent is not acceptance.
      this.db
        .prepare("UPDATE leases SET state=?,heartbeat_ms=? WHERE attempt_id=? AND fence=?")
        .run(
          ["UNKNOWN", "NEEDS_CONFIRMATION"].includes(status) ? "SUSPECT" : "HELD",
          Date.now(),
          id,
          a.fence,
        );
      this.event(status, id);
    });
  }
  claimContinuation(id: string, traceHash: string, authorize: () => string): void {
    this.transaction(() => {
      const humanCheckpoint = authorize();
      const a = this.attempt(id),
        c: Contract = JSON.parse(this.task(a.task_key)!.contract_json);
      if (this.stopped() || a.status !== "NEEDS_CONFIRMATION" || this.latest(a.task_key)?.id !== id)
        throw Error("CONTINUATION_STATE_CHANGED");
      if (this.db.prepare("SELECT 1 FROM check_locks WHERE worktree=?").get(c.worktree))
        throw Error("CONTINUATION_CHECKS_ACTIVE");
      if (
        !this.db
          .prepare("SELECT 1 FROM leases WHERE attempt_id=? AND fence=? AND state!='RELEASED'")
          .get(id, a.fence)
      )
        throw Error("CONTINUATION_LEASE_LOST");
      const blocked = this.coordinationBlock(c);
      if (blocked) throw Error(`CONTINUATION_COORDINATION_BLOCKED:${blocked}`);
      if (this.routeOccupied(JSON.parse(a.route_json), undefined, c))
        throw Error("CONTINUATION_ROUTE_SLOT_LIMIT");
      const intent = `CONTINUATION_INTENT:${traceHash}`;
      if (this.db.prepare("SELECT 1 FROM events WHERE attempt_id=? AND kind=?").get(id, intent))
        throw Error("CONTINUATION_ALREADY_ATTEMPTED");
      const checkpointEvent = `CONTINUATION_CHECKPOINT:${humanCheckpoint}`;
      const continued = this.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE attempt_id=? AND kind=?")
        .get(id, checkpointEvent) as { n: number };
      if (continued.n >= 2) throw Error("CONTINUATION_REPEATED_BLOCKER_REQUIRES_DIAGNOSIS");
      this.event(checkpointEvent, id);
      this.event(intent, id);
      this.event("CONTINUATION_BEGIN", id);
      this.db.prepare("UPDATE attempts SET status='RUNNING' WHERE id=?").run(id);
      this.db.prepare("UPDATE tasks SET state='RUNNING' WHERE key=?").run(a.task_key);
      this.db.prepare("UPDATE sessions SET status='RUNNING' WHERE agent_id=?").run(a.agent_id);
      this.db
        .prepare("UPDATE leases SET state='HELD',heartbeat_ms=? WHERE attempt_id=? AND fence=?")
        .run(Date.now(), id, a.fence);
    });
  }
  failConfirmed(id: string, reason: string, until: number | null, retryable: boolean): void {
    this.transaction(() => {
      const a = this.attempt(id);
      if (!liveStates.includes(a.status)) throw Error("Attempt already terminal");
      const c: Contract = JSON.parse(this.task(a.task_key)!.contract_json);
      if (this.db.prepare("SELECT 1 FROM check_locks WHERE worktree=?").get(c.worktree))
        throw Error("Check processes still owned or unknown");
      const r: RuntimeRoute = JSON.parse(a.route_json);
      if (reason !== "task-budget")
        this.blockAccess(reason === "flex-unavailable" ? `route:${r.id}` : r.access, reason, until);
      this.db
        .prepare("UPDATE attempts SET status='FAILED',error_kind=? WHERE id=?")
        .run(reason, id);
      this.db
        .prepare("UPDATE leases SET state='RELEASED' WHERE attempt_id=? AND fence=?")
        .run(id, a.fence);
      this.db
        .prepare("UPDATE tasks SET state=? WHERE key=?")
        .run(retryable && a.sequence < 6 ? "READY" : "BLOCKED", a.task_key);
      this.db.prepare("UPDATE sessions SET status='ended' WHERE agent_id=?").run(a.agent_id);
      this.event("CONFIRMED_PROVIDER_FAILURE", id);
    });
  }
  finish(
    id: string,
    ok: boolean,
    diffHash: string,
    evidence: unknown,
    maxRework: number,
    release = true,
  ): void {
    this.transaction(() => {
      const a = this.attempt(id);
      if (a.status !== "VERIFY") throw Error("Verification requires confirmed finished agent");
      const task = this.task(a.task_key)!;
      const contract: Contract = JSON.parse(task.contract_json);
      if (this.db.prepare("SELECT 1 FROM check_locks WHERE worktree=?").get(contract.worktree))
        throw Error("Verification processes still owned or unknown");
      if (!ok && contract.workspace && contract.mutation) {
        const peers = this.db
          .prepare(`SELECT t.*,a.id AS attempt_id,a.fence FROM tasks t JOIN attempts a ON a.task_key=t.key
          WHERE a.status='VERIFY'`)
          .all() as unknown as (TaskRow & { attempt_id: string; fence: number })[];
        const cohort = peers.filter((peer) => sameCohort(contract, JSON.parse(peer.contract_json)));
        const round = Math.max(...cohort.map((peer) => peer.rework)) + 1;
        for (const peer of cohort) {
          // One failed combined revision is one repair round for every member,
          // rather than serially charging healthy peers for the same failure.
          this.db.prepare("INSERT INTO reviews VALUES(?,?,?)").run(
            peer.attempt_id,
            diffHash,
            JSON.stringify({
              ...(evidence as object),
              cohortFailure: { sourceAttemptId: id, round },
            }),
          );
          this.db
            .prepare("UPDATE attempts SET status='FAILED',result_hash=? WHERE id=?")
            .run(diffHash, peer.attempt_id);
          this.db
            .prepare("UPDATE tasks SET state=?,rework=? WHERE key=?")
            .run(round > maxRework ? "BLOCKED" : "REWORK", round, peer.key);
          this.db
            .prepare("UPDATE leases SET state=? WHERE attempt_id=? AND fence=?")
            .run(release ? "RELEASED" : "ISOLATED", peer.attempt_id, peer.fence);
          this.event("COHORT_VERIFICATION_FAILED", peer.attempt_id);
        }
        return;
      }
      this.db
        .prepare("INSERT INTO reviews VALUES(?,?,?)")
        .run(id, diffHash, JSON.stringify(evidence));
      this.db
        .prepare("UPDATE attempts SET status=?,result_hash=? WHERE id=?")
        .run(ok ? "COMPLETE" : "FAILED", diffHash, id);
      this.db
        .prepare("UPDATE tasks SET state=?,rework=rework+? WHERE key=?")
        .run(
          ok ? "COMPLETE" : task.rework >= maxRework ? "BLOCKED" : "REWORK",
          Number(!ok),
          a.task_key,
        );
      this.db
        .prepare("UPDATE leases SET state=? WHERE attempt_id=? AND fence=?")
        .run(release ? "RELEASED" : "ISOLATED", id, a.fence);
      this.event(ok ? "COMPLETE" : "VERIFICATION_FAILED", id);
    });
  }
}
