import { test } from "node:test";
import assert from "node:assert/strict";
import { CurrentPaseoCompletion, OptionalBackgroundCapability } from "../src/completion.ts";
import { parseAgentJson, reviewResultSchema, contractSchema } from "../src/contracts.ts";
import type { Snapshot } from "../src/provider.ts";
import { PaseoProvider, taskPrompt } from "../src/provider.ts";

// Fault: an absent/failed process inventory or a completed foreground turn releases
// a writer while work continues. Existing starter tests cannot exercise SDK capabilities.
test("completion distinguishes foreground settlement, known work and missing process coverage", async () => {
  let complete = true;
  const capability = new CurrentPaseoCompletion({
    foregroundEvidence: async () => ({ complete, traceHash: "trace", toolCount: 1 }),
  });
  const snapshot = {
    id: "agent",
    status: "idle",
    turnComplete: true,
    foregroundActive: false,
    backgroundActive: false,
  } as Snapshot;
  assert.equal((await capability.assess(snapshot)).state, "VERIFY");
  for (const [change, expected] of [
    [{ backgroundActive: true, status: "running" }, "WAITING_PROCESSES"],
    [{ backgroundActive: null }, "NEEDS_CONFIRMATION"],
    [{ status: "unknown", turnComplete: false }, "NEEDS_CONFIRMATION"],
    [{ status: "running", turnComplete: false, foregroundActive: true }, "RUNNING"],
    [{ status: "permission" }, "PERMISSION"],
  ] as const)
    assert.equal((await capability.assess({ ...snapshot, ...change })).state, expected);
  complete = false;
  assert.equal((await capability.assess(snapshot)).state, "NEEDS_CONFIRMATION");
});

test("optional documented SDK capability never substitutes failed reads with an empty inventory", async () => {
  assert.deepEqual(await new OptionalBackgroundCapability({}).inventory(), {
    supported: false,
    verified: false,
    items: [],
  });
  assert.equal(
    (
      await new OptionalBackgroundCapability({
        backgroundWork: { list: async () => [] },
      }).inventory()
    ).verified,
    false,
    "cached empty work is not a fresh completion observation",
  );
  let fail = false,
    stopped = 0,
    items: unknown[] = [{ id: "shell" }];
  let sessionId = "session",
    runningSubagent = false;
  const capability = new OptionalBackgroundCapability({
    id: "agent",
    runtimeInfo: { sessionId: "session" },
    backgroundWork: {
      list: async () => {
        if (fail) throw Error("incompatible daemon");
        return items;
      },
      refresh: async () => {
        if (fail) throw Error("fresh query failed");
        return {
          agentId: "agent",
          providerSessionId: sessionId,
          observationId: "fresh",
          coverage: "codex_background_terminals",
          queriedProviderSessionIds: [sessionId],
          items,
          providerSubagents: runningSubagent ? [{ id: "child", status: "running" }] : [],
        };
      },
      subscribe: (listener, options) => {
        if (fail) options?.onError?.(Error("disconnected"));
        else listener(items);
        return () => {};
      },
      stop: async () => {
        stopped++;
      },
    },
  });
  assert.equal((await capability.inventory()).items.length, 1);
  items = [];
  assert.equal((await capability.inventory()).verified, true);
  runningSubagent = true;
  assert.equal(
    (await capability.inventory()).items.length,
    1,
    "known running subagents block settlement",
  );
  runningSubagent = false;
  sessionId = "another-session";
  assert.equal(
    (await capability.inventory()).verified,
    false,
    "another session cannot prove this worker settled",
  );
  sessionId = "session";
  fail = true;
  assert.deepEqual(await capability.inventory(), { supported: true, verified: false, items: [] });
  let errors = 0,
    deliveries = 0;
  capability.subscribe(
    () => {
      deliveries++;
    },
    () => {
      errors++;
    },
  )();
  assert.equal(errors, 1);
  assert.equal(deliveries, 0);
  assert.equal(stopped, 0);
  await capability.stop({ id: "shell" });
  assert.equal(stopped, 1);
});

