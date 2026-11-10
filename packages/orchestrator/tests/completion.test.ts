import { test } from "node:test";
import assert from "node:assert/strict";
import { CurrentPaseoCompletion, OptionalBackgroundCapability } from "../src/completion.ts";
import { parseAgentJson, reviewResultSchema } from "../src/contracts.ts";
import type { Snapshot } from "../src/provider.ts";
import { PaseoProvider } from "../src/provider.ts";

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
