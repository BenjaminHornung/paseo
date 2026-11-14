import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rm } from "node:fs/promises";
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
import { Git, runCheck } from "../src/git.ts";
import { PaseoProvider, type Provider, type Snapshot } from "../src/provider.ts";
import { createPaseoApi } from "@getpaseo/client";
import { Store } from "../src/store.ts";
import { setTimeout as delay } from "node:timers/promises";
import { codeRoot, powershellExecutable } from "../src/settings-files.ts";

test("owned checks wait without a runtime deadline and bind their real controller lifetime", async () => {
  const directory = mkdtempSync(path.join(process.cwd(), ".owned-check-test-"));
  const supervisor = path.join(codeRoot, "scripts/check-job.ps1");
  const marker = path.join(directory, "must-not-start");
  const request = Buffer.from(
    JSON.stringify({
      command: [
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`,
      ],
      cwd: directory,
      timeoutMs: 2000,
      controllerPid: process.ppid,
    }),
  ).toString("base64");
  const parseResult = (text: string) => {
    const result = text.match(/ORCHESTRATOR_CHECK_RESULT:(\{[^\n]+\})/);
    assert.ok(result, "the owned supervisor must return a structured result");
    return JSON.parse(result[1]) as { exit: number; quiescent: boolean; timedOut: boolean };
  };
  const waitFor = async (condition: () => boolean, timeoutMs = 15000) => {
    const until = Date.now() + timeoutMs;
    while (!condition()) {
      assert.ok(Date.now() < until, "owned fixture did not reach the expected lifecycle state");
      await delay(20);
    }
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  try {
    const foreign = spawnSync(
      powershellExecutable,
      ["-NoProfile", "-NonInteractive", "-File", supervisor, "-Request", request],
      { cwd: directory, encoding: "utf8", windowsHide: true, timeout: 20000 },
    );
    assert.equal(foreign.status, 0);
    assert.notEqual(
      parseResult(foreign.stdout).exit,
      0,
      "a different live parent cannot authorize a check child",
    );
    assert.equal(existsSync(marker), false, "parent validation precedes child creation/resume");

    const completed = path.join(directory, "completed.json");
    const childFile = path.join(directory, "late-child.cjs");
    const rootFile = path.join(directory, "early-root.cjs");
    writeFileSync(
      childFile,
      `setTimeout(() => {
      require('node:fs').writeFileSync(process.argv[2], JSON.stringify([
        process.env.MSBUILDDISABLENODEREUSE,
        process.env.DOTNET_CLI_USE_MSBUILD_SERVER,
        process.env.UseSharedCompilation
      ]));
    }, 300);`,
    );
    writeFileSync(
      rootFile,
      `const c = require('node:child_process').spawn(
      process.execPath, [${JSON.stringify(childFile)}, process.argv[2]],
      {stdio:'ignore', windowsHide:true, detached:true});
      c.unref(); process.exit(0);`,
    );
    const parentEnvironment = [
      process.env.MSBUILDDISABLENODEREUSE,
      process.env.DOTNET_CLI_USE_MSBUILD_SERVER,
      process.env.UseSharedCompilation,
    ];
    const natural = runCheck([process.execPath, rootFile, completed], directory);
    assert.equal(natural.exit, 0);
    assert.equal(natural.quiescent, true);
    assert.equal(natural.diagnostic?.timedOut, false);
    assert.deepEqual(
      JSON.parse(readFileSync(completed, "utf8")),
      ["1", "0", "false"],
      "the real late child completes under process-local buildserver prevention",
    );
    assert.deepEqual(
      [
        process.env.MSBUILDDISABLENODEREUSE,
        process.env.DOTNET_CLI_USE_MSBUILD_SERVER,
        process.env.UseSharedCompilation,
      ],
      parentEnvironment,
    );
    const bounded = runCheck([process.execPath, "-e", "setInterval(()=>{},1000)"], directory, 100);
    assert.equal(bounded.exit, 124);
    assert.equal(bounded.quiescent, true);
    assert.equal(bounded.diagnostic?.timedOut, true);

    const controllerFile = path.join(directory, "controller.mjs");
    const supervisorStarted = path.join(directory, "supervisor-started.json");
    const readyFile = path.join(directory, "ready.json");
    const outputFile = path.join(directory, "supervisor.out");
    const wrapperFile = path.join(directory, "observe-supervisor.ps1");
    writeFileSync(
      wrapperFile,
      `param([string]$Request)
      $ErrorActionPreference='Stop'
      $result = & '${supervisor.replaceAll("'", "''")}' -Request $Request
      [IO.File]::WriteAllText('${outputFile.replaceAll("'", "''")}', [string]$result)
    `,
    );
    const busyRootFile = path.join(directory, "busy-root.cjs");
    writeFileSync(
      busyRootFile,
      `const c = require('node:child_process').spawn(
      process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore',windowsHide:true});
      require('node:fs').writeFileSync(process.argv[2],JSON.stringify({root:process.pid,child:c.pid}));
      setInterval(()=>{},1000);`,
    );
    // The explicit diagnostic deadline is a fixture cleanup fallback. Correct
    // controller-death cleanup must complete without using that deadline.
    writeFileSync(
      controllerFile,
      `import {spawn} from 'node:child_process';import fs from 'node:fs';
      const output=fs.openSync(${JSON.stringify(outputFile + ".transport")},'a');
      const request=Buffer.from(JSON.stringify({command:[process.execPath,${JSON.stringify(busyRootFile)},${JSON.stringify(readyFile)}],
        cwd:${JSON.stringify(directory)},timeoutMs:5000,controllerPid:process.pid})).toString('base64');
      const p=spawn(${JSON.stringify(powershellExecutable)},['-NoProfile','-NonInteractive','-File',${JSON.stringify(wrapperFile)},'-Request',request],
        {stdio:['ignore',output,output],windowsHide:true});
      fs.closeSync(output);
      fs.writeFileSync(${JSON.stringify(supervisorStarted)},JSON.stringify({pid:p.pid}));
      setInterval(()=>{},1000);`,
    );
    const controller = spawn(process.execPath, [controllerFile], {
      cwd: directory,
      windowsHide: true,
      stdio: "ignore",
    });
    const controllerClosed = new Promise<void>((resolve) =>
      controller.once("close", () => resolve()),
    );
    try {
      await waitFor(() => existsSync(readyFile));
      const owned = JSON.parse(readFileSync(readyFile, "utf8")) as { root: number; child: number };
      const host = JSON.parse(readFileSync(supervisorStarted, "utf8")) as { pid: number };
      controller.kill();
      await controllerClosed;
      // A parent-owned console can also close PowerShell. In that case its
      // KILL_ON_JOB_CLOSE remains authoritative; a missing result is never success.
      // This bound is shorter than the explicit fixture diagnostic fallback.
      await waitFor(() => !alive(owned.root) && !alive(owned.child) && !alive(host.pid), 3000);
      if (existsSync(outputFile)) {
        const abandoned = parseResult(readFileSync(outputFile, "utf8"));
        assert.notEqual(abandoned.exit, 0, "controller death is never a successful check");
        assert.equal(abandoned.timedOut, false, "cleanup precedes the diagnostic deadline");
        assert.equal(abandoned.quiescent, true);
      }
    } finally {
      if (controller.exitCode === null && controller.signalCode === null) controller.kill();
      await controllerClosed;
      if (existsSync(supervisorStarted)) {
        const host = JSON.parse(readFileSync(supervisorStarted, "utf8")) as { pid: number };
        await waitFor(() => !alive(host.pid));
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

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
  mkdirSync(path.join(repository, "tests"));
  writeFileSync(path.join(repository, "tests", "manifest.ts"), "export const inventory = 9;\n");
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
        const closedProvider: Provider = {
          ...repairProvider,
          refresh: async (id) =>
            id === "writer-old"
              ? {
                  ...writerSnapshot,
                  status: "unknown",
                  turnComplete: false,
                  backgroundActive: null,
                }
              : repairProvider.refresh(id),
        };
        state.observe(attemptId, "NEEDS_CONFIRMATION");
        await new Engine(state, repairConfig, closedProvider).tick();
        assert.equal(
          state.attempt(attemptId).status,
          "NEEDS_CONFIRMATION",
          "closed workers remain blocked without terminating recovery",
        );
        assert.equal(
          state.db.prepare("SELECT state FROM review_runs WHERE attempt_id=?").get(attemptId)!
            .state,
          "NEEDS_CONFIRMATION",
        );
        assert.equal(sent, 0);
        // Restore the original rejected-review/VERIFY skew for the remaining
        // continuation cases; recovery itself never promoted this attempt.
        state.db.prepare("UPDATE attempts SET status='VERIFY' WHERE id=?").run(attemptId);
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
  await t.test(
    "one operator grant repairs an exhausted task in the same worker without replacing terminal evidence",
    async (terminalTest) => {
      const state = new Store(path.join(root, "terminal-repair.sqlite"));
      try {
        const repairConfig = configSchema.parse({ ...config, maxRework: 2 });
        const repairContract = contractSchema.parse({
          ...contract,
          uiChanged: false,
          checks: { ...contract.checks, build: [process.execPath, "-e", "process.exit(9)"] },
        });
        const oldId = `${taskKey}/3`,
          nativeSessionId = "native-writer-session";
        const originalDiff = new Git(git).snapshot(repairContract);
        const failedChecks = {
          ...reviewCheckpoint,
          diffHash: originalDiff.diffHash,
          build: {
            exit: 124,
            quiescent: true,
            logHash: hash("timeout"),
            diagnostic: { timedOut: true },
          },
        };
        const checkJson = JSON.stringify(failedChecks);
        state.db
          .prepare("INSERT INTO workflows VALUES(?,?,?,?)")
          .run(contract.workflowId, repoPath, "", hash(repairConfig));
        state.db
          .prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,3)")
          .run(
            taskKey,
            contract.workflowId,
            JSON.stringify(repairContract),
            hash(repairContract),
            hash(repairConfig),
            JSON.stringify(repairConfig),
            "BLOCKED",
          );
        state.db
          .prepare(
            "INSERT INTO attempts(id,task_key,sequence,status,route_json,agent_id,fence,session_key,created_ms,result_hash) VALUES(?,?,3,'FAILED',?, 'writer-old',3,'terminal-writer-session',?,?)",
          )
          .run(oldId, taskKey, JSON.stringify(writerRoute), Date.now(), originalDiff.diffHash);
        state.db
          .prepare("INSERT INTO turn_checks VALUES(?,?,?)")
          .run(oldId, originalDiff.diffHash, checkJson);
        state.db
          .prepare("INSERT INTO reviews VALUES(?,?,?)")
          .run(
            oldId,
            originalDiff.diffHash,
            JSON.stringify({ phase: "pre-review", ...failedChecks }),
          );
        const originalAttempt = state.attempt(oldId);
        const originalReview = state.db
          .prepare("SELECT * FROM reviews WHERE attempt_id=?")
          .get(oldId);
        let sent = 0,
          race = false,
          changedSession = false;
        let observedSession = nativeSessionId;
        let reviewerSession = "native-rejected-reviewer";
        let reviewerStatus: "idle" | "error" = "idle";
        let reviewerErrorDuringForeground = false;
        let duringReviewerForeground = false;
        const sdkAgent = (id = "writer-old") => ({
          id,
          cwd: worktree,
          provider: "codex",
          model: id === "rejected-reviewer" ? reviewerRoute.model : writerRoute.model,
          status: id === "rejected-reviewer" ? reviewerStatus : "idle",
          activeTurn: null,
          pendingPermissions: [],
          runtimeInfo: {
            provider: "codex",
            sessionId: id === "rejected-reviewer" ? reviewerSession : observedSession,
            thinkingOptionId: "high",
            modeId: null,
          },
        });
        // Only the daemon transport is synthetic. ref(), its per-handle state,
        // refresh/wait/timeline updates and all identity getters are the real SDK.
        const api = createPaseoApi({
          getLastServerInfoMessage: () => ({ serverId: "fixture-server" }),
          fetchAgent: async ({ agentId }: { agentId: string }) => ({ agent: sdkAgent(agentId) }),
          waitForFinish: async (id: string) => ({ status: "idle", final: sdkAgent(id) }),
          fetchAgentTimeline: async (id: string) => {
            await Promise.resolve();
            if (changedSession && id === "writer-old") observedSession = "different-native-session";
            if (
              id === "rejected-reviewer" &&
              duringReviewerForeground &&
              reviewerErrorDuringForeground
            )
              reviewerStatus = "error";
            return {
              agent: sdkAgent(id),
              entries: [],
              error: null,
              gap: false,
              hasOlder: false,
              hasNewer: false,
            };
          },
          refreshAgentBackgroundWork: async (id: string) => ({
            agentId: id,
            providerSessionId: sdkAgent(id).runtimeInfo.sessionId,
            observationId: "fresh-public-sdk",
            coverage: "codex_background_terminals",
            queriedProviderSessionIds: [sdkAgent(id).runtimeInfo.sessionId],
            items: [],
            providerSubagents: [],
          }),
        } as unknown as Parameters<typeof createPaseoApi>[0]);
        const sdkProvider = new PaseoProvider("ws://fixture.invalid/ws");
        Object.assign(sdkProvider, { client: { ...api, close: () => api.dispose() } });
        terminalTest.after(() => sdkProvider.close());
        const snapshot = (await sdkProvider.refresh("writer-old"))!;
        assert.equal(
          sdkProvider.nativeSessionId("writer-old"),
          nativeSessionId,
          "the production identity reader must use the loaded public SDK handle",
        );
        const reviews: { key: string; diff: string }[] = [];
        const repairProvider: Provider = {
          ...provider,
          nativeSessionId: (id) => sdkProvider.nativeSessionId(id),
          refresh: (id) => sdkProvider.refresh(id),
          foregroundEvidence: async (id) => {
            if (race)
              state.db
                .prepare("UPDATE turn_checks SET result_json=? WHERE attempt_id=?")
                .run(JSON.stringify({ ...failedChecks, changed: true }), oldId);
            return sdkProvider.foregroundEvidence(id);
          },
          run: async (id, prompt) => {
            assert.equal(id, "writer-old");
            assert.match(prompt, /tests\/manifest.ts/);
            assert.match(prompt, /Finish the objective/);
            assert.match(prompt, /Finish the reported behavior before acceptance/);
            sent++;
            writeFileSync(
              path.join(worktreePath, "tests", "manifest.ts"),
              "export const inventory = 10;\n",
            );
            return { ...snapshot, status: "running", foregroundActive: true, turnComplete: false };
          },
          create: async (route, reviewContract, requestKey) => {
            assert.equal(route.id, "reviewer", "no replacement implementation worker is created");
            reviews.push({ key: requestKey, diff: reviewContract.reviewDiffHash! });
            return "terminal-reviewer";
          },
          wait: async () => ({
            ...snapshot,
            id: "terminal-reviewer",
            model: reviewerRoute.model,
            reviewResult: {
              diffHash: new Git(git).snapshot(repairContract).diffHash,
              pass: false,
              unresolvedIssues: 1,
              findings: [{ ...reviewerFinding, file: "tests/manifest.ts" }],
            },
          }),
        };
        let dispatchAllowed = true;
        const repairEngine = new Engine(
          state,
          repairConfig,
          repairProvider,
          undefined,
          undefined,
          () => dispatchAllowed,
        );
        const repair = {
          diffHash: originalDiff.diffHash,
          findings: [{ ...reviewerFinding, file: "tests/manifest.ts" }],
        };
        await assert.rejects(
          () => repairEngine.continueExisting(taskKey, repair),
          /TERMINAL_REPAIR_GRANT_REQUIRED/,
        );
        const request = {
          predecessorAttemptId: oldId,
          predecessorFence: 3,
          agentId: "writer-old",
          nativeSessionId,
          contractHash: hash(repairContract),
          configHash: hash(repairConfig),
          diffHash: originalDiff.diffHash,
          checkEvidenceSha256: createHash("sha256").update(checkJson).digest("hex"),
          scopeRevision: state.scopeRevision(repairContract),
          checkRevision: state.checkRevision(repairContract),
          additionalAllowedPath: "tests/manifest.ts",
          checks: contract.checks,
        };
        const noExtensionFile = path.join(root, "terminal-repair-existing-scope.sqlite");
        const rejectedFile = path.join(root, "terminal-repair-rejected-review.sqlite");
        await state.backupTo(rejectedFile);
        const rejected = new Store(rejectedFile);
        try {
          const rejectedResult = {
            diffHash: originalDiff.diffHash,
            pass: false,
            unresolvedIssues: 1,
            findings: [reviewerFinding],
          };
          const resultJson = JSON.stringify(rejectedResult);
          const greenJson = JSON.stringify({
            ...reviewCheckpoint,
            diffHash: originalDiff.diffHash,
          });
          rejected.db
            .prepare("UPDATE turn_checks SET result_json=? WHERE attempt_id=?")
            .run(greenJson, oldId);
          rejected.db.prepare("UPDATE reviews SET evidence_json=? WHERE attempt_id=?").run(
            JSON.stringify({
              stage: "independent-review",
              reviewResult: rejectedResult,
              controllerFindings: rejectedResult.findings,
            }),
            oldId,
          );
          rejected.db
            .prepare("INSERT INTO review_runs VALUES(?,?,?,?,?,?,?)")
            .run(
              oldId,
              `${oldId}/review`,
              JSON.stringify(reviewerRoute),
              "rejected-reviewer",
              "DONE",
              originalDiff.diffHash,
              resultJson,
            );
          const { additionalAllowedPath: _additionalPath, ...baseRequest } = request;
          const rejectedRequest = {
            ...baseRequest,
            checkEvidenceSha256: createHash("sha256").update(greenJson).digest("hex"),
            rejectedReview: {
              requestKey: `${oldId}/review`,
              reviewerAgentId: "rejected-reviewer",
              reviewerNativeSessionId: "native-rejected-reviewer",
              resultSha256: createHash("sha256").update(resultJson).digest("hex"),
            },
          };
          const passingJson = JSON.stringify({
            ...rejectedResult,
            pass: true,
            unresolvedIssues: 0,
          });
          rejected.db
            .prepare("UPDATE review_runs SET result_json=? WHERE attempt_id=?")
            .run(passingJson, oldId);
          assert.throws(
            () =>
              rejected.approveTerminalRepair(
                taskKey,
                {
                  ...rejectedRequest,
                  rejectedReview: {
                    ...rejectedRequest.rejectedReview,
                    resultSha256: createHash("sha256").update(passingJson).digest("hex"),
                  },
                },
                "A PASS cannot authorize repair",
              ),
            /TERMINAL_REPAIR_REJECTED_REVIEW_REQUIRED/,
          );
          assert.equal(rejected.terminalRepairGrant(taskKey), undefined);
          rejected.db
            .prepare("UPDATE review_runs SET result_json=? WHERE attempt_id=?")
            .run(resultJson, oldId);
          rejected.approveTerminalRepair(
            taskKey,
            rejectedRequest,
            "Authorized rejected review repair",
          );
          let reviewerDrift = false;
          const rejectedEngine = new Engine(rejected, repairConfig, {
            ...repairProvider,
            nativeSessionId: (id) => sdkProvider.nativeSessionId(id),
            loadedAgent: (id) => sdkProvider.loadedAgent(id),
            refresh: async (id) => {
              if (id === "writer-old" && reviewerDrift) {
                reviewerSession = "changed-reviewer-native-session";
                await sdkProvider.refresh("rejected-reviewer");
              }
              return sdkProvider.refresh(id);
            },
            foregroundEvidence: async (id) => {
              duringReviewerForeground = id === "rejected-reviewer";
              try {
                return await sdkProvider.foregroundEvidence(id);
              } finally {
                duringReviewerForeground = false;
              }
            },
            run: async (id, prompt) => {
              assert.equal(id, "writer-old");
              assert.match(prompt, /Finish the reported behavior/);
              sent++;
              return {
                ...snapshot,
                status: "running",
                foregroundActive: true,
                turnComplete: false,
              };
            },
          });
          const oldReview = rejected.db
            .prepare("SELECT * FROM review_runs WHERE attempt_id=?")
            .get(oldId);
          const oldFinalization = rejected.db
            .prepare("SELECT * FROM reviews WHERE attempt_id=?")
            .get(oldId);
          const oldChecks = rejected.db
            .prepare("SELECT * FROM turn_checks WHERE attempt_id=?")
            .get(oldId);
          const rejectedRepair = { diffHash: originalDiff.diffHash, findings: [reviewerFinding] };
          reviewerErrorDuringForeground = true;
          await assert.rejects(
            () => rejectedEngine.continueExisting(taskKey, rejectedRepair),
            /TERMINAL_REPAIR_REVIEW_CHANGED/,
          );
          assert.equal(rejected.latest(taskKey)!.id, oldId);
          assert.equal(rejected.db.prepare("SELECT 1 FROM outbox").get(), undefined);
          assert.equal(
            rejected.db
              .prepare("SELECT 1 FROM events WHERE kind LIKE 'TERMINAL_REPAIR_CONSUMED:%'")
              .get(),
            undefined,
          );
          reviewerErrorDuringForeground = false;
          reviewerStatus = "idle";
          reviewerDrift = true;
          await assert.rejects(
            () => rejectedEngine.continueExisting(taskKey, rejectedRepair),
            /TERMINAL_REPAIR_REVIEW_CHANGED/,
          );
          assert.equal(rejected.latest(taskKey)!.id, oldId);
          assert.equal(rejected.db.prepare("SELECT 1 FROM outbox").get(), undefined);
          reviewerDrift = false;
          reviewerSession = rejectedRequest.rejectedReview.reviewerNativeSessionId;
          await assert.rejects(
            () =>
              rejectedEngine.continueExisting(taskKey, {
                ...rejectedRepair,
                findings: [{ ...reviewerFinding, problem: "Unbound replacement" }],
              }),
            /TERMINAL_REPAIR_FINDINGS_CHANGED/,
          );
          assert.equal(rejected.latest(taskKey)!.id, oldId);
          assert.equal(
            rejected.db
              .prepare("SELECT 1 FROM events WHERE kind LIKE 'TERMINAL_REPAIR_CONSUMED:%'")
              .get(),
            undefined,
          );
          const pending = await rejectedEngine.continueExisting(taskKey, rejectedRepair);
          assert.deepEqual(pending, {
            agentId: "writer-old",
            continued: false,
            delivery: "pending",
            attemptId: `${taskKey}/4`,
          });
          assert.equal(sent, 0);
          assert.equal(rejected.latest(taskKey)!.fence, 4);
          assert.equal(rejected.latest(taskKey)!.agent_id, "writer-old");
          await assert.rejects(() => rejectedEngine.continueExisting(taskKey, rejectedRepair));
          rejected.db
            .prepare("UPDATE review_runs SET result_json=? WHERE attempt_id=?")
            .run(JSON.stringify({ ...rejectedResult, pass: true, unresolvedIssues: 0 }), oldId);
          await assert.rejects(
            () => rejectedEngine.deliver(`${taskKey}/4`),
            /TERMINAL_REPAIR_REVIEW_CHANGED/,
          );
          assert.equal(sent, 0);
          assert.equal(
            rejected.db.prepare("SELECT state FROM outbox WHERE attempt_id=?").get(`${taskKey}/4`)!
              .state,
            "PENDING",
          );
          rejected.db
            .prepare("UPDATE review_runs SET result_json=? WHERE attempt_id=?")
            .run(resultJson, oldId);
          await rejectedEngine.tick();
          assert.equal(sent, 1);
          assert.equal(rejected.latest(taskKey)!.run_accepted, 1);
          assert.equal(rejected.latest(taskKey)!.status, "RUNNING");
          assert.equal(
            rejected.db.prepare("SELECT count(*) AS n FROM events WHERE kind='SEND_BEGIN'").get()!
              .n,
            1,
          );
          assert.equal(rejected.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 2);
          assert.equal(rejected.task(taskKey)!.rework, 3);
          assert.deepEqual(rejected.attempt(oldId), originalAttempt);
          assert.deepEqual(
            rejected.db.prepare("SELECT * FROM turn_checks WHERE attempt_id=?").get(oldId),
            oldChecks,
          );
          assert.deepEqual(
            rejected.db.prepare("SELECT * FROM review_runs WHERE attempt_id=?").get(oldId),
            oldReview,
          );
          assert.deepEqual(
            rejected.db.prepare("SELECT * FROM reviews WHERE attempt_id=?").get(oldId),
            oldFinalization,
          );
          sent = 0;
        } finally {
          rejected.close();
        }
        await state.backupTo(noExtensionFile);
        const noExtension = new Store(noExtensionFile);
        const repairFile = path.join(worktreePath, "src", "in-progress.ts");
        const originalSource = readFileSync(repairFile);
        try {
          const { additionalAllowedPath: _additionalPath, ...inScopeRequest } = request;
          const existingScopeRequest = {
            ...inScopeRequest,
            checks: {
              build: contract.checks.build,
              test: [
                process.execPath,
                "-e",
                "process.exit(require('node:fs').readFileSync('src/in-progress.ts','utf8').includes('terminal-second-round-fixed') ? 0 : 1)",
              ],
            },
          };
          let existingScopeSends = 0;
          const existingScopeEngine = new Engine(noExtension, repairConfig, {
            ...repairProvider,
            run: async (id, prompt) => {
              assert.equal(id, originalAttempt.agent_id);
              assert.match(prompt, /src\/in-progress.ts/);
              assert.match(prompt, /Finish the objective/);
              existingScopeSends++;
              if (existingScopeSends === 2)
                writeFileSync(
                  repairFile,
                  Buffer.concat([
                    originalSource,
                    Buffer.from("\n// terminal-second-round-fixed\n"),
                  ]),
                );
              return {
                ...snapshot,
                status: "running",
                foregroundActive: true,
                turnComplete: false,
              };
            },
          });
          for (const invalidPath of [null, ""]) {
            assert.throws(() =>
              noExtension.approveTerminalRepair(
                taskKey,
                { ...existingScopeRequest, additionalAllowedPath: invalidPath },
                "repair within existing scope",
              ),
            );
          }
          noExtension.approveTerminalRepair(
            taskKey,
            existingScopeRequest,
            "one repair within existing scope",
          );
          assert.equal(
            noExtension.terminalRepairGrant(taskKey)!.approvedScopeRevision,
            request.scopeRevision,
          );
          await assert.rejects(
            () => existingScopeEngine.continueExisting(taskKey, repair),
            /CONTINUATION_REVIEW_BINDING_MISMATCH/,
            "omitting an extension cannot authorize the external manifest finding",
          );
          const result = await existingScopeEngine.continueExisting(taskKey, {
            diffHash: originalDiff.diffHash,
            findings: [{ ...reviewerFinding, file: "src/in-progress.ts" }],
          });
          assert.deepEqual(result, {
            agentId: originalAttempt.agent_id,
            continued: false,
            delivery: "pending",
            attemptId: `${taskKey}/4`,
          });
          const next = noExtension.latest(taskKey)!;
          assert.equal(next.fence, originalAttempt.fence + 1);
          assert.equal(next.agent_id, originalAttempt.agent_id);
          assert.equal(next.session_key, originalAttempt.session_key);
          assert.equal(noExtension.scopeRevision(repairContract), request.scopeRevision);
          assert.deepEqual(noExtension.scopePaths(repairContract), repairContract.allowedPaths);
          assert.equal(
            noExtension.db
              .prepare(
                "SELECT count(*) AS n FROM events WHERE kind LIKE 'OPERATOR_SCOPE_EXTENSION:%'",
              )
              .get()!.n,
            0,
          );
          await existingScopeEngine.tick();
          assert.equal(existingScopeSends, 1, "normal delivery uses the same approved scope");
          assert.equal(noExtension.latest(taskKey)!.run_accepted, 1);
          assert.deepEqual(noExtension.attempt(oldId), originalAttempt);
          assert.deepEqual(
            noExtension.db.prepare("SELECT * FROM reviews WHERE attempt_id=?").get(oldId),
            originalReview,
          );
          assert.equal(noExtension.task(taskKey)!.rework, 3);
          await assert.rejects(
            () => existingScopeEngine.continueExisting(taskKey, repair),
            /ALREADY_CONSUMED/,
          );
          assert.equal(noExtension.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 2);
          const firstGrant = noExtension.terminalRepairGrant(taskKey)!;
          const firstConsumption = noExtension.db
            .prepare("SELECT * FROM events WHERE kind=?")
            .get(`TERMINAL_REPAIR_CONSUMED:${hash(firstGrant)}`);
          await existingScopeEngine.acceptSnapshot(next.id, snapshot);
          await assert.rejects(
            () => existingScopeEngine.advance(next.id),
            /Build, tests and scope must pass before review/,
          );
          const failedExtra = noExtension.attempt(next.id);
          assert.equal(failedExtra.status, "FAILED");
          assert.equal(noExtension.task(taskKey)!.state, "BLOCKED");
          assert.equal(noExtension.task(taskKey)!.rework, 4);
          const extraChecks = noExtension.db
            .prepare("SELECT * FROM turn_checks WHERE attempt_id=?")
            .get(next.id)!;
          const extraReview = noExtension.db
            .prepare("SELECT * FROM reviews WHERE attempt_id=?")
            .get(next.id)!;
          assert.equal(JSON.parse(String(extraChecks.result_json)).build.exit, 0);
          assert.equal(JSON.parse(String(extraChecks.result_json)).test.exit, 1);
          const nextRepair = {
            diffHash: String(extraChecks.diff_hash),
            findings: [{ ...reviewerFinding, file: "src/in-progress.ts" }],
          };
          await assert.rejects(
            () => existingScopeEngine.continueExisting(taskKey, nextRepair),
            /TERMINAL_REPAIR_(?:GRANT_REQUIRED|ALREADY_CONSUMED)/,
          );
          await existingScopeEngine.tick();
          assert.equal(existingScopeSends, 1, "a failed extra round cannot restart automatically");
          assert.equal(noExtension.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 2);
          assert.throws(
            () =>
              noExtension.approveTerminalRepair(
                taskKey,
                existingScopeRequest,
                "replay old approval",
              ),
            /ALREADY_GRANTED/,
          );
          const nextRequest = {
            ...existingScopeRequest,
            predecessorAttemptId: failedExtra.id,
            predecessorFence: failedExtra.fence,
            diffHash: String(extraChecks.diff_hash),
            checkEvidenceSha256: createHash("sha256")
              .update(String(extraChecks.result_json))
              .digest("hex"),
            scopeRevision: noExtension.scopeRevision(repairContract),
            checkRevision: noExtension.checkRevision(repairContract),
          };
          const eventsBeforeNativeMismatch = noExtension.db
            .prepare("SELECT count(*) AS n FROM events")
            .get()!.n;
          const outboxBeforeNativeMismatch = noExtension.db
            .prepare("SELECT * FROM outbox ORDER BY attempt_id")
            .all();
          observedSession = "replacement-native-session";
          await sdkProvider.refresh("writer-old");
          assert.equal(sdkProvider.nativeSessionId("writer-old"), observedSession);
          assert.throws(
            () =>
              noExtension.approveTerminalRepair(
                taskKey,
                { ...nextRequest, nativeSessionId: observedSession },
                "new approval cannot move the historical worker session",
              ),
            /TERMINAL_REPAIR_SESSION_CHANGED/,
          );
          assert.equal(
            noExtension.db.prepare("SELECT count(*) AS n FROM events").get()!.n,
            eventsBeforeNativeMismatch,
          );
          assert.deepEqual(noExtension.terminalRepairGrant(taskKey), firstGrant);
          assert.deepEqual(noExtension.attempt(failedExtra.id), failedExtra);
          assert.equal(noExtension.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 2);
          assert.equal(noExtension.scopeRevision(repairContract), request.scopeRevision);
          assert.deepEqual(
            noExtension.db.prepare("SELECT * FROM outbox ORDER BY attempt_id").all(),
            outboxBeforeNativeMismatch,
          );
          observedSession = nativeSessionId;
          await sdkProvider.refresh("writer-old");
          noExtension.approveTerminalRepair(
            taskKey,
            nextRequest,
            "new explicit approval for latest failed round",
          );
          assert.throws(
            () =>
              noExtension.approveTerminalRepair(taskKey, nextRequest, "replace pending approval"),
            /ALREADY_GRANTED/,
          );
          assert.throws(
            () =>
              noExtension.approveTerminalRepair(taskKey, existingScopeRequest, "stale predecessor"),
            /ALREADY_GRANTED|BINDING_CHANGED/,
          );
          assert.deepEqual(await existingScopeEngine.continueExisting(taskKey, nextRepair), {
            agentId: originalAttempt.agent_id,
            continued: false,
            delivery: "pending",
            attemptId: `${taskKey}/5`,
          });
          const secondExtra = noExtension.latest(taskKey)!;
          assert.equal(secondExtra.agent_id, failedExtra.agent_id);
          assert.equal(secondExtra.session_key, failedExtra.session_key);
          assert.equal(secondExtra.fence, failedExtra.fence + 1);
          assert.equal(
            noExtension.terminalRepairForAttempt(secondExtra.id)!.nativeSessionId,
            nativeSessionId,
          );
          assert.deepEqual(noExtension.terminalRepairForAttempt(next.id), firstGrant);
          assert.deepEqual(
            noExtension.db
              .prepare("SELECT * FROM events WHERE kind=?")
              .get(`TERMINAL_REPAIR_CONSUMED:${hash(firstGrant)}`),
            firstConsumption,
          );
          assert.deepEqual(noExtension.attempt(oldId), originalAttempt);
          assert.deepEqual(noExtension.attempt(next.id), failedExtra);
          assert.deepEqual(
            noExtension.db.prepare("SELECT * FROM reviews WHERE attempt_id=?").get(next.id),
            extraReview,
          );
          assert.deepEqual(
            noExtension.db.prepare("SELECT * FROM turn_checks WHERE attempt_id=?").get(next.id),
            extraChecks,
          );
          assert.equal(noExtension.scopeRevision(repairContract), request.scopeRevision);
          assert.deepEqual(noExtension.checkCommands(repairContract), existingScopeRequest.checks);
          await existingScopeEngine.tick();
          assert.equal(
            existingScopeSends,
            2,
            "only the newly approved successor is delivered once",
          );
          assert.equal(noExtension.attempt(secondExtra.id).run_accepted, 1);
          assert.equal(noExtension.task(taskKey)!.rework, 4);
          assert.equal(noExtension.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 3);
          assert.throws(
            () =>
              noExtension.approveTerminalRepair(taskKey, nextRequest, "replay consumed approval"),
            /ALREADY_GRANTED/,
          );
          noExtension.observe(secondExtra.id, "NEEDS_CONFIRMATION");
          await assert.rejects(
            () => existingScopeEngine.continueExisting(taskKey),
            /ALREADY_CONSUMED/,
            "a consumed terminal successor cannot use generic continuation",
          );
          assert.equal(existingScopeSends, 2);
          assert.equal(noExtension.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 3);
        } finally {
          writeFileSync(repairFile, originalSource);
          noExtension.close();
        }
        assert.throws(
          () =>
            state.approveTerminalRepair(taskKey, { ...request, predecessorFence: 2 }, "one repair"),
          /BINDING_CHANGED/,
        );
        state.approveTerminalRepair(taskKey, request, "one explicitly approved repair");
        changedSession = true;
        await assert.rejects(
          () => repairEngine.continueExisting(taskKey, repair),
          /TERMINAL_REPAIR_SESSION_CHANGED/,
        );
        changedSession = false;
        observedSession = nativeSessionId;
        race = true;
        await assert.rejects(
          () => repairEngine.continueExisting(taskKey, repair),
          /CHECK_EVIDENCE_CHANGED/,
        );
        race = false;
        state.db
          .prepare("UPDATE turn_checks SET result_json=? WHERE attempt_id=?")
          .run(checkJson, oldId);
        state.db.exec(
          "CREATE TRIGGER reject_terminal_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'fixture-claim-failed'); END",
        );
        await assert.rejects(
          () => repairEngine.continueExisting(taskKey, repair),
          /fixture-claim-failed/,
        );
        state.db.exec("DROP TRIGGER reject_terminal_outbox");
        assert.equal(state.latest(taskKey)?.id, oldId);
        assert.equal(state.db.prepare("SELECT count(*) AS n FROM leases").get()!.n, 0);
        assert.equal(
          state.db
            .prepare(
              "SELECT count(*) AS n FROM events WHERE kind LIKE 'TERMINAL_REPAIR_CONSUMED:%' OR kind LIKE 'OPERATOR_SCOPE_EXTENSION:%' OR kind LIKE 'OPERATOR_CHECK_COMMANDS:%'",
            )
            .get()!.n,
          0,
          "failed claims roll back grant consumption and scope/check projections",
        );
        assert.equal(sent, 0);
        assert.deepEqual(await repairEngine.continueExisting(taskKey, repair), {
          agentId: "writer-old",
          continued: false,
          delivery: "pending",
          attemptId: `${taskKey}/4`,
        });
        const successor = state.latest(taskKey)!;
        assert.equal(sent, 0, "the main RPC returns before delivery starts");
        assert.equal(successor.status, "INTENT");
        assert.equal(successor.run_accepted, 0);
        assert.equal(
          state.db.prepare("SELECT state FROM outbox WHERE attempt_id=?").get(successor.id)!.state,
          "PENDING",
        );
        assert.equal(successor.id, `${taskKey}/4`);
        assert.equal(successor.agent_id, originalAttempt.agent_id);
        assert.equal(successor.fence, 4, "a missing lease must not reset the predecessor fence");
        assert.equal(successor.session_key, originalAttempt.session_key);
        assert.equal(state.task(taskKey)?.rework, 3);
        assert.deepEqual(state.scopePaths(repairContract), [
          ...repairContract.allowedPaths,
          "tests/manifest.ts",
        ]);
        assert.deepEqual(state.checkCommands(repairContract), contract.checks);
        assert.deepEqual(state.attempt(oldId), originalAttempt);
        assert.deepEqual(
          state.db.prepare("SELECT * FROM reviews WHERE attempt_id=?").get(oldId),
          originalReview,
        );
        assert.equal(
          state.db.prepare("SELECT result_json FROM turn_checks WHERE attempt_id=?").get(oldId)!
            .result_json,
          checkJson,
        );
        await assert.rejects(
          () => repairEngine.continueExisting(taskKey, repair),
          /ALREADY_CONSUMED/,
        );
        dispatchAllowed = false;
        await repairEngine.tick();
        assert.equal(sent, 0, "revoked dispatch authority blocks the pending delivery");
        assert.equal(state.attempt(successor.id).status, "INTENT");
        dispatchAllowed = true;
        const pendingTask = { ...state.task(taskKey)! };
        const consumedGrant = state.terminalRepairGrant(taskKey);
        observedSession = "different-native-session-before-send";
        await assert.rejects(
          () => repairEngine.deliver(successor.id),
          /TERMINAL_REPAIR_DELIVERY_BINDING_CHANGED/,
        );
        assert.equal(sent, 0);
        assert.equal(
          state.attempt(successor.id).status,
          "INTENT",
          "a pre-send session failure must not poison the pending outbox",
        );
        assert.equal(state.attempt(successor.id).run_accepted, 0);
        assert.equal(
          state.db.prepare("SELECT state FROM outbox WHERE attempt_id=?").get(successor.id)!.state,
          "PENDING",
        );
        assert.equal(state.task(taskKey)!.rework, 3);
        assert.deepEqual({ ...state.task(taskKey)! }, pendingTask);
        assert.deepEqual(
          state.terminalRepairGrant(taskKey),
          consumedGrant,
          "a pre-send failure neither regrants nor consumes another exception",
        );
        assert.equal(state.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 2);
        assert.equal(
          state.db
            .prepare("SELECT count(*) AS n FROM events WHERE attempt_id=? AND kind='SEND_BEGIN'")
            .get(successor.id)!.n,
          0,
        );
        observedSession = nativeSessionId;

        // Fork the private fixture before send; an ambiguous outcome must never
        // be reset to pending just to exercise the successful branch below.
        const uncertainFile = path.join(root, "terminal-uncertain-send.sqlite");
        await state.backupTo(uncertainFile);
        const uncertain = new Store(uncertainFile);
        let unknownSends = 0;
        try {
          const uncertainEngine = new Engine(uncertain, repairConfig, {
            ...repairProvider,
            run: async () => {
              unknownSends++;
              throw Error("fixture-send-outcome-unknown");
            },
          });
          await uncertainEngine.deliver(successor.id);
          assert.equal(uncertain.attempt(successor.id).status, "NEEDS_CONFIRMATION");
          assert.equal(
            uncertain.db.prepare("SELECT state FROM outbox WHERE attempt_id=?").get(successor.id)!
              .state,
            "SENDING",
          );
          await uncertainEngine.tick();
          await uncertainEngine.deliver(successor.id);
          assert.equal(
            unknownSends,
            1,
            "an unknown post-beginSend outcome cannot cause a second send",
          );
          assert.equal(uncertain.latest(taskKey)!.id, successor.id);
        } finally {
          uncertain.close();
        }
        await repairEngine.tick();
        assert.equal(sent, 1, "the normal tick delivers the already claimed successor once");
        assert.equal(state.latest(taskKey)!.id, successor.id);
        assert.equal(state.attempt(successor.id).run_accepted, 1);
        assert.equal(state.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 2);
        assert.equal(state.db.prepare("SELECT count(*) AS n FROM leases").get()!.n, 1);
        await repairEngine.acceptSnapshot(successor.id, snapshot);
        await repairEngine.advance(successor.id);
        const fresh = state.db
          .prepare("SELECT diff_hash,result_json FROM turn_checks WHERE attempt_id=?")
          .get(successor.id)!;
        assert.notEqual(fresh.diff_hash, originalDiff.diffHash);
        assert.equal(
          JSON.parse(String(fresh.result_json)).build.exit,
          0,
          "the successor actually runs fresh supervised checks",
        );
        assert.deepEqual(reviews, [{ key: `${successor.id}/review`, diff: fresh.diff_hash }]);
        assert.equal(
          state.task(taskKey)?.state,
          "BLOCKED",
          "another failure grants no automatic repair round",
        );
        assert.equal(state.task(taskKey)?.rework, 4);
        assert.equal(sent, 1);
        assert.throws(
          () => state.approveTerminalRepair(taskKey, request, "again"),
          /ALREADY_GRANTED/,
        );
        await repairEngine.tick();
        assert.equal(sent, 1);
      } finally {
        state.close();
      }
    },
  );
});