// Observed live reviewer output has a leading Markdown rule. Reject arbitrary prose
// rather than treating an embedded, unbound JSON fragment as the review verdict.
test("structured review accepts the observed SDK wrapper and rejects unbound or invalid verdicts", () => {
  const result = { diffHash: "a".repeat(64), pass: true, unresolvedIssues: 0 },
    json = JSON.stringify(result);
  for (const text of [json, "\n\n---\n\n" + json, "```json\n" + json + "\n```"])
    assert.deepEqual(parseAgentJson(text, reviewResultSchema), result);
  for (const text of ["Other text " + json, json + "\nOther text", '{"pass":true}'])
    assert.equal(parseAgentJson(text, reviewResultSchema), undefined);
  const contract = contractSchema.parse({
    workflowId: "review",
    taskId: "schema",
    repository: process.cwd(),
    worktree: process.cwd(),
    baseCommit: "b".repeat(40),
    role: "reviewer",
    prompt: "Review the owned implementation",
    acceptance: ["Implementation is complete"],
    allowedPaths: ["src"],
    requiredCapabilities: ["code"],
    minTier: 3,
    mutation: false,
    highRisk: false,
    uiChanged: false,
    reviewDiffHash: result.diffHash,
    implementationAgentId: "original-writer",
    checks: { build: [process.execPath, "--version"], test: [process.execPath, "--version"] },
  });
  const prompt = taskPrompt(contract);
  const emittedSchema = prompt.match(/^Review output schema:\n(.+)$/m)?.[1];
  assert.ok(
    emittedSchema,
    "native reviewers must receive the typed output contract, not only key names",
  );
  assert.equal(JSON.parse(emittedSchema).properties.unresolvedIssues.type, "integer");
  const example = prompt.match(/^Review output example:\n(.+)$/m)?.[1];
  assert.ok(example);
  const parsed = parseAgentJson(example, reviewResultSchema)!;
  assert.equal(parsed.diffHash, result.diffHash);
  assert.equal(parsed.pass, false);
  assert.equal(parsed.unresolvedIssues, 1);
  assert.equal(
    parseAgentJson(
      JSON.stringify({ ...parsed, unresolvedIssues: ["Missing implementation"] }),
      reviewResultSchema,
    ),
    undefined,
    "native arrays remain invalid instead of being silently normalized",
  );
});

test("recovery reconciles a completed turn through public waitForFinish despite projected running", async () => {
  let waits = 0;
  const agent = {
    cwd: process.cwd(),
    provider: "codex",
    model: "gpt-6.1-sol",
    status: "running",
    activeTurn: null,
    pendingPermissions: [],
    runtimeInfo: { sessionId: "session", thinkingOptionId: "high", modeId: "auto-review" },
  };
  const handle = {
    id: "agent",
    runtimeInfo: agent.runtimeInfo,
    refresh: async () => ({ agent }),
    backgroundWork: {
      refresh: async () => ({
        agentId: "agent",
        providerSessionId: "session",
        observationId: "fresh",
        coverage: "codex_background_terminals",
        queriedProviderSessionIds: ["session"],
        items: [{ id: "shell" }],
        providerSubagents: [],
      }),
    },
    waitForFinish: async () => {
      waits++;
      return { status: "idle", final: agent };
    },
  };
  const provider: PaseoProvider = Object.assign(Object.create(PaseoProvider.prototype), {
    client: { agents: { ref: () => handle } },
  });
  const snapshot = await provider.refresh("agent");
  assert.equal(waits, 1);
  assert.equal(snapshot?.turnComplete, true);
  assert.equal(snapshot?.status, "running");
  assert.equal(snapshot?.backgroundActive, true);
});

// Upstream retry rows persist across turns. An old failed/canceled informational
// row must not poison a later settled turn, or impersonate process completion.
test("native Codex retry history settles only terminal rows with exact provenance", async () => {
  const agent = {
    cwd: process.cwd(),
    provider: "codex",
    status: "idle",
    activeTurn: null,
    pendingPermissions: [],
    runtimeInfo: { sessionId: "codex-native" },
  };
  const retry = {
    type: "tool_call",
    callId: "older-retry",
    name: "codex_retry",
    status: "completed",
    detail: { type: "plain_text", label: "Reconnected" },
    metadata: { synthetic: true, source: "codex_stream_retry" },
  };
  const checkedShell = {
    type: "tool_call",
    callId: "later-check",
    name: "shell",
    status: "completed",
    detail: { type: "shell", command: "node check.mjs", exitCode: 0, output: "ok" },
  };
  let row: unknown = retry;
  const handle = {
    id: "codex-agent",
    status: "idle",
    activeTurn: null,
    pendingPermissions: [],
    runtimeInfo: agent.runtimeInfo,
    current: () => agent,
    refresh: async () => ({ agent }),
    waitForFinish: async () => ({ status: "idle", final: agent }),
    timeline: {
      refetch: async () => ({
        entries: [row, checkedShell].map((item) => ({ item })),
        error: null,
        gap: false,
        hasOlder: false,
        hasNewer: false,
      }),
    },
    backgroundWork: {
      refresh: async () => ({
        agentId: "codex-agent",
        providerSessionId: "codex-native",
        observationId: "fresh",
        coverage: "codex_background_terminals",
        queriedProviderSessionIds: ["codex-native"],
        items: [],
        providerSubagents: [],
      }),
    },
  };
  const provider: PaseoProvider = Object.assign(Object.create(PaseoProvider.prototype), {
    client: { agents: { ref: () => handle } },
  });
  const assess = async () =>
    new CurrentPaseoCompletion(provider).assess((await provider.refresh(handle.id))!);
  for (const status of ["completed", "failed", "canceled"]) {
    row = {
      ...retry,
      status,
      detail: {
        ...retry.detail,
        label: status === "completed" ? "Reconnected" : "Earlier connection lost",
      },
    };
    assert.equal((await assess()).state, "VERIFY", `historical ${status} native retry is settled`);
  }
  assert.equal((await provider.foregroundEvidence(handle.id)).toolCount, 2);
  for (const invalid of [
    { ...retry, status: "running" },
    { ...retry, metadata: undefined },
    { ...retry, metadata: { ...retry.metadata, synthetic: false } },
    { ...retry, metadata: { ...retry.metadata, source: "user-text" } },
  ]) {
    row = invalid;
    assert.equal((await assess()).state, "NEEDS_CONFIRMATION");
  }
  row = retry;
  agent.provider = "opencode";
  assert.equal(
    (await assess()).state,
    "NEEDS_CONFIRMATION",
    "a foreign provider cannot supply native Codex retry evidence",
  );
});

