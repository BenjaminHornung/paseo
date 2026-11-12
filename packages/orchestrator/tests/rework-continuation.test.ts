import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Engine } from "../src/engine.ts";
import {
  canonicalPath,
  configSchema,
  contractSchema,
  hash,
  type Contract,
} from "../src/contracts.ts";
import { Git } from "../src/git.ts";
import type { Provider, Snapshot } from "../src/provider.ts";
import { Store } from "../src/store.ts";

function gitExecutable(): string {
  const command =
    process.platform === "win32"
      ? path.join(process.env.SystemRoot ?? "C:/Windows", "System32/where.exe")
      : "/usr/bin/which";
  return execFileSync(command, ["git"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
}
function runGit(executable: string, args: string[], cwd: string): string {
  try {
    return execFileSync(executable, args, { cwd, encoding: "utf8" }).trim();
  } catch (error) {
    const diagnostic = (error as NodeJS.ErrnoException & { stderr?: Buffer }).stderr
      ?.toString()
      .trim();
    throw Error(diagnostic || `Git command failed: ${args.join(" ")}`, { cause: error });
  }
}

test("unresolved reviewer findings rework before visual acceptance and checkpoint before same-priority restart", async (t) => {
  const root = mkdtempSync(path.join(process.cwd(), ".rework-checkpoint-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = gitExecutable(),
    repository = path.join(root, "repo"),
    worktreePath = path.join(root, "worktree");
  mkdirSync(path.join(repository, "src"), { recursive: true });
  writeFileSync(path.join(repository, "src", "base.ts"), "export const base = true;\n");
  runGit(git, ["init", "-b", "main"], repository);
  runGit(git, ["config", "user.name", "Paseo test"], repository);
  runGit(git, ["config", "user.email", "paseo-test@example.invalid"], repository);
  runGit(git, ["add", "."], repository);
  runGit(git, ["commit", "-m", "fixture"], repository);
  runGit(
    git,
    ["worktree", "add", "-b", "feature/rework-checkpoint", worktreePath, "HEAD"],
    repository,
  );
  const baseCommit = runGit(git, ["rev-parse", "HEAD"], worktreePath);
  const repoPath = canonicalPath(repository),
    worktree = canonicalPath(worktreePath);
  writeFileSync(
    path.join(worktreePath, "src", "in-progress.ts"),
    "export const inProgress = true;\n",
  );

  const writerRoute = {
    id: "writer",
    access: "codex-pro200" as const,
    provider: "codex" as const,
    model: "writer-model",
    revision: "fixture",
    reasoning: "high" as const,
    tier: 2 as const,
    enabled: true,
    maxConcurrent: 2,
    dataScopes: ["public" as const],
    capabilities: ["code" as const],
  };
  const reviewerRoute = {
    id: "reviewer",
    access: "codex-pro200" as const,
    provider: "codex" as const,
    model: "reviewer-model",
    revision: "fixture",
    reasoning: "high" as const,
    tier: 3 as const,
    enabled: true,
    maxConcurrent: 2,
    dataScopes: ["public" as const],
    capabilities: ["code" as const],
  };
  const roleRoutes = {
    planner: ["writer"],
    advisor: ["writer"],
    "implement-simple": ["writer"],
    "implement-normal": ["writer"],
    "implement-complex": ["writer"],
    reviewer: ["reviewer"],
  };
  const config = configSchema.parse({
    schemaVersion: 1,
    orchestrationVersion: 2,
    daemonUrl: "ws://127.0.0.1:3010/ws",
    gitExecutable: git,
    maxWorkflows: 2,
    maxRework: 1,
    apiEnabled: false,
    liveDispatchApproved: true,
    budgets: { decisions: 0, implementation: 0, "premium-api": 0, emergency: 0 },
    routes: [writerRoute, reviewerRoute],
    roleRoutes,
  });
  const contract: Contract = contractSchema.parse({
    workflowId: "workflow",
    taskId: "amended-task",
    repository: repoPath,
    worktree,
    baseCommit,
    dataScope: "public",
    role: "implement-normal",
    prompt: "Continue the approved objective",
    acceptance: ["Finish the objective"],
    allowedPaths: ["src"],
    requiredCapabilities: ["code"],
    minTier: 2,
    mutation: true,
    highRisk: false,
    uiChanged: true,
    ownerApproved: false,
    estimatedMicroUsd: 0,
    packageRevision: 2,
    amendsTaskKey: "workflow/prior-task/implement-normal",
    amendsContractHash: "a".repeat(64),
    amendsDiffHash: "b".repeat(64),
    checks: { build: [process.execPath, "--version"], test: [process.execPath, "--version"] },
  });
  const taskKey = `${contract.workflowId}/${contract.taskId}/${contract.role}`,
    attemptId = `${taskKey}/1`;
  const dbPath = path.join(root, "controller.sqlite"),
    store = new Store(dbPath);
  store.db
    .prepare("INSERT INTO workflows VALUES(?,?,?,?)")
    .run(contract.workflowId, repoPath, contract.dataScope, hash(config));
  store.db
    .prepare(`INSERT INTO tasks(key,workflow_id,contract_json,contract_hash,config_hash,config_json,state)
    VALUES(?,?,?,?,?,?,?)`)
    .run(
      taskKey,
      contract.workflowId,
      JSON.stringify(contract),
      hash(contract),
      hash(config),
      JSON.stringify(config),
      "VERIFY",
    );
  const diff = new Git(git).snapshot(contract);
  const reviewerFinding = {
    severity: "P3" as const,
    file: "src/in-progress.ts",
    line: 1,
    problem: "The in-progress result is incomplete.",
    requiredChange: "Finish the reported behavior before acceptance.",
  };
  const reviewResult = {
    diffHash: diff.diffHash,
    pass: true,
    unresolvedIssues: 1,
    findings: [reviewerFinding],
  };
  const reviewCheckpoint = {
    build: { exit: 0, logHash: hash("build"), quiescent: true },
    test: { exit: 0, logHash: hash("test"), quiescent: true },
    diffHash: diff.diffHash,
    scopeViolations: 0,
    diffCheckExit: 0,
    changed: false,
  };
  store.db
    .prepare(`INSERT INTO attempts(id,task_key,sequence,status,route_json,agent_id,fence,session_key,created_ms,result_hash,error_kind)
    VALUES(?,?,1,'VERIFY',?,?,1,'writer-session',?,NULL,NULL)`)
    .run(attemptId, taskKey, JSON.stringify(writerRoute), "writer-old", Date.now());
  store.db
    .prepare(
      "INSERT INTO leases(worktree,attempt_id,fence,state,heartbeat_ms) VALUES(?,?,1,'HELD',?)",
    )
    .run(worktree, attemptId, Date.now());
  store.db
    .prepare("INSERT INTO turn_checks VALUES(?,?,?)")
    .run(attemptId, diff.diffHash, JSON.stringify(reviewCheckpoint));
  store.db
    .prepare(
      "INSERT INTO review_runs(attempt_id,request_key,route_json,agent_id,state,diff_hash,result_json) VALUES(?,?,?,?,?,?,NULL)",
    )
    .run(
      attemptId,
      `${attemptId}/review`,
      JSON.stringify(reviewerRoute),
      null,
      "INTENT",
      diff.diffHash,
    );

  let contextFraction: number | null = 0.4,
    workerFeedback = "";
  const provider: Provider = {
    authorize: async () => {},
    discover: async () => [
      {
        provider: "codex",
        status: "ready",
        supportsBackgroundWorkRefresh: true,
        models: [
          { id: writerRoute.model, thinking: ["high"] },
          { id: reviewerRoute.model, thinking: ["high"] },
        ],
        modes: [],
      },
    ],
    create: async (route, _reviewContract, _requestKey, feedback = "") => {
      if (route.id === "reviewer") {
        assert.equal(_reviewContract.role, "reviewer");
        assert.equal(_reviewContract.mutation, false);
        assert.equal(_reviewContract.amendsTaskKey, undefined);
        assert.equal(_reviewContract.amendsContractHash, undefined);
        assert.equal(_reviewContract.amendsDiffHash, undefined);
        return "reviewer-agent";
      }
      workerFeedback = feedback;
      return "writer-new";
    },
    find: async () => [],
    refresh: async (id): Promise<Snapshot> => ({
      id,
      cwd: worktree,
      provider: "codex",
      model: writerRoute.model,
      status: "idle",
      contextFraction,
      backgroundActive: false,
      foregroundActive: false,
      turnComplete: true,
      usage: {
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        billedMicroUsd: null,
      },
      reasoning: "high",
      modeId: null,
    }),
    run: async (id): Promise<Snapshot> => ({
      id,
      cwd: worktree,
      provider: "codex",
      model: writerRoute.model,
      status: "idle",
      contextFraction,
      backgroundActive: false,
      foregroundActive: false,
      turnComplete: true,
      usage: {
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        billedMicroUsd: null,
      },
      reasoning: "high",
      modeId: null,
    }),
    wait: async (id): Promise<Snapshot> =>
      id === "reviewer-agent"
        ? {
            id,
            cwd: worktree,
            provider: "codex",
            model: reviewerRoute.model,
            status: "idle",
            contextFraction: 0.4,
            backgroundActive: false,
            foregroundActive: false,
            turnComplete: true,
            reviewResult,
            usage: {
              inputTokens: null,
              cachedInputTokens: null,
              outputTokens: null,
              billedMicroUsd: null,
            },
            reasoning: "high",
            modeId: null,
          }
        : {
            id,
            cwd: worktree,
            provider: "codex",
            model: writerRoute.model,
            status: "running",
            contextFraction,
            backgroundActive: false,
            foregroundActive: true,
            turnComplete: false,
            usage: {
              inputTokens: null,
              cachedInputTokens: null,
              outputTokens: null,
              billedMicroUsd: null,
            },
            reasoning: "high",
            modeId: null,
          },
    foregroundEvidence: async () => ({ complete: true, traceHash: "f".repeat(64), toolCount: 1 }),
  };
  const engine = new Engine(store, config, provider);
  const writerSessionKey = engine.sessionKey(contract, writerRoute);
  store.db
    .prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?)")
    .run(writerSessionKey, "writer-old", "idle", 0.4, Date.now(), JSON.stringify({}));

  await engine.advance(attemptId);
  assert.equal(store.task(taskKey)?.state, "REWORK");
  assert.equal(store.attempt(attemptId).status, "FAILED");
  assert.equal(store.attempt(attemptId).error_kind, null);
  assert.equal(
    (
      store.db
        .prepare("SELECT COUNT(*) AS count FROM events WHERE kind='VISUAL_ACCEPTANCE_REQUIRED'")
        .get() as { count: number }
    ).count,
    0,
  );
  const persistedReview = store.db
    .prepare("SELECT result_json FROM review_runs WHERE attempt_id=?")
    .get(attemptId) as { result_json: string };
  assert.deepEqual(JSON.parse(persistedReview.result_json), reviewResult);

  contextFraction = null;
  const unknownContext = await engine.plan(taskKey);
  assert.deepEqual(
    { action: unknownContext.action, reason: unknownContext.reason },
    { action: "wait", reason: "session-context-unknown" },
  );
  assert.equal(
    (
      store.db.prepare("SELECT status FROM sessions WHERE key=?").get(writerSessionKey) as {
        status: string;
      }
    ).status,
    "idle",
  );
  assert.equal(
    (
      store.db
        .prepare("SELECT COUNT(*) AS count FROM events WHERE kind LIKE 'TASK_CHECKPOINT:%'")
        .get() as { count: number }
    ).count,
    0,
  );

  contextFraction = 0.91;
  const plan = await engine.plan(taskKey);
  assert.equal(plan.action, "start");
  assert.equal(plan.route?.id, writerRoute.id);
  assert.equal(
    (
      store.db.prepare("SELECT status FROM sessions WHERE key=?").get(writerSessionKey) as {
        status: string;
      }
    ).status,
    "retired",
  );
  const checkpointRow = store.db
    .prepare("SELECT kind FROM events WHERE substr(kind,1,?)=? ORDER BY sequence DESC LIMIT 1")
    .get("TASK_CHECKPOINT:".length, "TASK_CHECKPOINT:") as { kind: string };
  const checkpoint = JSON.parse(checkpointRow.kind.slice("TASK_CHECKPOINT:".length));
  assert.equal(checkpoint.contractHash, hash(contract));
  assert.equal(checkpoint.configurationHash, hash(config));
  assert.equal(checkpoint.baseCommit, baseCommit);
  assert.equal(checkpoint.diffHash, diff.diffHash);
  assert.deepEqual(checkpoint.reviewFindings, [reviewerFinding]);
  assert.equal(
    (store.db.prepare("SELECT COUNT(*) AS count FROM reservations").get() as { count: number })
      .count,
    0,
  );

  await engine.tick();
  assert.equal(
    workerFeedback.includes("Structured checkpoint for this exact contract/config/base/diff"),
    true,
  );
  assert.equal(workerFeedback.includes(reviewerFinding.problem), true);
  assert.equal(store.latest(taskKey)?.route_json, JSON.stringify(writerRoute));
  store.close();
});
