import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine.ts";
import { configSchema, contractSchema, type RuntimeRoute } from "../src/contracts.ts";
import type { CompletionCapability } from "../src/completion.ts";
import { PaseoProvider, type Discovery, type Provider, type Snapshot } from "../src/provider.ts";
import { Store } from "../src/store.ts";

test("review selection audits missing completion support and revalidates unsent intents", async () => {
  const worktree = process.cwd();
  const makeRoute = (
    id: string,
    provider: "claude" | "codex",
    model: string,
    reasoning: string,
    modeId: string,
    tier: 2 | 3,
  ) => ({
    id,
    access: provider === "claude" ? "claude-company-pro" : "codex-pro200",
    provider,
    model,
    revision: `profile-snapshot:${id}`,
    reasoning,
    tier,
    modeId,
    enabled: true,
    maxConcurrent: 2,
    dataScopes: ["company"],
    capabilities: ["code", "text"],
    ...(provider === "claude" ? { repositoryRoots: [worktree] } : {}),
  });
  const routes = [
    makeRoute("codex-implementation", "codex", "gpt-6.1-terra", "medium", "auto-review", 2),
    makeRoute("claude-opus", "claude", "claude-opus-5-5", "high", "plan", 3),
    makeRoute("codex-astra", "codex", "gpt-6-astra", "xhigh", "auto-review", 3),
    makeRoute("codex-sol", "codex", "gpt-6.1-sol", "high", "auto-review", 3),
  ];
  const config = configSchema.parse({
    schemaVersion: 1,
    daemonUrl: "ws://127.0.0.1:6767/ws",
    // Engine constructs Git eagerly; this fixture replaces its snapshot and check calls.
    gitExecutable: process.execPath,
    maxWorkflows: 2,
    maxRework: 2,
    apiEnabled: false,
    liveDispatchApproved: true,
    roleRoutes: {
      planner: ["codex-implementation"],
      advisor: ["codex-implementation"],
      "implement-simple": ["codex-implementation"],
      "implement-normal": ["codex-implementation"],
      "implement-complex": ["codex-implementation"],
      reviewer: ["claude-opus", "codex-astra", "codex-sol"],
    },
    budgets: {
      decisions: 5_000_000,
      implementation: 140_000_000,
      "premium-api": 40_000_000,
      emergency: 15_000_000,
    },
    routes,
  });
  const implementationRoute = config.routes.find((route) => route.id === "codex-implementation")!;
  const contract = contractSchema.parse({
    workflowId: "reviewer-capability-workflow",
    taskId: "reviewer-capability-task",
    repository: worktree,
    worktree,
    baseCommit: "a".repeat(40),
    dataScope: "company",
    role: "implement-normal",
    prompt: "Implementation fixture",
    acceptance: ["A reviewer is selected before dispatch"],
    allowedPaths: ["owned.txt"],
    requiredCapabilities: ["code"],
    minTier: 2,
    mutation: true,
    highRisk: false,
    uiChanged: false,
    checks: { build: ["unused"], test: ["unused"] },
  });
  const store = new Store(":memory:");
  const taskKey = store.add(contract, config);
  const attemptId = "reviewer-capability-attempt";
  const diffHash = "d".repeat(64);
  store.db
    .prepare(`INSERT INTO attempts(
    id,task_key,sequence,status,route_json,agent_id,fence,session_key,created_ms,result_hash,error_kind,reused,run_accepted
  ) VALUES(?,?,1,'VERIFY',?,?,1,'implementation-session',?,NULL,NULL,0,1)`)
    .run(
      attemptId,
      taskKey,
      JSON.stringify(implementationRoute),
      "implementation-agent",
      Date.now(),
    );

  const discoveries: Discovery[] = [
    {
      provider: "claude",
      status: "ready",
      models: [{ id: "claude-opus-5-5", thinking: ["high"] }],
      modes: ["plan"],
    },
    {
      provider: "codex",
      status: "ready",
      models: [
        { id: "gpt-6-astra", thinking: ["xhigh"] },
        { id: "gpt-6.1-sol", thinking: ["high"] },
      ],
      modes: ["auto-review"],
      supportsBackgroundWorkRefresh: true,
    },
    { provider: "pi", status: "loading", models: [], modes: [] },
  ];
  const publicEntries = [
    {
      provider: "claude",
      status: "ready",
      models: [{ id: "claude-opus-5-5", thinkingOptions: [{ id: "high" }] }],
      modes: [{ id: "plan" }],
    },
    {
      provider: "codex",
      status: "ready",
      models: [
        { id: "gpt-6-astra", thinkingOptions: [{ id: "xhigh" }] },
        { id: "gpt-6.1-sol", thinkingOptions: [{ id: "high" }] },
      ],
      modes: [{ id: "auto-review" }],
      capabilities: { supportsBackgroundWorkRefresh: true },
    },
    { provider: "pi", status: "loading", models: [], modes: [] },
  ];
  const providerAdapter = new PaseoProvider(config.daemonUrl);
  let publicWaitOptions: unknown;
  Object.assign(providerAdapter, {
    client: {
      providers: {
        waitForReady: async (options: unknown) => {
          publicWaitOptions = options;
          return { entries: publicEntries };
        },
      },
    },
  });
  const publicDiscovery = await providerAdapter.discover(worktree, true, ["claude", "codex"]);
  assert.deepEqual(publicWaitOptions, {
    cwd: worktree,
    timeoutMs: 30000,
    providers: ["claude", "codex"],
  });
  assert.equal(
    publicDiscovery.find((entry) => entry.provider === "codex")?.supportsBackgroundWorkRefresh,
    true,
  );
  assert.equal(
    publicDiscovery.find((entry) => entry.provider === "claude")?.supportsBackgroundWorkRefresh,
    undefined,
  );
  assert.equal(publicDiscovery.find((entry) => entry.provider === "pi")?.status, "loading");

  const discoveryRequests: Array<{ cwd: string; waitForAll: boolean; providers: string[] }> = [];
  const created: Array<{ routeId: string; skipSequence: number | null; lastSequence: number }> = [];
  const reviewerRoutes = new Map<string, RuntimeRoute>();
  let discoveryFailure = false;
  const skippedClaude = "REVIEW_ROUTE_SKIPPED:claude-opus:completion-boundary-unavailable";
  const implementation: Snapshot = {
    id: "implementation-agent",
    cwd: worktree,
    provider: "codex",
    model: "gpt-6.1-terra",
    status: "idle",
    contextFraction: null,
    backgroundActive: false,
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, billedMicroUsd: null },
    reasoning: "medium",
    modeId: "auto-review",
    turnComplete: true,
    foregroundActive: false,
  };
  const provider: Provider = {
    url: config.daemonUrl,
    authorize: async () => {},
    discover: async (cwd, waitForAll, providers) => {
      discoveryRequests.push({ cwd, waitForAll: !!waitForAll, providers: [...(providers ?? [])] });
      if (discoveryFailure) throw new Error("Timed out waiting for providers");
      return discoveries;
    },
    create: async (route) => {
      const id = `reviewer-agent-${created.length + 1}`;
      reviewerRoutes.set(id, route);
      const skip = store.db
        .prepare("SELECT sequence FROM events WHERE kind=? AND attempt_id=?")
        .get(skippedClaude, attemptId) as { sequence: number } | undefined;
      const latest = store.db
        .prepare("SELECT COALESCE(MAX(sequence),0) AS sequence FROM events")
        .get() as {
        sequence: number;
      };
      created.push({
        routeId: route.id,
        skipSequence: skip?.sequence ?? null,
        lastSequence: latest.sequence,
      });
      return id;
    },
    find: async () => [],
    refresh: async () => implementation,
    run: async () => {
      throw new Error("Unexpected implementation run");
    },
    wait: async (id) => {
      const route = reviewerRoutes.get(id)!;
      return {
        ...implementation,
        id,
        provider: route.provider,
        model: route.model,
        reasoning: route.reasoning,
        modeId: route.modeId ?? null,
        backgroundActive: null,
        reviewResult: { diffHash, pass: true, unresolvedIssues: 0, findings: [] },
      };
    },
  };
  const completion: CompletionCapability = {
    assess: async (snapshot) =>
      snapshot.id === "implementation-agent"
        ? { state: "VERIFY", reason: "implementation-complete" }
        : { state: "NEEDS_CONFIRMATION", reason: "review-native-evidence-missing" },
  };
  const engine = new Engine(store, config, provider, completion, undefined, () => true);
  Object.assign(engine, {
    validateSnapshot: () => {},
    runVerification: () => ({
      build: { exit: 0 },
      test: { exit: 0 },
      changed: false,
      scopeViolations: 0,
      diffCheckExit: 0,
    }),
  });
  Object.assign(engine.git, {
    snapshot: () => ({ diffHash, scopeViolations: 0, diffCheckExit: 0, files: [] }),
  });

  const first = await engine.review(attemptId);
  assert.equal(first.state, "NEEDS_CONFIRMATION", "review cannot complete without native evidence");
  assert.equal(
    created[0].routeId,
    "codex-astra",
    "Claude without public completion support is skipped",
  );
  assert.ok(created[0].skipSequence !== null && created[0].skipSequence <= created[0].lastSequence);
  assert.deepEqual(discoveryRequests[0], {
    cwd: worktree,
    waitForAll: true,
    providers: ["claude", "codex"],
  });
  assert.deepEqual(config.roleRoutes?.reviewer, ["claude-opus", "codex-astra", "codex-sol"]);
  assert.equal(
    JSON.parse(
      (
        store.db
          .prepare("SELECT route_json FROM review_runs WHERE attempt_id=?")
          .get(attemptId) as { route_json: string }
      ).route_json,
    ).id,
    "codex-astra",
  );

  store.db
    .prepare("DELETE FROM events WHERE attempt_id=? AND kind=?")
    .run(attemptId, skippedClaude);
  store.db
    .prepare(
      "UPDATE review_runs SET route_json=?,request_key=?,agent_id=NULL,state='INTENT',result_json=NULL WHERE attempt_id=?",
    )
    .run(
      JSON.stringify(config.routes.find((route) => route.id === "claude-opus")),
      `${attemptId}/legacy-intent`,
      attemptId,
    );
  const second = await engine.review(attemptId);
  assert.equal(second.state, "NEEDS_CONFIRMATION");
  assert.equal(
    created[1].routeId,
    "codex-astra",
    "an unsent Claude intent is revalidated before dispatch",
  );
  assert.ok(created[1].skipSequence !== null && created[1].skipSequence <= created[1].lastSequence);
  assert.equal(
    JSON.parse(
      (
        store.db
          .prepare("SELECT route_json FROM review_runs WHERE attempt_id=?")
          .get(attemptId) as { route_json: string }
      ).route_json,
    ).id,
    "codex-astra",
  );

  store.db
    .prepare("DELETE FROM events WHERE attempt_id=? AND kind=?")
    .run(attemptId, skippedClaude);
  store.db
    .prepare(
      "UPDATE review_runs SET route_json=?,request_key=?,agent_id=NULL,state='INTENT',result_json=NULL WHERE attempt_id=?",
    )
    .run(
      JSON.stringify(config.routes.find((route) => route.id === "claude-opus")),
      `${attemptId}/pending-intent`,
      attemptId,
    );
  discoveryFailure = true;
  const createCountBeforePendingDiscovery = created.length;
  const pending = await engine.review(attemptId);
  assert.deepEqual(pending, {
    state: "WAITING_PROVIDER_DISCOVERY",
    agentId: null,
    reason: "reviewer-provider-discovery-pending",
  });
  assert.equal(
    created.length,
    createCountBeforePendingDiscovery,
    "pending discovery does not dispatch a lower-priority reviewer",
  );
  const pendingRow = store.db
    .prepare("SELECT route_json,state,agent_id FROM review_runs WHERE attempt_id=?")
    .get(attemptId) as {
    route_json: string;
    state: string;
    agent_id: string | null;
  };
  assert.equal(JSON.parse(pendingRow.route_json).id, "claude-opus");
  assert.equal(pendingRow.state, "INTENT");
  assert.equal(pendingRow.agent_id, null);
  assert.equal(
    store.db
      .prepare("SELECT 1 FROM events WHERE kind=? AND attempt_id=?")
      .get(skippedClaude, attemptId),
    undefined,
  );
  store.close();
});