// Native Bash reports terminal tool_result/is_error, not a numeric exit code.
// Exercise the real provider foreground scan and completion assessor together.
test("native Claude Bash and structured notifications settle only under their matching fresh process proof", async () => {
  const sessionId = "native-session",
    generation = "native-generation";
  let active = false;
  const agent = {
    cwd: process.cwd(),
    provider: "claude-private",
    model: "claude-haiku-5-5",
    status: "idle",
    activeTurn: null,
    pendingPermissions: [],
    runtimeInfo: {
      sessionId,
      extra: { backgroundWorkGeneration: generation },
      modeId: "auto",
      thinkingOptionId: "medium",
    },
  };
  const native = { providerSessionId: sessionId, queryGeneration: generation };
  const shell = {
    type: "tool_call",
    callId: "bash",
    name: "Bash",
    status: "completed",
    detail: { type: "shell", command: "node -e \"process.stdout.write('ok')\"", output: "ok" },
    metadata: {
      claudeNativeResult: { ...native, kind: "tool_result", toolUseId: "bash", isError: false },
    },
  };
  const notification = {
    type: "tool_call",
    callId: "notification",
    name: "task_notification",
    status: "completed",
    detail: { type: "plain_text", text: "Finished" },
    metadata: {
      source: "claude_task_notification",
      taskId: "job",
      claudeNativeResult: { ...native, kind: "task_notification", taskId: "job" },
    },
  };
  let tools: unknown[] = [shell, notification];
  let timelineObserved = false;
  let appendUnsafeDuringReadback = false;
  const handle = {
    id: "agent",
    status: "idle",
    activeTurn: null,
    pendingPermissions: [],
    runtimeInfo: agent.runtimeInfo,
    current: () => agent,
    refresh: async () => ({ agent }),
    timeline: {
      refetch: async () => {
        timelineObserved = true;
        return {
          entries: tools.map((item) => ({ item })),
          error: null,
          gap: false,
          hasOlder: false,
          hasNewer: false,
        };
      },
    },
    backgroundWork: {
      refresh: async () => {
        if (timelineObserved && appendUnsafeDuringReadback) {
          tools = [
            ...tools,
            {
              ...shell,
              callId: "unsafe",
              detail: { ...shell.detail, command: "Start-Process detached.exe" },
              metadata: {
                claudeNativeResult: { ...shell.metadata.claudeNativeResult, toolUseId: "unsafe" },
              },
            },
          ];
          appendUnsafeDuringReadback = false;
        }
        return {
          agentId: "agent",
          providerSessionId: sessionId,
          observationId: "fresh",
          coverage: "claude_background_tasks",
          queryGeneration: generation,
          foregroundActive: false,
          queriedProviderSessionIds: [sessionId],
          items: active ? [{ id: "job" }] : [],
          providerSubagents: [],
        };
      },
    },
    waitForFinish: async () => ({ status: "idle", final: agent }),
  };
  const provider: PaseoProvider = Object.assign(Object.create(PaseoProvider.prototype), {
    client: { agents: { ref: () => handle } },
  });
  const assess = async () =>
    new CurrentPaseoCompletion(provider).assess((await provider.refresh("agent"))!);
  assert.equal((await assess()).state, "VERIFY");
  active = true;
  assert.equal((await assess()).state, "WAITING_PROCESSES");
  active = false;
  for (const invalid of [
    { ...shell, metadata: undefined },
    {
      ...shell,
      metadata: {
        claudeNativeResult: {
          ...shell.metadata.claudeNativeResult,
          queryGeneration: "old-generation",
        },
      },
    },
    { ...notification, metadata: { ...notification.metadata, source: "user-text" } },
  ]) {
    tools = [invalid];
    assert.equal((await assess()).state, "NEEDS_CONFIRMATION");
  }
  tools = [shell, notification];
  timelineObserved = false;
  appendUnsafeDuringReadback = true;
  assert.equal(
    (await assess()).state,
    "NEEDS_CONFIRMATION",
    "a new unsafe shell during native readback cannot escape the foreground scan",
  );
});
