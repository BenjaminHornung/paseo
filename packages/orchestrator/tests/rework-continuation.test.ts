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
  parseAgentJson,
  reviewResultSchema,
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
    .run(contract.workflowId, repoPath, "", hash(config));
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

  await t.test(
    "terminal invalid native review permits only bound same-worker repair and fresh review",
    async () => {
      const state = new Store(":memory:");
      try {
        rmSync(path.join(worktreePath, "src", "in-progress.ts"));
        const emptyDiff = new Git(git).snapshot(contract);
        assert.equal(
          emptyDiff.files.length,
          0,
          "the observed failed implementation has an empty diff",
        );
        const initialChecks = { ...reviewCheckpoint, diffHash: emptyDiff.diffHash };
        const nativeReviewer = {
          ...reviewerRoute,
          provider: "claude" as const,
          access: "claude-company-pro" as const,
          modeId: "plan",
          repositoryRoots: [root],
        };
        const repairConfig = configSchema.parse({
          ...config,
          routes: [writerRoute, nativeReviewer],
        });
        state.db
          .prepare("INSERT INTO workflows VALUES(?,?,?,?)")
          .run(contract.workflowId, repoPath, "", hash(repairConfig));
        state.db
          .prepare(
            "INSERT INTO tasks(key,workflow_id,contract_json,contract_hash,config_hash,config_json,state,rework) VALUES(?,?,?,?,?,?,?,0)",
          )
          .run(
            taskKey,
            contract.workflowId,
            JSON.stringify(contract),
            hash(contract),
            hash(repairConfig),
            JSON.stringify(repairConfig),
            "VERIFY",
          );
        state.db
          .prepare(
            "INSERT INTO attempts(id,task_key,sequence,status,route_json,agent_id,fence,session_key,created_ms,result_hash,error_kind) VALUES(?,?,1,'VERIFY',?,?,1,'original-session',?,NULL,NULL)",
          )
          .run(attemptId, taskKey, JSON.stringify(writerRoute), "writer-old", Date.now());
        state.db
          .prepare("INSERT INTO leases VALUES(?,?,1,'HELD',?)")
          .run(worktree, attemptId, Date.now());
        state.db
          .prepare("INSERT INTO turn_checks VALUES(?,?,?)")
          .run(attemptId, emptyDiff.diffHash, JSON.stringify(initialChecks));
        const writerSnapshot = {
          ...(await provider.refresh("writer-old")),
          contextFraction: 0.4,
        } as Snapshot;
        let reviewerActive = false,
          invalid = true,
          changedBinding = false,
          sent = 0,
          continuationPrompt = "";
        const requests: { key: string; diffHash: string }[] = [];
        const reviewSnapshot = (id: string): Snapshot => ({
          ...writerSnapshot,
          id,
          provider: "claude",
          model: nativeReviewer.model,
          modeId: "plan",
          foregroundActive: reviewerActive,
          turnComplete: !reviewerActive,
          status: reviewerActive ? "running" : "idle",
          reviewResult: parseAgentJson(
            JSON.stringify({
              diffHash: new Git(git).snapshot(contract).diffHash,
              pass: !invalid,
              unresolvedIssues: invalid ? ["Missing implementation", "Missing checks"] : 0,
              findings: invalid ? [reviewerFinding] : [],
            }),
            reviewResultSchema,
          ),
        });
        const repairProvider: Provider = {
          ...provider,
          discover: async () => [
            ...(await provider.discover(worktree)),
            {
              provider: "claude",
              status: "ready",
              supportsBackgroundWorkRefresh: true,
              models: [{ id: nativeReviewer.model, thinking: ["high"] }],
              modes: ["plan"],
            },
          ],
          create: async (route, reviewContract, requestKey) => {
            assert.equal(route.provider, "claude");
            assert.equal(reviewContract.mutation, false);
            assert.equal(reviewContract.role, "reviewer");
            requests.push({ key: requestKey, diffHash: reviewContract.reviewDiffHash! });
            return `reviewer-agent-${requests.length}`;
          },
          wait: async (id) =>
            id.startsWith("reviewer-agent") ? reviewSnapshot(id) : writerSnapshot,
          refresh: async (id) => {
            if (!id.startsWith("reviewer-agent")) return writerSnapshot;
            if (changedBinding)
              state.db
                .prepare(
                  "UPDATE review_runs SET request_key=request_key||'-changed' WHERE attempt_id=?",
                )
                .run(attemptId);
            return reviewSnapshot(id);
          },
          run: async (id, prompt) => {
            assert.equal(id, "writer-old");
            sent++;
            continuationPrompt = prompt;
            return writerSnapshot;
          },
        };
        const repairEngine = new Engine(state, repairConfig, repairProvider);
        await repairEngine.advance(attemptId);
        assert.equal(state.task(taskKey)?.state, "NEEDS_CONFIRMATION");
        assert.equal(
          state.attempt(attemptId).status,
          "VERIFY",
          "reproduce the already-installed terminal review/attempt skew",
        );
        const oldReview = state.db
          .prepare("SELECT * FROM review_runs WHERE attempt_id=?")
          .get(attemptId)!;
        assert.equal(oldReview.state, "NEEDS_CONFIRMATION");
        assert.equal(
          oldReview.result_json,
          null,
          "invalid native arrays are not normalized into a verdict",
        );
        const repair = { diffHash: emptyDiff.diffHash, findings: [reviewerFinding] };
        reviewerActive = true;
        await assert.rejects(() => repairEngine.continueExisting(taskKey, repair));
        assert.equal(sent, 0, "active reviewers cannot overlap a mutating continuation");
        reviewerActive = false;
        invalid = false;
        await assert.rejects(
          () => repairEngine.continueExisting(taskKey, repair),
          /CONTINUATION_REVIEW_PASS_PENDING/,
          "a fresh valid pass must be finalized by normal review recovery, not discarded",
        );
        assert.equal(sent, 0, "a valid review pass cannot trigger another mutating prompt");
        assert.deepEqual(
          state.db.prepare("SELECT * FROM review_runs WHERE attempt_id=?").get(attemptId),
          oldReview,
          "the pending valid pass retains its original review projection",
        );
        assert.equal(
          state.db
            .prepare(
              "SELECT count(*) AS count FROM events WHERE kind LIKE 'CONTINUATION_REVIEW_ARCHIVED:%'",
            )
            .get()!.count,
          0,
          "a valid pass is never archived as a rejected review",
        );
        invalid = true;
        changedBinding = true;
        await assert.rejects(() => repairEngine.continueExisting(taskKey, repair));
        assert.equal(sent, 0, "a changed reviewer/request binding cannot be consumed");
        state.db
          .prepare("UPDATE review_runs SET request_key=? WHERE attempt_id=?")
          .run(oldReview.request_key, attemptId);
        changedBinding = false;
        const duplicateIntent = `CONTINUATION_INTENT:${"f".repeat(64)}`;
        state.event(duplicateIntent, attemptId);
        await assert.rejects(
          () => repairEngine.continueExisting(taskKey, repair),
          /CONTINUATION_ALREADY_ATTEMPTED/,
        );
        assert.equal(
          state.db
            .prepare(
              "SELECT count(*) AS count FROM events WHERE kind LIKE 'CONTINUATION_REVIEW_ARCHIVED:%'",
            )
            .get()!.count,
          0,
          "a failed claim rolls back its attempted audit and projection replacement",
        );
        assert.equal(
          state.db.prepare("SELECT request_key FROM review_runs WHERE attempt_id=?").get(attemptId)!
            .request_key,
          oldReview.request_key,
        );
        state.db
          .prepare("DELETE FROM events WHERE attempt_id=? AND kind=?")
          .run(attemptId, duplicateIntent);
        assert.deepEqual(await repairEngine.continueExisting(taskKey, repair), {
          agentId: "writer-old",
          continued: true,
        });
        assert.equal(sent, 1);
        assert.equal(state.attempt(attemptId).status, "RUNNING");
        assert.equal(
          state.db
            .prepare("SELECT fence FROM leases WHERE attempt_id=? AND state='HELD'")
            .get(attemptId)!.fence,
          1,
        );
        assert.ok(continuationPrompt.includes(contract.prompt));
        assert.ok(continuationPrompt.includes(contract.acceptance[0]));
        assert.ok(continuationPrompt.includes(reviewerFinding.problem));
        assert.equal(
          state.db.prepare("SELECT 1 FROM review_runs WHERE attempt_id=?").get(attemptId),
          undefined,
          "a repaired turn cannot reuse the superseded review snapshot",
        );
        assert.equal(
          state.db.prepare("SELECT 1 FROM turn_checks WHERE attempt_id=?").get(attemptId),
          undefined,
        );
        const archive = state.db
          .prepare(
            "SELECT kind FROM events WHERE attempt_id=? AND kind LIKE 'CONTINUATION_REVIEW_ARCHIVED:%'",
          )
          .get(attemptId) as { kind: string };
        const evidence = JSON.parse(archive.kind.slice("CONTINUATION_REVIEW_ARCHIVED:".length));
        assert.deepEqual(
          evidence.review,
          { ...oldReview },
          "retain the complete original review/request/agent evidence",
        );
        assert.deepEqual(JSON.parse(evidence.checks.result_json), initialChecks);
        writeFileSync(
          path.join(worktreePath, "src", "in-progress.ts"),
          "export const inProgress = 'repaired';\n",
        );
        const repairedDiff = new Git(git).snapshot(contract);
        assert.notEqual(repairedDiff.diffHash, emptyDiff.diffHash);
        invalid = false;
        state.observe(attemptId, "VERIFY", 0.4);
        await repairEngine.review(attemptId);
        const next = state.db
          .prepare("SELECT * FROM review_runs WHERE attempt_id=?")
          .get(attemptId)!;
        assert.equal(next.state, "DONE");
        assert.equal(next.diff_hash, repairedDiff.diffHash);
        assert.equal(requests.length, 2);
        assert.notEqual(
          requests[0].key,
          requests[1].key,
          "new turn requires a fresh idempotent reviewer request",
        );
        assert.equal((await repairEngine.review(attemptId)).state, "DONE");
        assert.equal(
          requests.length,
          2,
          "reading the same review again cannot start another native request",
        );
        assert.equal(
          JSON.parse(
            String(
              state.db
                .prepare("SELECT result_json FROM turn_checks WHERE attempt_id=?")
                .get(attemptId)!.result_json,
            ),
          ).diffHash,
          repairedDiff.diffHash,
        );
        assert.equal(
          state.db
            .prepare(
              "SELECT count(*) AS count FROM events WHERE kind LIKE 'CONTINUATION_REVIEW_ARCHIVED:%'",
            )
            .get()!.count,
          1,
        );
      } finally {
        state.close();
      }
    },
  );
});
