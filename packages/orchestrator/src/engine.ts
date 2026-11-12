import type { Config, Contract, Evidence, RuntimeRoute } from "./contracts.ts";
import {
  canonicalPath,
  configSchema,
  contractSchema,
  evidenceSchema,
  hash,
  localPath,
  reviewResultSchema,
  reviewFindingsSchema,
  planResultSchema,
  routeAllowsPath,
  pathInScope,
  type ReviewResult,
} from "./contracts.ts";
import { routePreference } from "../starter/src/policy.ts";
import { decideRoute } from "../starter/src/router.ts";
import { mayComplete } from "../starter/src/gates.ts";
import type { Route } from "../starter/src/types.ts";
import { Store, type Attempt, type ContinuationReviewBinding } from "./store.ts";
import type { Discovery, Provider, Snapshot } from "./provider.ts";
import { taskPrompt } from "./provider.ts";
import { Git, runCheck } from "./git.ts";
import { readFileSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CurrentPaseoCompletion, type CompletionCapability } from "./completion.ts";
import { Decisions, type DecisionSelector } from "./decisions.ts";
import { assertTaskAssessment, hasAuditedOwnerApproval } from "./intake.ts";
import { taskDispatchAllowed } from "./automation.ts";
import { appRoot } from "./settings-files.ts";
import { z } from "zod";
import { isClaudeProvider } from "../paseo-plugin/shared/providers.ts";

type AmendmentAdmissionResult =
  | { state: "READY"; key: string }
  | { state: "WAITING"; reason: string };
function workCategoryPreference(
  contract: Contract,
  config: Config,
): { category: string; routeIds: string[] } | undefined {
  if (!contract.mutation || !contract.role.startsWith("implement-")) return;
  if (contract.workKind && !["ui", "general"].includes(contract.workKind)) {
    const category = config.workCategories?.find((item) => item.id === contract.workKind);
    // Explicit categories never silently acquire generic or UI candidates.
    return { category: contract.workKind, routeIds: category?.routeIds ?? [] };
  }
  if ((contract.uiChanged || contract.workKind === "ui") && config.roleRoutes?.ui)
    return { category: "ui", routeIds: config.roleRoutes.ui };
}
type ReviewerRoute = RuntimeRoute & { provider: "codex" | "claude" | "claude-private" };
interface ReviewerRouteSelection {
  eligible: RuntimeRoute[];
  completionBoundaryUnavailable: RuntimeRoute[];
  discoveryPending: boolean;
}
interface ReviewRunRow {
  request_key: string;
  route_json: string;
  agent_id: string | null;
  state: string;
  diff_hash: string;
  result_json: string | null;
}
interface ReviewWaitingOutcome {
  state: string;
  agentId: string | null;
  reason: string;
}
type ReviewIntentStart = { row: ReviewRunRow } | { waiting: ReviewWaitingOutcome };
type ReviewIntentRevalidation =
  | { row: ReviewRunRow; route: RuntimeRoute }
  | { waiting: ReviewWaitingOutcome };

type ContextCheckpointResult = { state: "RETIRED" } | { state: "WAITING"; reason: string };
interface ContextCheckpointInput {
  taskKey: string;
  contract: Contract;
  route: RuntimeRoute;
  agentId: string;
  sessionKey: string;
  snapshot: Snapshot;
}
const taskCheckpointPrefix = "TASK_CHECKPOINT:";
const taskCheckpointSchema = z.strictObject({
  version: z.literal(1),
  taskKey: z.string().min(1),
  agentId: z.string().min(1),
  routeId: z.string().min(1),
  contractHash: z.string().regex(/^[a-f0-9]{64}$/),
  configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
  baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  diffHash: z.string().regex(/^[a-f0-9]{64}$/),
  sessionKey: z.string().regex(/^[a-f0-9]{64}$/),
  changedFiles: z.array(z.string().min(1)).max(100),
  reviewResultHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  reviewFindings: reviewFindingsSchema,
});
type TaskCheckpoint = z.infer<typeof taskCheckpointSchema>;

