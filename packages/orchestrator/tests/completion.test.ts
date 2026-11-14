import { test } from "node:test";
import assert from "node:assert/strict";
import { CurrentPaseoCompletion, OptionalBackgroundCapability } from "../src/completion.ts";
import { parseAgentJson, reviewResultSchema, contractSchema } from "../src/contracts.ts";
import type { Snapshot } from "../src/provider.ts";
import { PaseoProvider, taskPrompt } from "../src/provider.ts";
import { createPaseoApi } from "@getpaseo/client";

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
test("structured review accepts the observed SDK wrapper and rejects unbound or invalid verdicts", async (t) => {
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
  await t.test(
    "public SDK recovery reads only the bound final logical message",
    async (caseContext) => {
      const failedReview = {
        diffHash: "d".repeat(64),
        pass: false,
        unresolvedIssues: 2,
        findings: [
          {
            severity: "P1",
            file: "src/a.ts",
            line: 3,
            problem: "Missing validation",
            requiredChange: "Validate the input",
          },
          {
            severity: "P2",
            file: "src/b.ts",
            line: 7,
            problem: "Missing result",
            requiredChange: "Return the result",
          },
        ],
      };
      let earlier = "The review is in progress.",
        latest = JSON.stringify(failedReview),
        reads = 0,
        sends = 0,
        quota = false,
        timelineUnavailable = false,
        warning: { provider: string; level: string; message: string } | undefined,
        warningAfterTurn = false,
        turnSequence: "single" | "two-turn" | "reappearing" | "missing" = "single",
        drift: "none" | "session" | "cursor" | "active-turn" = "none";
      const sdkAgent = () => ({
        id: "reviewer",
        cwd: process.cwd(),
        workspaceId: "fixture-workspace",
        provider: "codex",
        model: "gpt-6-astra",
        status: "idle",
        activeTurn: null,
        pendingPermissions: [],
        archivedAt: null,
        lastUsage: quota ? { inputTokens: 0, outputTokens: 0 } : undefined,
        lastUserMessageAt: "2026-11-13T20:00:00Z",
        runtimeInfo: { provider: "codex", sessionId: "native-review", modeId: "auto-review" },
      });
      function reviewMessageEntries() {
        let firstTurn: string | undefined = "old-turn";
        if (turnSequence === "single") firstTurn = "review-turn";
        if (turnSequence === "missing") firstTurn = undefined;
        const entries = [
          {
            provider: "codex",
            turnId: firstTurn,
            timestamp: "2026-11-13T20:00:01Z",
            seqStart: 2,
            seqEnd: 4,
            sourceSeqRanges: [{ startSeq: 2, endSeq: 4 }],
            collapsed: ["assistant_merge"],
            item: { type: "assistant_message", messageId: "commentary", text: earlier },
          },
          {
            provider: "codex",
            turnId: "review-turn",
            timestamp: "2026-11-13T20:00:02Z",
            seqStart: 5,
            seqEnd: 9,
            sourceSeqRanges: [{ startSeq: 5, endSeq: 9 }],
            collapsed: ["assistant_merge"],
            item: { type: "assistant_message", messageId: "final", text: latest },
          },
        ];
        if (turnSequence === "reappearing")
          entries.push({
            provider: "codex",
            turnId: "old-turn",
            timestamp: "2026-11-13T20:00:03Z",
            seqStart: 10,
            seqEnd: 11,
            sourceSeqRanges: [{ startSeq: 10, endSeq: 11 }],
            collapsed: ["assistant_merge"],
            item: {
              type: "assistant_message",
              messageId: "late-old-pass",
              text: JSON.stringify({
                ...failedReview,
                pass: true,
                unresolvedIssues: 0,
                findings: [],
              }),
            },
          });
        return entries;
      }
      // Only daemon transport is synthetic: ref(), wait/run, timeline refetch and
      // the per-handle current snapshot are the actual public SDK implementation.
      const api = createPaseoApi({
        getLastServerInfoMessage: () => ({ serverId: "fixture-server" }),
        fetchAgent: async () => ({ agent: sdkAgent() }),
        sendAgentMessage: async () => {
          sends++;
        },
        waitForFinish: async () => ({
          status: "idle",
          final: sdkAgent(),
          error: null,
          lastMessage: quota ? "You've hit your session limit. Try again later." : earlier + latest,
        }),
        fetchAgentTimeline: async () => {
          reads++;
          if (timelineUnavailable) throw Error("synthetic timeline unavailable");
          const agent = sdkAgent();
          if (reads === 2 && drift === "session") agent.runtimeInfo.sessionId = "other-native";
          const changedHead = reads === 2 && drift === "cursor";
          let headSeq = 9;
          if (changedHead) headSeq = 10;
          if (turnSequence === "reappearing") headSeq = 11;
          if (warning && warningAfterTurn) headSeq++;
          const notice = warning
            ? {
                provider: warning.provider,
                timestamp: "2026-11-13T20:00:00Z",
                seqStart: warningAfterTurn ? headSeq : 1,
                seqEnd: warningAfterTurn ? headSeq : 1,
                item: { type: "notification", level: warning.level, message: warning.message },
              }
            : undefined;
          const firstSeq = notice && !warningAfterTurn ? 1 : 2;
          return {
            agent:
              reads === 2 && drift === "active-turn"
                ? { ...agent, activeTurn: { id: "new-turn" } }
                : agent,
            agentId: "reviewer",
            projection: "projected",
            epoch: "fixture-epoch",
            reset: false,
            staleCursor: false,
            error: null,
            gap: false,
            hasOlder: false,
            hasNewer: false,
            window: { minSeq: firstSeq, maxSeq: headSeq, nextSeq: headSeq + 1 },
            startCursor: { epoch: "fixture-epoch", seq: firstSeq },
            endCursor: { epoch: "fixture-epoch", seq: headSeq },
            entries: [
              ...(notice && !warningAfterTurn ? [notice] : []),
              ...reviewMessageEntries(),
              ...(notice && warningAfterTurn ? [notice] : []),
            ],
          };
        },
        refreshAgentBackgroundWork: async () => ({
          agentId: "reviewer",
          providerSessionId: "native-review",
          observationId: "fresh",
          coverage: "codex_background_terminals",
          queriedProviderSessionIds: ["native-review"],
          items: [],
          providerSubagents: [],
        }),
      } as unknown as Parameters<typeof createPaseoApi>[0]);
      const provider = new PaseoProvider("ws://fixture.invalid/ws");
      Object.assign(provider, { client: { ...api, close: () => api.dispose() } });
      caseContext.after(() => provider.close());
      const recovered = (await provider.refresh("reviewer"))!;
      assert.deepEqual(
        recovered.reviewResult,
        failedReview,
        "commentary cannot corrupt the final FAIL and its findings",
      );
      assert.equal((await new CurrentPaseoCompletion(provider).assess(recovered)).state, "VERIFY");
      reads = 0;
      assert.deepEqual(
        (await provider.run("reviewer", "synthetic fixture only")).reviewResult,
        failedReview,
      );
      assert.equal(sends, 1);
      turnSequence = "two-turn";
      reads = 0;
      assert.deepEqual(
        (await provider.wait("reviewer")).reviewResult,
        failedReview,
        "an unambiguous A to B sequence preserves the final B FAIL",
      );
      await caseContext.test(
        "a reappearing old head turn cannot replace the newer FAIL",
        async () => {
          turnSequence = "reappearing";
          reads = 0;
          assert.equal(
            (await provider.wait("reviewer")).reviewResult,
            undefined,
            "A to B to A must not accept the delayed A PASS",
          );
        },
      );
      turnSequence = "missing";
      reads = 0;
      assert.equal(
        (await provider.wait("reviewer")).reviewResult,
        undefined,
        "turn-bearing rows without metadata remain ambiguous",
      );
      turnSequence = "single";
      earlier = JSON.stringify({ ...failedReview, pass: true, unresolvedIssues: 0, findings: [] });
      latest = "The newest response is invalid JSON.";
      reads = 0;
      assert.equal(
        (await provider.wait("reviewer")).reviewResult,
        undefined,
        "never select older valid JSON",
      );
      latest = JSON.stringify(failedReview);
      for (const change of ["session", "cursor", "active-turn"] as const) {
        reads = 0;
        drift = change;
        assert.equal(
          (await provider.wait("reviewer")).reviewResult,
          undefined,
          `${change} drift must block acceptance`,
        );
      }
      drift = "none";
      await caseContext.test(
        "only the exact leading unscoped Codex configuration warning is outside turns",
        async () => {
          const startup = {
            provider: "codex",
            level: "warning",
            message:
              "Under-development features enabled: fixture_feature. Under-development features are incomplete and may behave unpredictably. To suppress this warning, set `suppress_unstable_features_warning = true` in C:/fixture/config.toml",
          };
          warning = startup;
          reads = 0;
          assert.deepEqual(
            (await provider.wait("reviewer")).reviewResult,
            failedReview,
            "a known out-of-band startup warning must preserve the final FAIL/2",
          );
          for (const invalid of [
            {
              ...startup,
              message: "The rest of this Codex thread's history is too large to load.",
            },
            { ...startup, level: "error" },
            { ...startup, provider: "claude" },
            { ...startup, message: startup.message + "\n" },
          ]) {
            warning = invalid;
            reads = 0;
            assert.equal((await provider.wait("reviewer")).reviewResult, undefined);
          }
          warning = startup;
          warningAfterTurn = true;
          reads = 0;
          assert.equal((await provider.wait("reviewer")).reviewResult, undefined);
          warning = undefined;
          warningAfterTurn = false;
        },
      );
      await caseContext.test(
        "classified quota errors survive unavailable timeline reads",
        async () => {
          quota = true;
          timelineUnavailable = true;
          reads = 0;
          for (const method of ["wait", "run"] as const) {
            let operation: Promise<Snapshot>;
            if (method === "wait") operation = provider.wait("reviewer");
            else operation = provider.run("reviewer", "synthetic quota fixture");
            const [outcome] = await Promise.allSettled([operation]);
            assert.ok(
              outcome.status === "fulfilled",
              "the classified quota snapshot must be returned without reading timeline",
            );
            assert.equal(outcome.value.status, "error");
            assert.equal(outcome.value.failureKind, "quota-5h");
            assert.equal(outcome.value.turnComplete, false);
            assert.equal(outcome.value.reviewResult, undefined);
            assert.equal(
              reads,
              0,
              "a classified error must not start structured-result observation",
            );
          }
        },
      );
    },
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
test("native Codex foreground settles only exact terminal retries and bound read-only observations", async () => {
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
  const search = {
    type: "tool_call",
    callId: "read-only-search",
    name: "atlassian_x_tention.confluence_search",
    status: "completed",
    detail: {
      type: "unknown",
      input: { query: "fixture documentation", limit: 1 },
      output: { content: [] },
    },
  };
  row = search;
  assert.equal(
    (await provider.foregroundEvidence(handle.id)).complete,
    true,
    "a completed exact Confluence search does not leave unobserved process work",
  );
  assert.equal((await assess()).state, "VERIFY");
  for (const invalid of [
    { ...search, status: "running" },
    { ...search, name: "atlassian_x_tention.confluence_update_page" },
  ]) {
    row = invalid;
    assert.equal((await assess()).state, "NEEDS_CONFIRMATION");
  }
  // A returned activity query settles only the caller's observation. It does
  // not attest the observed agent's work or any runtime loaded by that query.
  const activity = {
    type: "tool_call",
    callId: "activity-query",
    name: "paseo.get_agent_activity",
    status: "completed",
    error: null,
    detail: {
      type: "unknown",
      input: { agentId: "observed-agent", limit: 2 },
      output: {
        content: [],
        _meta: null,
        structuredContent: {
          agentId: "observed-agent",
          updateCount: 2,
          currentModeId: "default",
          content: "Synthetic activity summary",
          serverId: "fixture-server",
        },
      },
    },
  };
  row = activity;
  assert.equal(
    (await provider.foregroundEvidence(handle.id)).complete,
    true,
    "a successful target-bound Paseo activity query is a settled caller observation",
  );
  assert.equal((await assess()).state, "VERIFY");
  for (const invalid of [
    { ...activity, status: "running" },
    { ...activity, status: "failed" },
    { ...activity, error: "reader-failed" },
    { ...activity, name: "paseo.send_agent_prompt" },
    {
      ...activity,
      detail: { ...activity.detail, input: { agentId: "observed-agent", limit: "2" } },
    },
    {
      ...activity,
      detail: { ...activity.detail, output: { ...activity.detail.output, isError: true } },
    },
    { ...activity, detail: { ...activity.detail, output: { content: [] } } },
    {
      ...activity,
      detail: {
        ...activity.detail,
        output: {
          ...activity.detail.output,
          structuredContent: {
            ...activity.detail.output.structuredContent,
            agentId: "another-agent",
          },
        },
      },
    },
    {
      ...activity,
      detail: {
        ...activity.detail,
        output: {
          ...activity.detail.output,
          structuredContent: { ...activity.detail.output.structuredContent, updateCount: "2" },
        },
      },
    },
  ]) {
    row = invalid;
    assert.equal((await assess()).state, "NEEDS_CONFIRMATION");
  }
  const issue = { id: "10001", key: "FIXTURE-1", summary: "Synthetic issue" };
  const issueText = JSON.stringify(issue);
  const jira = {
    type: "tool_call",
    callId: "jira-reader",
    name: "atlassian_x_tention.jira_get_issue",
    status: "completed",
    error: null,
    detail: {
      type: "unknown",
      input: { issue_key: "FIXTURE-1", fields: "summary", update_history: false },
      output: {
        content: [{ type: "text", text: issueText }],
        structuredContent: { result: issueText },
        _meta: {},
      },
    },
  };
  row = jira;
  assert.equal(
    (await assess()).state,
    "VERIFY",
    "the completed read-only Jira result must bind its exact target",
  );
  for (const invalid of [
    { ...jira, status: "running" },
    { ...jira, name: "atlassian_x_tention.jira_update_issue" },
    { ...jira, detail: { ...jira.detail, input: { ...jira.detail.input, update_history: true } } },
    { ...jira, detail: { ...jira.detail, input: { issue_key: "FIXTURE-1" } } },
    { ...jira, detail: { ...jira.detail, input: { ...jira.detail.input, issue_key: "OTHER-2" } } },
    { ...jira, detail: { ...jira.detail, input: { ...jira.detail.input, execute: true } } },
    { ...jira, detail: { ...jira.detail, output: { ...jira.detail.output, isError: true } } },
    {
      ...jira,
      detail: {
        ...jira.detail,
        output: {
          content: [{ type: "text", text: JSON.stringify({ ...issue, error: "Denied" }) }],
        },
      },
    },
    {
      ...jira,
      detail: {
        ...jira.detail,
        output: {
          ...jira.detail.output,
          structuredContent: { result: JSON.stringify({ ...issue, key: "OTHER-2" }) },
        },
      },
    },
    {
      ...jira,
      detail: {
        ...jira.detail,
        output: {
          ...jira.detail.output,
          content: [{ type: "text", text: "Invalid latest result" }],
        },
      },
    },
  ]) {
    row = invalid;
    assert.equal((await assess()).state, "NEEDS_CONFIRMATION");
  }
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