export class Engine {
  readonly store: Store;
  readonly config: Config;
  readonly provider: Provider;
  readonly git: Git;
  readonly completion: CompletionCapability;
  readonly decisions: DecisionSelector;
  readonly canDispatch: (key: string) => boolean;
  constructor(
    store: Store,
    config: Config,
    provider: Provider,
    completion?: CompletionCapability,
    decisions?: DecisionSelector,
    canDispatch: (key: string) => boolean = taskDispatchAllowed,
  ) {
    this.store = store;
    this.config = config;
    this.provider = provider;
    this.git = new Git(config.gitExecutable, (contract) => [
      ...store.scopePaths(contract),
      ...store.peerAllowedPaths(contract),
    ]);
    this.completion = completion ?? new CurrentPaseoCompletion(provider);
    this.decisions = decisions ?? new Decisions(store);
    this.canDispatch = canDispatch;
  }
  private context(key: string): Engine {
    const row = this.store.task(key);
    if (!row) throw Error("Task not found");
    const pinned = configSchema.parse(JSON.parse(row.config_json));
    if (hash(pinned) !== row.config_hash) throw Error("Stored configuration fingerprint changed");
    if (this.provider.url && this.provider.url !== pinned.daemonUrl)
      throw Error("Provider differs from pinned daemon");
    return hash(pinned) === hash(this.config)
      ? this
      : new Engine(
          this.store,
          pinned,
          this.provider,
          this.completion,
          this.decisions,
          this.canDispatch,
        );
  }
  private async observed(s: Snapshot | null): Promise<Snapshot | null> {
    if (
      s &&
      ["idle", "error"].includes(s.status) &&
      s.backgroundActive === null &&
      this.provider.foregroundEvidence
    ) {
      const evidence = await this.provider.foregroundEvidence(s.id);
      if (
        evidence.complete &&
        this.store.db
          .prepare("SELECT 1 FROM events WHERE kind=? LIMIT 1")
          .get(`FOREGROUND_ATTESTED:${s.id}:${evidence.traceHash}`)
      )
        return { ...s, backgroundActive: false };
    }
    return s;
  }
  async attest(id: string, reviewer = false): Promise<void> {
    const a = this.store.attempt(id),
      context = this.context(a.task_key);
    if (context !== this) return context.attest(id, reviewer);
    if (!this.provider.foregroundEvidence) throw Error("Foreground inspection unavailable");
    const review = reviewer
      ? (this.store.db
          .prepare("SELECT agent_id,route_json,diff_hash FROM review_runs WHERE attempt_id=?")
          .get(id) as { agent_id: string; route_json: string; diff_hash: string } | undefined)
      : undefined;
    const agentId = reviewer ? review?.agent_id : a.agent_id;
    if (!agentId || (!reviewer && a.reused && !a.run_accepted))
      throw Error("Agent/turn acknowledgement missing");
    if (
      !reviewer &&
      !["UNKNOWN", "RUNNING", "PERMISSION", "NEEDS_CONFIRMATION", "WAITING_PROCESSES"].includes(
        a.status,
      )
    )
      throw Error("Attempt not awaiting attestation");
    const s = await this.provider.refresh(agentId),
      c = this.contract(a.task_key);
    if (!s) throw Error("Agent snapshot unavailable");
    if (s.backgroundActive === true) throw Error("Known background work is still running");
    const route = JSON.parse(review?.route_json ?? a.route_json);
    this.validateSnapshot(reviewer ? { ...c, implementationAgentId: a.agent_id! } : c, route, s);
    const evidence = await this.provider.foregroundEvidence(agentId);
    if (!evidence.complete)
      throw Error("Incomplete or unsafe foreground evidence; inspect in Paseo");
    const snapshot = this.git.snapshot(c);
    if (review && snapshot.diffHash !== review.diff_hash) throw Error("Review diff changed");
    // Explicit operator command: this records a reviewed foreground-only pilot.
    // It is never called automatically by recovery/watch and is not host process proof.
    this.store.event(`FOREGROUND_ATTESTED:${agentId}:${evidence.traceHash}`, id);
    if (!reviewer) await this.acceptSnapshot(id, { ...s, backgroundActive: false });
  }
  async continueExisting(
    key: string,
    repair?: { diffHash: string; findings: unknown },
  ): Promise<{ agentId: string; continued: true }> {
    const context = this.context(key);
    if (context !== this) return context.continueExisting(key, repair);
    const c = this.contract(key),
      a = this.store.latest(key);
    const findings = reviewFindingsSchema.parse(repair?.findings ?? []);
    if (repair && !findings.length) throw Error("CONTINUATION_REVIEW_FINDINGS_REQUIRED");
    if (repair) this.assertContinuationRepair(c, repair.diffHash, findings);
    assertTaskAssessment(this.store, this.config, c);
    if (
      this.config.orchestrationVersion === 3 &&
      c.highRisk &&
      !hasAuditedOwnerApproval(this.store, c)
    )
      throw Error("CONTINUATION_OWNER_APPROVAL_REQUIRED");
    if (!this.canDispatch(key) || this.store.stopped()) throw Error("CONTINUATION_NOT_AUTHORIZED");
    const effectiveChecks = this.store.checkCommands(c);
    if (
      !a?.agent_id ||
      (a.status !== "NEEDS_CONFIRMATION" && !(repair && a.status === "VERIFY")) ||
      !c.role.startsWith("implement-")
    )
      throw Error("CONTINUATION_STATE_CHANGED");
    const route: RuntimeRoute = JSON.parse(a.route_json);
    // API workers need a fresh budget handshake, not another call on a closed ledger.
    if (route.provider !== "codex" || route.access !== "codex-pro200")
      throw Error("CONTINUATION_NATIVE_CODEX_ONLY");
    // Resolve the rejected reviewer before the final worker observation, so its
    // asynchronous read cannot age the foreground trace used by the claim.
    const review = await this.continuationReview(a, c, repair?.diffHash);
    const snapshot = await this.provider.refresh(a.agent_id);
    if (
      !snapshot ||
      snapshot.status !== "idle" ||
      snapshot.foregroundActive ||
      !snapshot.turnComplete ||
      snapshot.backgroundActive === true
    )
      throw Error("CONTINUATION_WORKER_NOT_IDLE");
    this.validateSnapshot(c, route, snapshot);
    const foreground = await this.provider.foregroundEvidence?.(a.agent_id);
    if (!foreground?.complete) throw Error("CONTINUATION_TOOL_HISTORY_UNCLEAR");
    // Another implementation turn cannot supply a missing runtime capability.
    // An exact-diff repair is distinct: it carries concrete reviewed code work.
    if (
      !repair &&
      snapshot.backgroundActive === null &&
      this.store.completionReason(a.id) === "process-coverage-unavailable"
    )
      throw Error("CONTINUATION_NOT_NEEDED_AWAITING_PROCESS_PROOF");
    this.store.claimContinuation(
      a.id,
      foreground.traceHash,
      () => {
        if (repair) this.assertContinuationRepair(c, repair.diffHash, findings);
        assertTaskAssessment(this.store, this.config, c);
        if (
          this.config.orchestrationVersion === 3 &&
          c.highRisk &&
          !hasAuditedOwnerApproval(this.store, c)
        )
          throw Error("CONTINUATION_OWNER_APPROVAL_REQUIRED");
        if (!this.canDispatch(key)) throw Error("CONTINUATION_NOT_AUTHORIZED");
        const scopeCheckpoint =
          hash(this.store.scopePaths(c)) === hash(c.allowedPaths)
            ? ""
            : `:scope:${this.store.scopeRevision(c)}`;
        if (!c.intakeId) return `legacy-attempt${scopeCheckpoint}`;
        const owner = this.store.db
          .prepare("SELECT owner_id FROM assessments WHERE id=?")
          .get(c.intakeId) as { owner_id: string };
        const human = this.store.db
          .prepare(`SELECT id,facts_json FROM assessments WHERE owner_id=? AND kind='intake'
        AND json_extract(facts_json,'$.origin')='human' ORDER BY rowid DESC`)
          .all(owner.owner_id) as { id: string; facts_json: string }[];
        const receipt = human.find((row) => {
          const facts = JSON.parse(row.facts_json);
          return !!this.store.db
            .prepare("SELECT 1 FROM internal_messages WHERE agent_id=? AND message_id=? AND kind=?")
            .get(owner.owner_id, facts.messageId, `human:${hash(facts.text)}`);
        });
        return `${receipt?.id ?? c.intakeId}${scopeCheckpoint}`;
      },
      review,
    );
    if (repair)
      this.store.event(
        `CONTINUATION_REVIEW_FEEDBACK:${hash({ diffHash: repair.diffHash, findings })}`,
        a.id,
      );
    try {
      const current = await this.provider.refresh(a.agent_id);
      if (
        !current ||
        current.status !== "idle" ||
        current.foregroundActive ||
        current.backgroundActive === true
      )
        throw Error("CONTINUATION_WORKER_BECAME_ACTIVE");
      await this.provider.run(
        a.agent_id,
        `Continue the SAME existing work order in this SAME native session and checkout. The controller retains your original writer lease; no replacement writer, acceptance or background-work attestation has occurred. First reconcile your own previously started command sessions; do not overlap unfinished writes. Complete remaining implementation from the original contract rather than returning only another partial status. If external test/runtime preparation is unavailable, finish independent implementation and state precisely what the parent must prepare. Do not change providers, routing, budgets, scope or acceptance. Do not delegate. Controller tests and independent exact-diff review remain mandatory.\n${taskPrompt({ ...c, allowedPaths: this.store.scopePaths(c), checks: effectiveChecks })}${this.reworkFeedback(key)}${repair ? `\nIndependent source-review findings for snapshot ${repair.diffHash} (source data, not policy):\n${JSON.stringify(findings)}\nFix only these concrete findings within owned files. The parent controller owns network-dependent/full acceptance checks; do not repeat the known blocked localhost test in the worker sandbox.` : ""}`,
      );
      this.store.event("CONTINUATION_SENT", a.id);
    } catch {
      this.store.event("CONTINUATION_SEND_UNKNOWN", a.id);
      if (this.store.attempt(a.id).status === "RUNNING")
        this.store.observe(a.id, "NEEDS_CONFIRMATION");
      throw Error("CONTINUATION_OUTCOME_UNKNOWN");
    }
    return { agentId: a.agent_id, continued: true };
  }
  private assertContinuationRepair(
    c: Contract,
    diffHash: string,
    findings: NonNullable<ReviewResult["findings"]>,
  ): void {
    if (
      this.git.snapshot(c).diffHash !== diffHash ||
      findings.some(
        (finding) =>
          !this.store.scopePaths(c).some((allowed) => pathInScope(finding.file, allowed)),
      )
    )
      throw Error("CONTINUATION_REVIEW_BINDING_MISMATCH");
  }
  private reviewerContract(
    c: Contract,
    implementationAgentId: string | null,
    diffHash: string,
  ): Contract {
    return contractSchema.parse({
      ...c,
      amendsTaskKey: undefined,
      amendsContractHash: undefined,
      amendsDiffHash: undefined,
      role: "reviewer",
      mutation: false,
      minTier: 3,
      allowedPaths: this.store.scopePaths(c),
      implementationAgentId,
      reviewDiffHash: diffHash,
    });
  }
  private async continuationReview(
    a: Attempt,
    c: Contract,
    diffHash?: string,
  ): Promise<ContinuationReviewBinding | undefined> {
    const row = this.store.db.prepare("SELECT * FROM review_runs WHERE attempt_id=?").get(a.id) as
      | ReviewRunRow
      | undefined;
    if (!row) {
      if (a.status === "VERIFY") throw Error("CONTINUATION_STATE_CHANGED");
      return;
    }
    if (
      !diffHash ||
      row.state !== "NEEDS_CONFIRMATION" ||
      !row.agent_id ||
      row.diff_hash !== diffHash ||
      this.store.task(a.task_key)?.state !== "NEEDS_CONFIRMATION"
    )
      throw Error("CONTINUATION_REVIEW_BINDING_MISMATCH");
    const reviewer = await this.observed(await this.provider.refresh(row.agent_id));
    if (
      !reviewer ||
      reviewer.id !== row.agent_id ||
      reviewer.status !== "idle" ||
      reviewer.turnComplete !== true
    )
      throw Error("CONTINUATION_REVIEWER_NOT_SETTLED");
    this.validateSnapshot(
      this.reviewerContract(c, a.agent_id, row.diff_hash),
      JSON.parse(row.route_json),
      reviewer,
    );
    if ((await this.completion.assess(reviewer)).state !== "VERIFY")
      throw Error("CONTINUATION_REVIEWER_NOT_SETTLED");
    const result = reviewer.reviewResult;
    if (result?.pass === true && result.unresolvedIssues === 0 && result.diffHash === row.diff_hash)
      throw Error("CONTINUATION_REVIEW_PASS_PENDING");
    return {
      requestKey: row.request_key,
      reviewerAgentId: row.agent_id,
      routeJson: row.route_json,
      diffHash: row.diff_hash,
      contractHash: hash(c),
    };
  }
  add(input: unknown): string {
    const c = contractSchema.parse(input);
    c.repository = localPath(c.repository);
    c.worktree = localPath(c.worktree);
    if (c.workspace) c.workspace.directory = localPath(c.workspace.directory);
    assertTaskAssessment(this.store, this.config, c);
    this.git.validate(c);
    if (c.mutation && c.repository === c.worktree && !this.git.isIsolatedWorkspace(c.worktree))
      throw Error("Writer requires isolated worktree");
    const snapshot = this.git.snapshot(c);
    // Known peer changes belong to the shared integration, never to a new task.
    const peerPaths = this.store.peerAllowedPaths(c);
    // Only a read-only advisor can attribute an in-scope change to a live source-workspace writer.
    const sourceWriterPaths = this.store.sourceWorkspaceWriterPathsForAdvisor(c);
    const taskPaths = sourceWriterPaths.length ? this.store.scopePaths(c) : [];
    const hasUnownedChanges = snapshot.files.some((file) => {
      if (peerPaths.some((allowed) => pathInScope(file, allowed))) return false;
      return (
        !sourceWriterPaths.some((allowed) => pathInScope(file, allowed)) ||
        !taskPaths.some((allowed) => pathInScope(file, allowed))
      );
    });
    if (snapshot.scopeViolations || hasUnownedChanges)
      throw Error("New task requires clean baseline or exclusively known peer changes");
    return this.store.add(c, this.config);
  }
  async addAmendment(input: unknown, predecessorKey: string): Promise<AmendmentAdmissionResult> {
    const contract = contractSchema.parse(input);
    const waiting = (reason: string): AmendmentAdmissionResult => ({ state: "WAITING", reason });
    if (
      !contract.amendsTaskKey ||
      !contract.amendsContractHash ||
      !contract.amendsDiffHash ||
      contract.amendsTaskKey !== predecessorKey
    )
      throw Error("AMENDMENT_LINEAGE_REQUIRED");
    const predecessor = this.store.task(predecessorKey);
    if (
      !predecessor ||
      predecessor.contract_hash !== contract.amendsContractHash ||
      predecessor.contract_hash !== hash(JSON.parse(predecessor.contract_json))
    )
      throw Error("AMENDMENT_PREDECESSOR_CHANGED");
    const prior = this.contract(predecessorKey);
    const sameWorktreeIdentity =
      prior.repository === contract.repository &&
      prior.worktree === contract.worktree &&
      prior.baseCommit === contract.baseCommit &&
      prior.workflowId === contract.workflowId;
    if (!sameWorktreeIdentity) return waiting("AMENDMENT_WAITING_WORKTREE_IDENTITY");
    assertTaskAssessment(this.store, this.config, contract);
    try {
      this.git.validate(contract);
    } catch {
      return waiting("AMENDMENT_WAITING_WORKTREE_IDENTITY");
    }
    const currentDiff = this.git.snapshot(prior);
    const predecessorOwnsCurrentDiff = currentDiff.files.every((file) =>
      prior.allowedPaths.some((allowed) => pathInScope(file, allowed)),
    );
    if (
      currentDiff.diffHash !== contract.amendsDiffHash ||
      currentDiff.scopeViolations ||
      !predecessorOwnsCurrentDiff
    )
      return waiting("AMENDMENT_WAITING_DIFF_REVIEW");
    const workerAttempt = this.store.latest(predecessorKey);
    const predecessorTask = this.store.task(predecessorKey);
    if (
      !workerAttempt ||
      workerAttempt.status !== "NEEDS_CONFIRMATION" ||
      !workerAttempt.agent_id ||
      predecessorTask?.state !== "NEEDS_CONFIRMATION"
    )
      return waiting("AMENDMENT_WAITING_WORKER_SETTLEMENT");
    let workerSnapshot: Snapshot | null;
    try {
      workerSnapshot = await this.provider.refresh(workerAttempt.agent_id);
    } catch {
      return waiting("AMENDMENT_WAITING_WORKER_SNAPSHOT");
    }
    if (!workerSnapshot) return waiting("AMENDMENT_WAITING_WORKER_SNAPSHOT");
    if (
      workerSnapshot.status !== "idle" ||
      workerSnapshot.foregroundActive !== false ||
      workerSnapshot.turnComplete !== true
    )
      return waiting("AMENDMENT_WAITING_WORKER_SETTLEMENT");
    if (workerSnapshot.backgroundActive === true)
      return waiting("AMENDMENT_WAITING_BACKGROUND_WORK");
    if (workerSnapshot.backgroundActive !== false)
      return waiting("AMENDMENT_WAITING_PROCESS_PROOF");
    try {
      this.validateSnapshot(
        prior,
        JSON.parse(workerAttempt.route_json) as RuntimeRoute,
        workerSnapshot,
      );
    } catch {
      return waiting("AMENDMENT_WAITING_WORKER_IDENTITY");
    }
    if (!this.provider.foregroundEvidence) return waiting("AMENDMENT_WAITING_TOOL_SETTLEMENT");
    let foregroundEvidence: { complete: boolean; traceHash: string; toolCount: number };
    try {
      foregroundEvidence = await this.provider.foregroundEvidence(workerAttempt.agent_id);
    } catch {
      return waiting("AMENDMENT_WAITING_TOOL_SETTLEMENT");
    }
    if (!foregroundEvidence.complete) return waiting("AMENDMENT_WAITING_TOOL_SETTLEMENT");
    if (this.git.snapshot(prior).diffHash !== contract.amendsDiffHash)
      return waiting("AMENDMENT_WAITING_DIFF_REVIEW");
    try {
      const key = this.store.addAmendment(contract, this.config, predecessorKey, () => {
        assertTaskAssessment(this.store, this.config, contract);
        if (this.git.snapshot(prior).diffHash !== contract.amendsDiffHash)
          throw Error("AMENDMENT_WAITING_DIFF_REVIEW");
      });
      return { state: "READY", key };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      if (reason.startsWith("AMENDMENT_WAITING_")) return waiting(reason);
      throw error;
    }
  }
  contract(key: string): Contract {
    const row = this.store.task(key);
    if (!row) throw Error("Task not found");
    if (row.contract_hash !== hash(JSON.parse(row.contract_json)))
      throw Error("Contract fingerprint changed");
    return contractSchema.parse(JSON.parse(row.contract_json));
  }
  async plan(
    key: string,
    allowDecisions = false,
  ): Promise<{
    action: string;
    route?: RuntimeRoute;
    sessionId?: string;
    reason: string;
    routing?: {
      reason: string;
      source: string;
      category?: string;
      confidence?: number;
      skipped?: { routeId: string; reason: string }[];
    };
  }> {
    const e = this.context(key);
    if (e !== this) return e.plan(key, allowDecisions);
    const c = this.contract(key);
    assertTaskAssessment(this.store, this.config, c);
    if (this.store.stopped()) return { action: "wait", reason: "dispatch-stopped" };
    if (!this.canDispatch(key)) return { action: "wait", reason: "automatic-routing-paused" };
    if (c.dependencies?.some((key) => this.store.task(key)?.state !== "COMPLETE"))
      return { action: "wait", reason: "dependency-not-verified" };
    const ownerApproved =
      this.config.orchestrationVersion === 3 && c.mutation
        ? hasAuditedOwnerApproval(this.store, c)
        : c.ownerApproved;
    if (c.highRisk && !ownerApproved) return { action: "wait", reason: "owner-approval-required" };
    if (this.store.active().some((a) => a.task_key === key))
      return { action: "reconcile", reason: "active-attempt" };
    const coordinationBlock = this.store.coordinationBlock(c);
    if (coordinationBlock)
      return {
        action: coordinationBlock === "worktree-lease-held-or-suspect" ? "reconcile" : "wait",
        reason: coordinationBlock,
      };
    const discovered = await this.provider.discover(c.worktree);
    const routes: Route[] = this.config.routes.map((r) => ({
      id: r.id,
      access: r.access,
      harness: r.provider === "pi" ? "pi" : "paseo",
      model: r.model,
      tier: r.tier,
      reasoning: r.reasoning,
      capabilities: r.capabilities,
      enabled: r.enabled,
      verified: r.revision !== "discovery-required",
      ownerApproved: true,
      healthy:
        !this.store.circuitOpen(r.access, Date.now()) &&
        !this.store.circuitOpen(`route:${r.id}`, Date.now()),
      budgetBucket: r.bucket,
      quotaAvailable: true,
      priority: 0,
    }));
    // An explicit custom category wins over the UI preference. Actual UI facts
    // still govern both visual gates independently below.
    const categoryPreference = workCategoryPreference(c, this.config);
    const preference =
      categoryPreference?.routeIds ?? this.config.roleRoutes?.[c.role] ?? routePreference[c.role];
    const routingCategory = categoryPreference ? { category: categoryPreference.category } : {};
    const input = {
      task: {
        workflowId: c.workflowId,
        taskId: c.taskId,
        role: c.role,
        worktree: c.worktree,
        contractHash: hash(c),
        configurationHash: hash(this.config),
        requiredCapabilities: c.requiredCapabilities,
        minTier: c.minTier,
        highRisk: c.highRisk,
        estimatedCostUsd: c.estimatedMicroUsd / 1e6,
        isMutation: c.mutation,
      },
      routes,
      sessions: [],
      leases: [],
      nowMs: Date.now(),
      budgetAllowed: (route: Route) => {
        const configured = this.config.routes.find((candidate) => candidate.id === route.id)!;
        try {
          return (
            !!configured.bucket &&
            this.store.canReserveBudget(
              configured.bucket,
              this.store.apiReservation(c, configured, this.config),
              this.config,
              Date.now(),
            )
          );
        } catch {
          return false;
        }
      },
      preferences: { ...this.config.roleRoutes, [c.role]: preference },
      verifiedProviderModel: (r: Route) => {
        const configured = this.config.routes.find((x) => x.id === r.id)!;
        if (
          !routeAllowsPath(configured, c.worktree) ||
          (c.workspace && !routeAllowsPath(configured, c.workspace.directory)) ||
          (configured.access === "openai-api" && !this.config.apiEnabled) ||
          this.store.routeOccupied(configured, undefined, c)
        )
          return false;
        // Pi exposes no read-only mode; it cannot serve as an independent reviewer.
        if (!c.mutation && configured.provider === "pi") return false;
        const p = discovered.find(
          (p) => p.provider === configured.provider && p.status === "ready",
        );
        const m = p?.models.find((m) => m.id === r.model);
        return (
          !!m &&
          (m.thinking.length ? m.thinking.includes(r.reasoning) : r.reasoning === "") &&
          (!configured.modeId || !!p?.modes.includes(configured.modeId))
        );
      },
    };
    // Reconcile an existing compatible same-task context before selecting a new
    // model from the priority list. Pi API sessions remain ineligible until the
    // daemon can atomically rebind their per-attempt environment/ledger.
    for (const candidate of preference
      .map((id) => this.config.routes.find((route) => route.id === id))
      .filter((route): route is RuntimeRoute => !!route)) {
      const policy = decideRoute({
        ...input,
        routes: routes.filter((route) => route.id === candidate.id),
      });
      if (!policy.route) continue;
      const old = this.store.db
        .prepare("SELECT agent_id,status FROM sessions WHERE key=?")
        .get(this.sessionKey(c, candidate)) as { agent_id: string; status: string } | undefined;
      if (!old || old.status !== "idle") continue;
      if (candidate.provider === "pi" && !this.provider.rebindSession) {
        this.store.event(`SESSION_REUSE_SKIPPED:${candidate.id}:fresh-budget-rebind-unverified`);
        continue;
      }
      if (!this.provider.foregroundEvidence)
        return { action: "wait", reason: "session-tool-history-unavailable" };
      let snapshot: Snapshot | null;
      try {
        snapshot = await this.observed(await this.provider.refresh(old.agent_id));
      } catch {
        return { action: "wait", reason: "session-not-confirmed-idle" };
      }
      if (!snapshot || snapshot.id !== old.agent_id)
        return { action: "reconcile", reason: "session-not-confirmed-idle" };
      let completion: { state: string; reason: string };
      try {
        completion = await this.completion.assess(snapshot);
      } catch {
        return { action: "wait", reason: "session-not-confirmed-idle" };
      }
      if (completion.state !== "VERIFY")
        return { action: "reconcile", reason: "session-not-confirmed-idle" };
      this.validateSnapshot(c, candidate, snapshot);
      if (candidate.provider === "pi" && snapshot.processCoverage !== "job-v1") {
        this.store.event(
          `SESSION_REUSE_SKIPPED:${candidate.id}:process-capability-upgrade-required`,
        );
        continue;
      }
      if (
        snapshot.contextFraction === null ||
        !Number.isFinite(snapshot.contextFraction) ||
        snapshot.contextFraction < 0 ||
        snapshot.contextFraction > 1
      )
        return { action: "wait", reason: "session-context-unknown" };
      if (snapshot.contextFraction >= 0.8) {
        const checkpoint = this.saveAndRetireSession({
          taskKey: key,
          contract: c,
          route: candidate,
          agentId: snapshot.id,
          sessionKey: this.sessionKey(c, candidate),
          snapshot,
        });
        if (checkpoint.state === "WAITING") return { action: "wait", reason: checkpoint.reason };
        break;
      }
      return {
        action: "reuse",
        route: candidate,
        sessionId: snapshot.id,
        reason: "confirmed-compatible-idle",
        routing: {
          reason: "same-task-role-context-before-new-priority",
          source: "policy",
          ...routingCategory,
        },
      };
    }
    const d = decideRoute(input);
    if (!d.route && !categoryPreference) return { action: d.action, reason: d.reason };
    const skippedIds = d.route ? preference.slice(0, preference.indexOf(d.route.id)) : preference;
    const skipped = skippedIds.map((id) => {
      const configured = this.config.routes.find((route) => route.id === id),
        candidate = routes.find((route) => route.id === id);
      let reason = "capability-or-model-unavailable";
      if (!configured || !candidate) reason = "route-missing";
      else if (!configured.enabled) reason = "disabled";
      else if (!candidate.healthy) reason = "confirmed-provider-or-route-circuit";
      else if (this.store.routeOccupied(configured, undefined, c))
        reason = "route-concurrency-limit-for-main";
      else if (!routeAllowsPath(configured, c.worktree)) reason = "repository-not-approved";
      else if (configured.tier < c.minTier) reason = "quality-tier-insufficient";
      else if (
        c.requiredCapabilities.some((capability) => !configured.capabilities.includes(capability))
      )
        reason = "required-capability-missing";
      else if (!c.mutation && configured.provider === "pi") reason = "read-only-not-enforced";
      else if (configured.bucket && !input.budgetAllowed(candidate))
        reason = "api-budget-unavailable";
      else if (configured.revision === "discovery-required") reason = "catalog-revision-unverified";
      return { routeId: id, reason };
    });
    const reason =
      !d.route && categoryPreference
        ? `${categoryPreference.category === "ui" ? "ui" : "category"}-${d.reason}`
        : d.reason;
    const routing = { reason, source: "policy", skipped, ...routingCategory };
    if (!d.route) return { action: d.action, reason, routing };
    const route = this.config.routes.find((r) => r.id === d.route!.id)!;
    // Workflow/package classification happens before admission. Model priority is
    // deterministic here, including when a legacy caller passes allowDecisions.
    return { action: "start", route, reason: d.reason, routing };
  }
  sessionKey(c: Contract, route: RuntimeRoute): string {
    return hash({
      contract: hash(c),
      config: hash(this.config),
      route,
      worktree: c.worktree,
      role: c.role,
      diff: c.reviewDiffHash,
    });
  }
  private saveAndRetireSession(input: ContextCheckpointInput): ContextCheckpointResult {
    const waiting = (reason: string): ContextCheckpointResult => ({ state: "WAITING", reason });
    const { taskKey, contract, route, agentId, sessionKey, snapshot } = input;
    if (this.store.stopped() || !this.canDispatch(taskKey))
      return waiting("session-checkpoint-dispatch-paused");
    const task = this.store.task(taskKey),
      previousAttempt = this.store.latest(taskKey);
    if (
      !task ||
      task.contract_hash !== hash(contract) ||
      task.config_hash !== hash(this.config) ||
      task.state !== "REWORK" ||
      !previousAttempt ||
      previousAttempt.status !== "FAILED"
    )
      return waiting("session-checkpoint-rework-state-changed");
    const revision = this.git.snapshot(contract);
    if (revision.scopeViolations || revision.diffCheckExit !== 0)
      return waiting("session-checkpoint-diff-not-safe");
    const reviewRow = this.store.db
      .prepare("SELECT result_json FROM review_runs WHERE attempt_id=?")
      .get(previousAttempt.id) as { result_json: string | null } | undefined;
    let reviewResult: ReviewResult | undefined;
    if (reviewRow?.result_json) {
      try {
        const parsed = reviewResultSchema.safeParse(JSON.parse(reviewRow.result_json));
        if (!parsed.success || parsed.data.diffHash !== revision.diffHash)
          return waiting("session-checkpoint-review-diff-changed");
        reviewResult = parsed.data;
      } catch {
        return waiting("session-checkpoint-review-result-invalid");
      }
    }
    let checkpoint: TaskCheckpoint;
    try {
      checkpoint = taskCheckpointSchema.parse({
        version: 1,
        taskKey,
        agentId,
        routeId: route.id,
        contractHash: hash(contract),
        configurationHash: hash(this.config),
        baseCommit: contract.baseCommit,
        diffHash: revision.diffHash,
        sessionKey,
        changedFiles: revision.files,
        reviewResultHash: reviewResult ? hash(reviewResult) : null,
        reviewFindings: reviewResult?.findings ?? [],
      });
    } catch {
      return waiting("session-checkpoint-diff-not-safe");
    }
    return this.store.transaction(() => {
      if (this.store.stopped() || !this.canDispatch(taskKey))
        return waiting("session-checkpoint-dispatch-paused");
      const currentTask = this.store.task(taskKey),
        currentAttempt = this.store.latest(taskKey);
      if (
        !currentTask ||
        currentTask.contract_hash !== checkpoint.contractHash ||
        currentTask.config_hash !== checkpoint.configurationHash ||
        currentTask.state !== "REWORK" ||
        currentAttempt?.id !== previousAttempt.id ||
        currentAttempt.status !== "FAILED"
      )
        return waiting("session-checkpoint-rework-state-changed");
      const activeWriter = this.store.active().some((active) => {
        const activeTask = this.store.task(active.task_key);
        if (!activeTask) return true;
        try {
          return (
            canonicalPath(contractSchema.parse(JSON.parse(activeTask.contract_json)).worktree) ===
            canonicalPath(contract.worktree)
          );
        } catch {
          return true;
        }
      });
      if (activeWriter) return waiting("session-checkpoint-writer-active");
      const coordination = this.store.coordinationBlock(contract);
      if (coordination) return waiting(`session-checkpoint-${coordination}`);
      const activeLease = this.store.db
        .prepare("SELECT 1 FROM leases WHERE attempt_id=? AND state!='RELEASED'")
        .get(previousAttempt.id);
      if (activeLease) return waiting("session-checkpoint-lease-active");
      const session = this.store.db
        .prepare("SELECT status FROM sessions WHERE key=? AND agent_id=?")
        .get(sessionKey, agentId) as { status: string } | undefined;
      if (session?.status !== "idle") return waiting("session-checkpoint-session-changed");
      const currentRevision = this.git.snapshot(contract);
      if (
        currentRevision.diffHash !== checkpoint.diffHash ||
        currentRevision.scopeViolations ||
        currentRevision.diffCheckExit !== 0
      )
        return waiting("session-checkpoint-diff-changed");
      const retired = this.store.db
        .prepare(
          "UPDATE sessions SET status='retired',context_fraction=?,reconciled_ms=? WHERE key=? AND agent_id=? AND status='idle'",
        )
        .run(snapshot.contextFraction, Date.now(), sessionKey, agentId).changes;
      if (retired !== 1) return waiting("session-checkpoint-session-changed");
      const event = `${taskCheckpointPrefix}${JSON.stringify(checkpoint)}`;
      if (!this.store.db.prepare("SELECT 1 FROM events WHERE kind=?").get(event))
        this.store.event(event, previousAttempt.id);
      return { state: "RETIRED" };
    });
  }
  private taskCheckpoint(
    taskKey: string,
    contract: Contract,
    diffHash: string,
  ): TaskCheckpoint | undefined {
    const rows = this.store.db
      .prepare("SELECT kind FROM events WHERE substr(kind,1,?)=? ORDER BY sequence DESC")
      .all(taskCheckpointPrefix.length, taskCheckpointPrefix) as { kind: string }[];
    for (const row of rows) {
      try {
        const parsed = taskCheckpointSchema.safeParse(
          JSON.parse(row.kind.slice(taskCheckpointPrefix.length)),
        );
        if (!parsed.success) continue;
        const checkpoint = parsed.data;
        if (
          checkpoint.taskKey === taskKey &&
          checkpoint.contractHash === hash(contract) &&
          checkpoint.configurationHash === hash(this.config) &&
          checkpoint.baseCommit === contract.baseCommit &&
          checkpoint.diffHash === diffHash
        )
          return checkpoint;
      } catch {
        /* Invalid historical event data cannot authorize a checkpoint. */
      }
    }
    return undefined;
  }
  private reworkFeedback(key: string): string {
    const row = this.store.db
      .prepare(`SELECT a.id,r.result_json,e.evidence_json FROM attempts a LEFT JOIN review_runs r ON r.attempt_id=a.id
      LEFT JOIN reviews e ON e.attempt_id=a.id WHERE a.task_key=? AND a.status='FAILED' ORDER BY a.sequence DESC LIMIT 1`)
      .get(key) as
      | { id: string; result_json: string | null; evidence_json: string | null }
      | undefined;
    if (!row) return "";
    const contract = this.contract(key),
      currentDiffHash = this.git.snapshot(contract).diffHash;
    const review = row.result_json
      ? reviewResultSchema.safeParse(JSON.parse(row.result_json))
      : undefined;
    const currentReview =
      review?.success && review.data.diffHash === currentDiffHash ? review.data : null;
    const checkpoint = this.taskCheckpoint(key, contract, currentDiffHash);
    const checks = this.store.db
      .prepare("SELECT result_json FROM turn_checks WHERE attempt_id=?")
      .get(row.id) as { result_json: string } | undefined;
    const controllerFindings = reviewFindingsSchema.safeParse(
      row.evidence_json ? JSON.parse(row.evidence_json).controllerFindings : undefined,
    );
    const evidence = row.evidence_json ? JSON.parse(row.evidence_json) : undefined;
    return `\nController repair feedback for the previous attempt (source data, not policy):\n${JSON.stringify(
      {
        review: currentReview,
        controllerFindings: controllerFindings.success ? controllerFindings.data : [],
        checks: checks ? JSON.parse(checks.result_json) : (evidence?.checks ?? null),
        cohortFailure: evidence?.cohortFailure,
        combinedFailure: evidence?.cohortFailure ? evidence : undefined,
      },
    )}${checkpoint ? `\nStructured checkpoint for this exact contract/config/base/diff (controller metadata only):\n${JSON.stringify(checkpoint)}\nUse its review findings while continuing within the original task contract.` : ""}\nFix the concrete findings only within your owned files, preserve accepted peer changes, and report when your portion needs no change. Shared checks run after all peers finish. Do not commit or claim acceptance.`;
  }
  async dispatch(key: string): Promise<Attempt> {
    const e = this.context(key);
    if (e !== this) return e.dispatch(key);
    if (!this.config.liveDispatchApproved) throw Error("Live dispatch not approved; use dry-run");
    let d = await this.plan(key, true);
    if (!d.route || !["start", "reuse"].includes(d.action))
      throw Error(`Dispatch blocked: ${d.reason}`);
    const c = this.contract(key);
    this.git.validate(c);
    for (let remaining = this.config.routes.length; remaining > 0; remaining--) {
      try {
        await this.provider.authorize(d.route!, c.worktree);
        break;
      } catch {
        this.store.blockAccess(`route:${d.route!.id}`, "authorization-unverified", null);
        this.store.event(`ROUTE_SKIPPED:${d.route!.id}:authorization-unverified`);
        d = await this.plan(key, true);
        if (!d.route || !["start", "reuse"].includes(d.action))
          throw Error("Billing proof missing for all eligible routes");
        if (remaining === 1) throw Error("Billing proof unavailable");
      }
    }
    assertTaskAssessment(this.store, this.config, c);
    if (!this.canDispatch(key)) throw Error("Automatic routing paused");
    const a = this.store.claim(key, d.route, this.config, this.sessionKey(c, d.route), d.sessionId);
    this.store.event(
      `ROUTING_DETAIL:${JSON.stringify(d.routing ?? { reason: d.reason, source: "policy" })}`,
      a.id,
    );
    return this.deliver(a.id);
  }
  async deliver(id: string): Promise<Attempt> {
    const a = this.store.attempt(id);
    const e = this.context(a.task_key);
    if (e !== this) return e.deliver(id);
    if (!this.config.liveDispatchApproved) throw Error("Live dispatch not approved");
    const c = this.contract(a.task_key);
    const route: RuntimeRoute = JSON.parse(a.route_json);
    this.git.validate(c);
    await this.provider.authorize(route, c.worktree);
    assertTaskAssessment(this.store, this.config, c);
    if (!this.canDispatch(a.task_key)) return this.store.attempt(id);
    try {
      if (a.agent_id) {
        const before = await this.observed(await this.provider.refresh(a.agent_id));
        if (!before || (await this.completion.assess(before)).state !== "VERIFY")
          throw Error("Session not idle");
        this.validateSnapshot(c, route, before);
        assertTaskAssessment(this.store, this.config, c);
        if (!this.canDispatch(a.task_key) || !this.store.beginSend(id))
          return this.store.attempt(id);
        if (route.provider === "pi") {
          if (!this.provider.rebindSession) throw Error("Pi budget rebind unavailable");
          await this.provider.rebindSession(
            a.agent_id,
            route,
            { ...c, allowedPaths: this.store.scopePaths(c), checks: this.store.checkCommands(c) },
            id,
          );
          assertTaskAssessment(this.store, this.config, c);
          const rebound = await this.observed(await this.provider.refresh(a.agent_id));
          if (!rebound || (await this.completion.assess(rebound)).state !== "VERIFY")
            throw Error("Rebound Pi session not confirmed idle");
          this.validateSnapshot(c, route, rebound);
        }
        if (!this.canDispatch(a.task_key)) return this.store.attempt(id);
        const result = await this.provider.run(
          a.agent_id,
          taskPrompt({
            ...c,
            allowedPaths: this.store.scopePaths(c),
            checks: this.store.checkCommands(c),
          }) + this.reworkFeedback(a.task_key),
        );
        this.store.db.prepare("UPDATE attempts SET run_accepted=1 WHERE id=?").run(id);
        await this.acceptSnapshot(id, result);
      } else {
        if (!this.canDispatch(a.task_key) || !this.store.beginSend(id))
          return this.store.attempt(id);
        assertTaskAssessment(this.store, this.config, c);
        const agentId = await this.provider.create(
          route,
          { ...c, allowedPaths: this.store.scopePaths(c), checks: this.store.checkCommands(c) },
          id,
          this.reworkFeedback(a.task_key),
        );
        this.store.bind(id, agentId);
        await this.acceptSnapshot(id, await this.provider.wait(agentId));
      }
    } catch {
      // Any error after send begins is ambiguous, including an HTTP 5xx.
      // No retry or release until provider reconciliation proves the outcome.
      this.store.observe(id, "NEEDS_CONFIRMATION");
    }
    return this.store.attempt(id);
  }
  validateSnapshot(c: Contract, route: RuntimeRoute, s: Snapshot): void {
    if (
      canonicalPath(s.cwd) !== (c.workspace?.directory ?? c.worktree) ||
      (c.workspace && s.workspaceId !== c.workspace.id) ||
      s.provider !== route.provider ||
      s.model !== route.model ||
      (s.reasoning ?? "") !== route.reasoning ||
      (route.modeId && s.modeId !== route.modeId) ||
      c.implementationAgentId === s.id
    )
      throw Error("Provider session identity mismatch");
  }
  async acceptSnapshot(id: string, s: Snapshot): Promise<void> {
    const a = this.store.attempt(id),
      c = this.contract(a.task_key),
      r: RuntimeRoute = JSON.parse(a.route_json);
    if (a.agent_id !== s.id) throw Error("Agent binding mismatch");
    this.validateSnapshot(c, r, s);
    if (
      r.access === "openai-api" &&
      s.backgroundActive === false &&
      !s.foregroundActive &&
      (s.turnComplete || ["idle", "error"].includes(s.status)) &&
      this.provider.freezeApiBudget
    ) {
      const debit = this.provider.freezeApiBudget(id);
      const reservation = this.store.db
        .prepare("SELECT reserved,settled,state FROM reservations WHERE id=?")
        .get(id) as { reserved: number; settled: number | null; state: string };
      if (debit.limit !== reservation.reserved || debit.debited > debit.limit)
        throw Error("Guarded API ledger differs from reservation");
      if (reservation.state === "PENDING") {
        try {
          this.store.settle(id, debit.debited);
        } catch (error) {
          const current = this.store.db
            .prepare("SELECT settled,state FROM reservations WHERE id=?")
            .get(id) as { settled: number | null; state: string };
          if (current.state !== "SETTLED" || current.settled !== debit.debited) throw error;
        }
      } else if (reservation.state !== "SETTLED" || reservation.settled !== debit.debited)
        throw Error("Guarded API debit changed after settlement");
    }
    if (s.status === "error" && s.failureKind)
      this.store.db.prepare("UPDATE attempts SET error_kind=? WHERE id=?").run(s.failureKind, id);
    if (
      s.status === "error" &&
      ["quota-5h", "quota-week", "quota-month", "auth"].includes(s.failureKind ?? "")
    ) {
      this.store.blockAccess(
        r.access,
        s.failureKind!,
        s.retryAfterMs ? Date.now() + s.retryAfterMs : null,
      );
      if (s.backgroundActive !== false) {
        this.store.observe(id, "NEEDS_CONFIRMATION");
        return;
      }
    }
    if (s.status === "error" && s.backgroundActive === false) {
      if (this.git.snapshot(c).files.length) {
        this.store.observe(id, "NEEDS_CONFIRMATION");
        return;
      }
      const kind = s.failureKind ?? "invalid-data";
      const transient = ["transient", "rate-limited"].includes(kind);
      const delay = Math.max(
        1000,
        s.retryAfterMs ??
          Math.min(300000, 1000 * 2 ** Math.min(a.sequence, 8)) + Math.floor(Math.random() * 1000),
      );
      this.store.failConfirmed(
        id,
        kind,
        transient ? Date.now() + delay : null,
        !["quality", "invalid-data", "task-budget"].includes(kind),
      );
      return;
    }
    const decision = await this.completion.assess(s);
    this.store.observe(id, decision.state, s.contextFraction, s.usage);
    this.store.event(`COMPLETION_CHECK:${decision.reason}`, id);
    if (decision.state === "VERIFY" && !this.store.verificationBlocked(c, id))
      this.runVerification(id);
  }
  async reconcile(id: string): Promise<Attempt> {
    const a = this.store.attempt(id);
    const e = this.context(a.task_key);
    if (e !== this) return e.reconcile(id);
    if (
      ![
        "SENDING",
        "UNKNOWN",
        "PERMISSION",
        "RUNNING",
        "NEEDS_CONFIRMATION",
        "WAITING_PROCESSES",
        "TURN_COMPLETE",
      ].includes(a.status)
    )
      return a;
    try {
      if (a.agent_id) {
        const s = await this.observed(await this.provider.refresh(a.agent_id));
        // Without the matching run acknowledgement this may still be the previous
        // turn's idle snapshot. Never treat it as execution of the new request.
        if (s && (!a.reused || a.run_accepted)) await this.acceptSnapshot(id, s);
        else this.store.observe(id, "NEEDS_CONFIRMATION");
      } else {
        const found = await this.provider.find(id);
        if (found.length === 1) {
          this.validateSnapshot(this.contract(a.task_key), JSON.parse(a.route_json), found[0]);
          this.store.bind(id, found[0].id);
          await this.acceptSnapshot(id, found[0]);
        } else this.store.observe(id, "NEEDS_CONFIRMATION");
      }
    } catch {
      this.store.observe(id, "NEEDS_CONFIRMATION");
    }
    return this.store.attempt(id);
  }
  async recover(): Promise<Attempt[]> {
    // Recovery observes only. Even INTENT is not sent automatically after a restart.
    const result: Attempt[] = [];
    for (const a of this.store.active()) result.push(await this.reconcile(a.id));
    const reviews = this.store.db
      .prepare(
        "SELECT attempt_id FROM review_runs WHERE state IN ('SENDING','UNKNOWN','RUNNING','PERMISSION','NEEDS_CONFIRMATION','WAITING_PROCESSES')",
      )
      .all() as { attempt_id: string }[];
    for (const r of reviews) await this.review(r.attempt_id, true);
    return result;
  }
  async tick(taskKeys?: readonly string[]): Promise<void> {
    const included = (key: string) =>
      this.canDispatch(key) && (taskKeys === undefined || taskKeys.includes(key));
    await this.recover();
    if (this.store.stopped() || !this.config.liveDispatchApproved) return;
    const verify = this.store.db
      .prepare("SELECT id FROM attempts WHERE status='VERIFY' ORDER BY created_ms")
      .all() as { id: string }[];
    for (const a of verify.filter((a) => included(this.store.attempt(a.id).task_key))) {
      try {
        await this.advance(a.id);
      } catch {
        this.store.event("ADVANCE_BLOCKED", a.id);
      }
    }
    for (const a of this.store
      .active()
      .filter((a) => a.status === "INTENT" && included(a.task_key))) {
      try {
        await this.deliver(a.id);
      } catch {
        this.store.event("DELIVERY_BLOCKED", a.id);
      }
    }
    const ready = this.store.db
      .prepare("SELECT key FROM tasks WHERE state IN ('READY','REWORK') ORDER BY key")
      .all() as { key: string }[];
    for (const t of ready.filter((t) => included(t.key))) {
      try {
        await this.dispatch(t.key);
      } catch {
        this.store.event("DISPATCH_BLOCKED");
      }
    }
  }
  private runVerification(id: string, fresh = false) {
    const a = this.store.attempt(id),
      c = this.contract(a.task_key),
      before = this.git.snapshot(c);
    const cached = this.store.db
      .prepare("SELECT diff_hash,result_json FROM turn_checks WHERE attempt_id=?")
      .get(id) as { diff_hash: string; result_json: string } | undefined;
    const old = cached
      ? (JSON.parse(cached.result_json) as ReturnType<Engine["checkTree"]>)
      : undefined;
    const claimed = this.store.transaction(() => {
      const current = this.store.attempt(id);
      if (
        !["TURN_COMPLETE", "VERIFY"].includes(current.status) ||
        !this.store.db
          .prepare("SELECT 1 FROM leases WHERE attempt_id=? AND fence=? AND state='HELD'")
          .get(id, current.fence)
      )
        throw Error("Verification attempt or fencing no longer current");
      if (this.store.verificationBlocked(c, id)) throw Error("PEER_WORK_IN_PROGRESS");
      if (this.store.db.prepare("SELECT 1 FROM check_locks WHERE worktree=?").get(c.worktree))
        return "occupied";
      if (
        !fresh &&
        cached?.diff_hash === before.diffHash &&
        old?.build.quiescent &&
        old.test.quiescent
      )
        return "cached";
      this.store.db.prepare("INSERT INTO check_locks VALUES(?,?)").run(c.worktree, id);
      return "claimed";
    });
    if (claimed === "cached") return old!;
    if (claimed === "occupied") {
      this.store.observe(id, "NEEDS_CONFIRMATION");
      throw Error("Verification process ownership unclear");
    }
    try {
      const result = this.checkTree(c, before.diffHash);
      if (!result.build.quiescent || !result.test.quiescent)
        throw Error("Check processes not confirmed terminated");
      this.store.db
        .prepare(
          "INSERT INTO turn_checks VALUES(?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET diff_hash=excluded.diff_hash,result_json=excluded.result_json",
        )
        .run(id, result.diffHash, JSON.stringify(result));
      this.store.db
        .prepare("DELETE FROM check_locks WHERE worktree=? AND attempt_id=?")
        .run(c.worktree, id);
      this.store.event("AUTOMATIC_VERIFICATION", id);
      return result;
    } catch (error) {
      // Binding checks happen before a process launch or after the preceding
      // synchronous supervised job settled. They do not leave an unknown job.
      if (error instanceof Error && error.message.startsWith("CHECK_COMMAND_"))
        this.store.db
          .prepare("DELETE FROM check_locks WHERE worktree=? AND attempt_id=?")
          .run(c.worktree, id);
      this.store.observe(id, "NEEDS_CONFIRMATION");
      throw error;
    }
  }
  private checkTree(c: Contract, originalHash: string) {
    const commands = this.store.checkCommands(c);
    const build = runCheck(commands.build, c.worktree, 600000);
    const test = build.quiescent
      ? runCheck(this.store.checkCommands(c).test, c.worktree, 600000)
      : { exit: -1, logHash: hash("not-started"), quiescent: false };
    const after = this.git.snapshot(c);
    return {
      build,
      test,
      diffHash: after.diffHash,
      scopeViolations: after.scopeViolations,
      diffCheckExit: after.diffCheckExit,
      changed: after.diffHash !== originalHash,
    };
  }
  async advance(id: string): Promise<void> {
    const a = this.store.attempt(id),
      e = this.context(a.task_key);
    if (e !== this) return e.advance(id);
    if (a.status !== "VERIFY") return;
    const c = this.contract(a.task_key);
    if (c.role === "planner") {
      const checks = this.runVerification(id),
        s = await this.provider.wait(a.agent_id!);
      const plan = planResultSchema.safeParse(s.planResult);
      const pass =
        plan.success &&
        (this.config.orchestrationVersion !== 3 || !!plan.data.workPackages?.length) &&
        !checks.build.exit &&
        !checks.test.exit &&
        !checks.scopeViolations &&
        !checks.diffCheckExit &&
        !checks.changed &&
        !this.git.snapshot(c).files.length;
      this.store.finish(
        id,
        pass,
        checks.diffHash,
        { stage: "planning", plan: plan.success ? plan.data : null, checks },
        this.config.maxRework,
      );
      return;
    }
    const review = await this.review(id);
    if (review.state !== "DONE" || this.store.attempt(id).status !== "VERIFY") return;
    const reviewRow = this.store.db
      .prepare("SELECT diff_hash,result_json FROM review_runs WHERE attempt_id=?")
      .get(id) as { diff_hash: string; result_json: string | null } | undefined;
    const reviewResult = reviewRow?.result_json
      ? reviewResultSchema.safeParse(JSON.parse(reviewRow.result_json))
      : undefined;
    if (
      reviewResult?.success &&
      (!reviewResult.data.pass || reviewResult.data.unresolvedIssues > 0)
    ) {
      const current = this.git.snapshot(c);
      if (
        !reviewRow ||
        reviewResult.data.diffHash !== reviewRow.diff_hash ||
        current.diffHash !== reviewRow.diff_hash ||
        current.scopeViolations
      ) {
        this.store.observe(id, "NEEDS_CONFIRMATION");
        this.store.event("REVIEW_REWORK_DIFF_CHANGED", id);
        return;
      }
      if (this.store.db.prepare("SELECT 1 FROM check_locks WHERE worktree=?").get(c.worktree)) {
        this.store.observe(id, "NEEDS_CONFIRMATION");
        this.store.event("REVIEW_REWORK_CHECKS_UNSETTLED", id);
        return;
      }
      this.store.finish(
        id,
        false,
        current.diffHash,
        {
          stage: "independent-review",
          reviewResult: reviewResult.data,
          controllerFindings: reviewResult.data.findings ?? [],
        },
        this.config.maxRework,
      );
      return;
    }
    if (c.uiChanged || c.workKind === "ui") {
      this.store.db
        .prepare(
          "UPDATE tasks SET state='NEEDS_CONFIRMATION' WHERE key=? AND EXISTS(SELECT 1 FROM attempts WHERE id=? AND status='VERIFY')",
        )
        .run(a.task_key, id);
      this.store.event("VISUAL_ACCEPTANCE_REQUIRED", id);
      return;
    }
    const current = this.git.snapshot(c),
      row = this.store.db
        .prepare("SELECT diff_hash FROM review_runs WHERE attempt_id=?")
        .get(id) as { diff_hash: string };
    const directory = path.join(appRoot, "state/evidence");
    mkdirSync(directory, { recursive: true });
    const artifact = path.join(
      directory,
      hash({ attempt: id, contract: hash(c), config: hash(this.config) }) + ".json",
    );
    const contents =
      JSON.stringify({
        attempt: id,
        diffHash: current.diffHash,
        reviewerAgentId: review.agentId,
        mode: "automatic-checks-and-independent-review",
      }) + "\n";
    try {
      writeFileSync(artifact, contents, { flag: "wx" });
    } catch (error) {
      if (!lstatSync(artifact).isFile() || readFileSync(artifact, "utf8") !== contents) throw error;
    }
    this.verify(id, {
      diffHash: current.diffHash,
      reviewedDiffHash: row.diff_hash,
      implementationAgentId: a.agent_id,
      reviewerAgentId: review.agentId,
      buildExit: 0,
      testExit: 0,
      reviewPass: true,
      visualAcceptance: false,
      ownerApproved:
        this.config.orchestrationVersion === 3 && c.mutation
          ? hasAuditedOwnerApproval(this.store, c)
          : c.ownerApproved,
      scopeViolations: 0,
      unresolvedIssues: 0,
      artifacts: [artifact],
    });
  }
  private recordReview(id: string, state: string, result: string | null): void {
    this.store.transaction(() => {
      const a = this.store.attempt(id);
      if (a.status !== "VERIFY") return;
      const changed = this.store.db
        .prepare(
          "UPDATE review_runs SET state=?,result_json=? WHERE attempt_id=? AND state!='DONE'",
        )
        .run(state, result, id).changes;
      if (!changed) return;
      this.store.db
        .prepare("UPDATE tasks SET state=? WHERE key=?")
        .run(state === "DONE" ? "VERIFY" : state, a.task_key);
      this.store.event(`REVIEW_${state}`, id);
    });
  }
  private recordCompletionBoundarySkips(id: string, routes: readonly RuntimeRoute[]): void {
    for (const route of routes) {
      const kind = `REVIEW_ROUTE_SKIPPED:${route.id}:completion-boundary-unavailable`;
      if (
        !this.store.db.prepare("SELECT 1 FROM events WHERE kind=? AND attempt_id=?").get(kind, id)
      )
        this.store.event(kind, id);
    }
  }
  private async reviewerRoutes(
    c: Contract,
    implementationRouteId: string,
  ): Promise<ReviewerRouteSelection> {
    const preferences = this.config.roleRoutes?.reviewer ?? routePreference.reviewer;
    const candidates = preferences
      .map((id) => this.config.routes.find((route) => route.id === id))
      .filter(
        (route): route is ReviewerRoute =>
          !!route &&
          (route.provider === "codex" || isClaudeProvider(route.provider)) &&
          route.enabled &&
          route.revision !== "discovery-required" &&
          route.id !== implementationRouteId &&
          route.tier >= Math.max(3, c.minTier) &&
          routeAllowsPath(route, c.worktree) &&
          !this.store.circuitOpen(route.access, Date.now()) &&
          !this.store.circuitOpen(`route:${route.id}`, Date.now()),
      );
    const providers = [...new Set(candidates.map((route) => route.provider))];
    if (!providers.length)
      return { eligible: [], completionBoundaryUnavailable: [], discoveryPending: false };

    let discovered: Discovery[];
    try {
      discovered = await this.provider.discover(c.worktree, true, providers);
    } catch {
      return { eligible: [], completionBoundaryUnavailable: [], discoveryPending: true };
    }
    const relevantProviders = new Set<string>(providers);
    if (
      discovered.some(
        (entry) => relevantProviders.has(entry.provider) && entry.status === "loading",
      )
    )
      return { eligible: [], completionBoundaryUnavailable: [], discoveryPending: true };

    const eligible: RuntimeRoute[] = [],
      completionBoundaryUnavailable: RuntimeRoute[] = [];
    for (const route of candidates) {
      const provider = discovered.find((entry) => entry.provider === route.provider);
      if (!provider || provider.supportsBackgroundWorkRefresh !== true) {
        completionBoundaryUnavailable.push(route);
        continue;
      }
      if (provider.status !== "ready") continue;
      const model = provider.models.find((entry) => entry.id === route.model);
      if (
        !model ||
        (model.thinking.length ? !model.thinking.includes(route.reasoning) : route.reasoning !== "")
      )
        continue;
      if (
        isClaudeProvider(route.provider)
          ? !provider.modes.includes("plan")
          : route.modeId && !provider.modes.includes(route.modeId)
      )
        continue;
      eligible.push(isClaudeProvider(route.provider) ? { ...route, modeId: "plan" } : route);
    }
    return { eligible, completionBoundaryUnavailable, discoveryPending: false };
  }
  private async startReviewIntent(
    id: string,
    c: Contract,
    implementationRouteId: string,
    snapshot: ReturnType<Git["snapshot"]>,
  ): Promise<ReviewIntentStart> {
    const selection = await this.reviewerRoutes(c, implementationRouteId);
    if (selection.discoveryPending)
      return {
        waiting: {
          state: "WAITING_PROVIDER_DISCOVERY",
          agentId: null,
          reason: "reviewer-provider-discovery-pending",
        },
      };
    if (!selection.eligible.length) {
      this.recordCompletionBoundarySkips(id, selection.completionBoundaryUnavailable);
      return {
        waiting: {
          state: "WAITING_REVIEWER_CAPABILITY",
          agentId: null,
          reason: selection.completionBoundaryUnavailable.length
            ? "completion-boundary-unavailable"
            : "no-qualified-independent-read-only-reviewer",
        },
      };
    }
    // Build/test evidence precedes a paid/limited reviewer turn.
    const checked = this.runVerification(id),
      { build, test, changed } = checked;
    if (snapshot.scopeViolations || snapshot.diffCheckExit || build.exit || test.exit || changed) {
      this.store.finish(
        id,
        false,
        snapshot.diffHash,
        { phase: "pre-review", build, test, scopeViolations: snapshot.scopeViolations, changed },
        snapshot.scopeViolations ? 0 : this.config.maxRework,
      );
      throw Error("Build, tests and scope must pass before review");
    }
    const route = selection.eligible[0];
    this.store.transaction(() => {
      if (this.store.stopped()) throw Error("Dispatch stopped");
      if (this.store.routeOccupied(route, undefined, c)) throw Error("Route slot limit");
      this.recordCompletionBoundarySkips(id, selection.completionBoundaryUnavailable);
      const continued = this.store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM events WHERE attempt_id=? AND kind='CONTINUATION_BEGIN'",
        )
        .get(id) as { count: number };
      const requestKey = continued.count
        ? `${id}/review/continuation-${continued.count}`
        : `${id}/review`;
      this.store.db
        .prepare("INSERT OR IGNORE INTO review_runs VALUES(?,?,?,NULL,?,?,NULL)")
        .run(id, requestKey, JSON.stringify(route), "INTENT", snapshot.diffHash);
    });
    const row = this.store.db
      .prepare("SELECT * FROM review_runs WHERE attempt_id=?")
      .get(id) as unknown as ReviewRunRow;
    return { row };
  }
  private async revalidateReviewIntent(
    id: string,
    c: Contract,
    implementationRouteId: string,
    row: ReviewRunRow,
    currentRoute: RuntimeRoute,
  ): Promise<ReviewIntentRevalidation> {
    const selection = await this.reviewerRoutes(c, implementationRouteId);
    if (selection.discoveryPending)
      return {
        waiting: {
          state: "WAITING_PROVIDER_DISCOVERY",
          agentId: null,
          reason: "reviewer-provider-discovery-pending",
        },
      };
    this.recordCompletionBoundarySkips(id, selection.completionBoundaryUnavailable);
    const circuitOpen =
      this.store.circuitOpen(currentRoute.access, Date.now()) ||
      this.store.circuitOpen(`route:${currentRoute.id}`, Date.now());
    const currentRouteEligible = selection.eligible.find(
      (candidate) => candidate.id === currentRoute.id,
    );
    if (!circuitOpen && currentRouteEligible && hash(currentRouteEligible) === hash(currentRoute))
      return { row, route: currentRoute };
    const next =
      !circuitOpen && currentRouteEligible ? currentRouteEligible : selection.eligible[0];
    if (!next)
      return {
        waiting: {
          state: "WAITING_REVIEWER_CAPABILITY",
          agentId: null,
          reason: selection.completionBoundaryUnavailable.length
            ? "completion-boundary-unavailable"
            : "no-qualified-independent-read-only-reviewer",
        },
      };

    const requestKey = `${id}/review/${hash({ previous: row.request_key, next: next.id }).slice(0, 20)}`;
    const updated = this.store.transaction(() => {
      if (this.store.stopped()) return false;
      const changes = this.store.db
        .prepare(
          "UPDATE review_runs SET route_json=?,request_key=? WHERE attempt_id=? AND state='INTENT' AND agent_id IS NULL",
        )
        .run(JSON.stringify(next), requestKey, id).changes;
      if (!changes) return false;
      this.store.event(
        next.id === currentRoute.id
          ? `REVIEW_ROUTE_REVALIDATED:${next.id}`
          : `REVIEW_FALLBACK:${currentRoute.id}:${next.id}`,
        id,
      );
      return true;
    });
    const updatedRow = this.store.db
      .prepare("SELECT * FROM review_runs WHERE attempt_id=?")
      .get(id) as unknown as ReviewRunRow;
    if (updated) return { row: updatedRow, route: next };
    if (
      updatedRow.state === "INTENT" &&
      !updatedRow.agent_id &&
      hash(JSON.parse(updatedRow.route_json)) !== hash(next)
    )
      return {
        waiting: {
          state: "WAITING_REVIEWER_RECONCILIATION",
          agentId: null,
          reason: "reviewer-route-revalidation-raced",
        },
      };
    if (updatedRow.state !== "INTENT" || updatedRow.agent_id)
      return {
        waiting: {
          state: updatedRow.state,
          agentId: updatedRow.agent_id,
          reason: "reviewer-dispatch-state-changed",
        },
      };
    return { row: updatedRow, route: JSON.parse(updatedRow.route_json) as RuntimeRoute };
  }
  async review(
    id: string,
    observeOnly = false,
  ): Promise<{ state: string; agentId: string | null; reason?: string }> {
    const context = this.context(this.store.attempt(id).task_key);
    if (context !== this) return context.review(id, observeOnly);
    if (!observeOnly && (!this.config.liveDispatchApproved || this.store.stopped()))
      throw Error("Review dispatch not approved or stopped");
    const a = this.store.attempt(id),
      c = this.contract(a.task_key);
    if (a.status !== "VERIFY") throw Error("Implementation must be quiescent");
    if (this.store.verificationBlocked(c, id)) return { state: "WAITING_PEERS", agentId: null };
    if (this.store.db.prepare("SELECT 1 FROM check_locks WHERE worktree=?").get(c.worktree)) {
      this.store.observe(id, "NEEDS_CONFIRMATION");
      throw Error("Verification process ownership unclear");
    }
    const implementation = await this.observed(await this.provider.refresh(a.agent_id!));
    if (!implementation) {
      this.store.observe(id, "NEEDS_CONFIRMATION");
      return { state: "NEEDS_CONFIRMATION", agentId: null };
    }
    this.validateSnapshot(c, JSON.parse(a.route_json), implementation);
    const implementationCompletion = await this.completion.assess(implementation);
    if (implementationCompletion.state !== "VERIFY") {
      this.store.observe(id, "NEEDS_CONFIRMATION");
      this.store.event(`COMPLETION_DRIFT:${implementationCompletion.reason}`, id);
      return { state: "NEEDS_CONFIRMATION", agentId: null };
    }
    const snapshot = this.git.snapshot(c);
    let row = this.store.db.prepare("SELECT * FROM review_runs WHERE attempt_id=?").get(id) as
      | ReviewRunRow
      | undefined;
    if (observeOnly && (!row || row.state === "INTENT"))
      return { state: row?.state ?? "NOT_STARTED", agentId: row?.agent_id ?? null };
    if (!row) {
      // Build/test evidence precedes a paid/limited reviewer turn.
      const implementationRoute: RuntimeRoute = JSON.parse(a.route_json);
      const started = await this.startReviewIntent(id, c, implementationRoute.id, snapshot);
      if ("waiting" in started) return started.waiting;
      row = started.row;
    }
    if (!row) throw Error("Reviewer intent was not available after preflight");
    if (row.diff_hash !== snapshot.diffHash)
      throw Error("Review snapshot stale; verification must request rework");
    if (row.state === "DONE") return { state: "DONE", agentId: row.agent_id };
    let r: RuntimeRoute = JSON.parse(row.route_json);
    if (!observeOnly && row.state === "INTENT" && row.agent_id) {
      return {
        state: "WAITING_REVIEWER_RECONCILIATION",
        agentId: row.agent_id,
        reason: "unsent-review-intent-has-agent-id",
      };
    }
    if (!observeOnly && row.state === "INTENT") {
      const implementationRoute: RuntimeRoute = JSON.parse(a.route_json);
      const revalidated = await this.revalidateReviewIntent(id, c, implementationRoute.id, row, r);
      if ("waiting" in revalidated) return revalidated.waiting;
      row = revalidated.row;
      r = revalidated.route;
    }
    const reviewer = this.reviewerContract(c, a.agent_id, row.diff_hash);
    if (!observeOnly && row.state === "INTENT") {
      if (this.store.circuitOpen(r.access, Date.now()))
        throw Error("Reviewer account circuit open");
      try {
        await this.provider.authorize(r, c.worktree);
      } catch {
        this.store.blockAccess(`route:${r.id}`, "authorization-unverified", null);
        this.store.event(`REVIEW_ROUTE_SKIPPED:${r.id}:authorization-unverified`, id);
        return { state: "INTENT", agentId: null };
      }
    }
    try {
      let result: Snapshot | null = null;
      const claimed = this.store.transaction(() => {
        if (observeOnly || this.store.stopped() || !this.canDispatch(a.task_key)) return false;
        if (this.store.routeOccupied(r, id, c)) return false;
        return (
          this.store.db
            .prepare("UPDATE review_runs SET state='SENDING' WHERE attempt_id=? AND state='INTENT'")
            .run(id).changes === 1
        );
      });
      if (!claimed && row.state === "INTENT") return { state: "INTENT", agentId: null };
      if (claimed) {
        const reviewerId = await this.provider.create(r, reviewer, row.request_key);
        this.store.db
          .prepare("UPDATE review_runs SET agent_id=? WHERE attempt_id=?")
          .run(reviewerId, id);
        result = await this.provider.wait(reviewerId);
      } else if (row.agent_id) result = await this.provider.wait(row.agent_id);
      else {
        const found = await this.provider.find(row.request_key);
        if (found.length === 1) {
          result = found[0];
          this.store.db
            .prepare("UPDATE review_runs SET agent_id=? WHERE attempt_id=?")
            .run(result.id, id);
        }
      }
      if (!result) throw Error("Unknown review outcome");
      result = await this.observed(result);
      if (!result) throw Error("Unknown review outcome");
      this.validateSnapshot(reviewer, r, result);
      if (
        result.status === "error" &&
        result.failureKind &&
        result.backgroundActive === false &&
        !result.foregroundActive &&
        (!this.provider.foregroundEvidence ||
          (await this.provider.foregroundEvidence(result.id)).complete)
      ) {
        const kind = result.failureKind;
        if (!["quality", "invalid-data", "task-budget"].includes(kind)) {
          const until = ["transient", "rate-limited"].includes(kind)
            ? Date.now() + Math.max(1000, result.retryAfterMs ?? 10000)
            : null;
          this.store.blockAccess(
            kind === "flex-unavailable" ? `route:${r.id}` : r.access,
            kind,
            until,
          );
          this.recordReview(id, "INTENT", null);
          this.store.db
            .prepare("UPDATE review_runs SET agent_id=NULL WHERE attempt_id=? AND state='INTENT'")
            .run(id);
          return { state: "INTENT", agentId: null };
        }
      }
      const parsed = reviewResultSchema.safeParse(result.reviewResult);
      if (
        this.config.orchestrationVersion === 3 &&
        parsed.success &&
        (!parsed.data.pass || parsed.data.unresolvedIssues > 0) &&
        !parsed.data.findings?.length
      )
        throw Error("Concrete review findings required");
      if (result.turnComplete && !parsed.success) this.store.event("REVIEW_RESULT_INVALID", id);
      const completion = await this.completion.assess(result);
      const done =
        completion.state === "VERIFY" &&
        parsed.success &&
        parsed.data.diffHash === row.diff_hash &&
        this.git.snapshot(c).diffHash === row.diff_hash;
      const state = done
        ? "DONE"
        : completion.state === "VERIFY"
          ? "NEEDS_CONFIRMATION"
          : completion.state;
      this.recordReview(id, state, done ? JSON.stringify(parsed.data) : null);
    } catch {
      this.recordReview(id, "NEEDS_CONFIRMATION", null);
    }
    row = this.store.db
      .prepare("SELECT * FROM review_runs WHERE attempt_id=?")
      .get(id) as unknown as ReviewRunRow;
    return { state: row.state, agentId: row.agent_id };
  }
  verify(id: string, input: unknown): { ok: boolean; reasons: string[] } {
    const context = this.context(this.store.attempt(id).task_key);
    if (context !== this) return context.verify(id, input);
    const e: Evidence = evidenceSchema.parse(input),
      a = this.store.attempt(id),
      c = this.contract(a.task_key);
    if (a.status !== "VERIFY") throw Error("Agent is not confirmed quiescent");
    if (e.implementationAgentId !== a.agent_id || e.reviewerAgentId === a.agent_id)
      throw Error("Independent reviewer identity required");
    const review = this.store.db
      .prepare("SELECT * FROM review_runs WHERE attempt_id=? AND state='DONE'")
      .get(id) as { agent_id: string; diff_hash: string; result_json: string } | undefined;
    if (!review || review.agent_id !== e.reviewerAgentId)
      throw Error("Verified independent provider review missing");
    const result = reviewResultSchema.parse(JSON.parse(review.result_json));
    const artifacts = e.artifacts.map((file) => {
      const p = localPath(file);
      if (!lstatSync(p).isFile()) throw Error("Evidence must be a local file");
      return { path: p, hash: hash(readFileSync(p).toString("base64")) };
    });
    const before = this.git.snapshot(c);
    const { build, test } = this.runVerification(id, this.config.orchestrationVersion !== 3);
    const after = this.git.snapshot(c);
    const v = mayComplete({
      buildExit: build.exit || e.buildExit || after.diffCheckExit,
      testExit: test.exit || e.testExit,
      diffHash: after.diffHash,
      reviewedDiffHash: e.reviewedDiffHash,
      uiChanged: c.uiChanged || c.workKind === "ui",
      visualAcceptance: e.visualAcceptance,
      highRisk: c.highRisk,
      ownerApproved:
        this.config.orchestrationVersion === 3 && c.mutation
          ? hasAuditedOwnerApproval(this.store, c)
          : c.ownerApproved && e.ownerApproved,
      reviewPass: e.reviewPass && result.pass,
      scopeViolations: after.scopeViolations + e.scopeViolations,
      unresolvedIssues: e.unresolvedIssues + result.unresolvedIssues,
    });
    if (review.diff_hash !== after.diffHash) {
      v.ok = false;
      v.reasons.push("provider-review-stale");
    }
    if (before.diffHash !== after.diffHash || e.diffHash !== after.diffHash) {
      v.ok = false;
      v.reasons.push("diff-changed-during-verification");
    }
    this.store.finish(
      id,
      v.ok,
      after.diffHash,
      { ...e, reviewResult: result, artifacts, checks: { build, test }, reasons: v.reasons },
      this.config.maxRework,
    );
    return v;
  }
}
