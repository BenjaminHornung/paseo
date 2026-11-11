import {
  query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { expect, test } from "vitest";
import { ClaudeRuntimeSafety } from "./runtime-safety.js";
import { ClaudeBackgroundInventory } from "./background-inventory.js";
import { ClaudeAgentClient } from "./agent.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";

const message = (value: unknown) => value as SDKMessage;

// This uses the installed public SDK queue, not a fake Query implementation.
function inventorySdk(options?: {
  input: Parameters<typeof query>[0];
  inventory: ClaudeBackgroundInventory;
}) {
  const runtime = new ClaudeRuntimeSafety();
  const inventory = options?.inventory ?? new ClaudeBackgroundInventory();
  const output = new PassThrough();
  const child = new EventEmitter() as EventEmitter & SpawnedProcess;
  const state = {
    calls: 0,
    tasks: [] as { task_id: string; task_type: string; description: string }[],
    omit: false,
    userInputs: 0,
  };
  let buffered = "";
  const send = (frame: unknown) => {
    // Split even UTF-8 sequences across chunks; the SDK receives unchanged bytes.
    for (const byte of Buffer.from(JSON.stringify(frame) + "\n")) output.write(Buffer.from([byte]));
  };
  Object.assign(child, {
    stdout: output,
    killed: false,
    exitCode: null,
    kill: () => {
      output.end();
      child.emit("exit", 0, null);
      return true;
    },
    stdin: new Writable({
      write(chunk, _encoding, done) {
        buffered += chunk;
        let newline: number;
        while ((newline = buffered.indexOf("\n")) !== -1) {
          const frame = JSON.parse(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          if (frame.type === "user") state.userInputs++;
          if (frame.type !== "control_request" || frame.request.subtype !== "initialize") continue;
          state.calls++;
          send({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: frame.request_id,
              response: {
                commands: [],
                agents: [],
                models: [],
                account: {},
                output_style: "default",
                available_output_styles: [],
              },
            },
          });
          if (!state.omit)
            send({
              type: "system",
              subtype: "background_tasks_changed",
              session_id: "native-session",
              uuid: `snapshot-${state.calls}`,
              tasks: state.tasks,
            });
        }
        done();
      },
    }),
  });
  const sdk = query({
    prompt:
      options?.input.prompt ??
      (async function* () {
        yield await new Promise<SDKUserMessage>(() => {});
      })(),
    options: {
      ...options?.input.options,
      cwd: process.cwd(),
      settingSources: [],
      tools: [],
      pathToClaudeCodeExecutable: process.execPath,
      spawnClaudeCodeProcess: () => inventory.attach(child),
    },
  });
  const refresh = () =>
    inventory.refresh({
      query: sdk,
      sessionId: "native-session",
      isCurrent: () => true,
      observation: (sessionId) => ({
        providerSessionId: sessionId,
        coverage: "claude_background_tasks",
        queriedProviderSessionIds: [sessionId],
        foregroundActive: false,
        items: runtime.completionInventory(sessionId),
      }),
    });
  const consume = async () => {
    const result = await sdk.next();
    if (result.done) throw Error("SDK stream ended before the expected frame");
    runtime.observe(result.value);
    inventory.processed(result.value);
  };
  return {
    sdk,
    runtime,
    inventory,
    state,
    refresh,
    consume,
    send,
    close: () => {
      sdk.close();
      child.kill("SIGTERM");
    },
  };
}

// Fault: commands initializes the native Query without a consumer. A fresh read
// then times out, or starts a replacement Query when launch settings are pending.
test("commands-only native refresh consumes the existing query without a prompt or replacement", async () => {
  let fixture: ReturnType<typeof inventorySdk> | undefined;
  let queryCount = 0;
  const session = await new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => process.execPath,
    queryFactory: (input) => {
      queryCount++;
      const internal = session as unknown as { backgroundInventory: ClaudeBackgroundInventory };
      fixture = inventorySdk({ input, inventory: internal.backgroundInventory });
      return fixture.sdk;
    },
  }).createSession({ provider: "claude", cwd: process.cwd() });
  try {
    expect((await session.getRuntimeInfo()).sessionId).toBeNull();
    await session.listCommands!();
    const generation = session.backgroundWorkGeneration;
    // Model/launch controls can mark a query for later recreation. A readback
    // must still consume this exact initialized process instead of recreating it.
    await session.setThinkingOption!(null);
    const observation = await session.refreshBackgroundWork!();
    expect(observation).toMatchObject({
      providerSessionId: "native-session",
      coverage: "claude_background_tasks",
      queryGeneration: generation,
      queriedProviderSessionIds: ["native-session"],
      foregroundActive: false,
      items: [],
    });
    expect((await session.getRuntimeInfo()).sessionId).toBe(observation.providerSessionId);
    expect(queryCount, "readback preserves the initialized native Query").toBe(1);
    expect(fixture!.state.userInputs, "readback never writes a model prompt").toBe(0);
  } finally {
    await session.close();
    fixture?.close();
  }
}, 35_000);

test("fresh Claude observation rejects queued empty state and waits for the latest native snapshot processing", async () => {
  const fixture = inventorySdk();
  try {
    await fixture.sdk.initializationResult();
    fixture.runtime.observe(
      message({ type: "system", subtype: "background_tasks_changed", tasks: [] }),
    );
    fixture.state.tasks = [{ task_id: "child", task_type: "local_agent", description: "Grüße" }];
    let settled = false;
    const pending = fixture.refresh().then((value) => {
      settled = true;
      return value;
    });
    await expect.poll(() => fixture.state.calls).toBe(2);
    await fixture.consume(); // Startup empty snapshot was queued before this refresh.
    expect(settled, "cached empty snapshot must not settle a fresh request").toBe(false);
    await fixture.consume();
    const observation = await pending;
    expect(observation.items).toEqual([
      {
        id: "child",
        kind: "local_agent",
        description: "Grüße",
        providerSessionId: "native-session",
      },
    ]);
    expect(observation.queryGeneration).toBe(fixture.inventory.queryGeneration);

    fixture.send({
      type: "system",
      subtype: "task_notification",
      task_id: "child",
      status: "completed",
      uuid: "notification",
      session_id: "native-session",
    });
    fixture.state.tasks = [];
    const empty = fixture.refresh();
    await expect.poll(() => fixture.state.calls).toBe(3);
    await fixture.consume(); // Notification must be handled as well as the empty roster.
    await fixture.consume();
    const emptyObservation = await empty;
    expect(emptyObservation.items).toEqual([]);
    expect(fixture.runtime.canStopRuntime()).toBe(true);
    fixture.send({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "late-shell", task_type: "local_bash", description: "Known newer work" }],
      uuid: "newer-active",
      session_id: "native-session",
    });
    await expect
      .poll(() => fixture.inventory.stateRevision)
      .not.toBe(emptyObservation.stateRevision);
    await fixture.consume();

    fixture.state.omit = true;
    settled = false;
    const missing = fixture.refresh().then(() => {
      settled = true;
      return undefined;
    });
    const rejected = expect(missing).rejects.toThrow("BACKGROUND_WORK_SESSION_CHANGED");
    await expect.poll(() => fixture.state.calls).toBe(4);
    expect(settled).toBe(false);
    fixture.inventory.invalidate();
    await rejected;
  } finally {
    fixture.close();
  }
});

test("enriches only live tasks with their correlated launch metadata", () => {
  const runtime = new ClaudeRuntimeSafety();
  runtime.observe(
    message({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Monitor",
            input: { description: "Watch build", command: "tail -f build.log" },
          },
          { type: "tool_use", id: "old", name: "Bash", input: { command: "old command" } },
        ],
      },
    }),
  );
  runtime.observe(
    message({ type: "system", subtype: "task_started", task_id: "task-1", tool_use_id: "tool-1" }),
  );
  expect(
    runtime.observe(
      message({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "task-1", task_type: "local_bash", description: "Watch build" }],
      }),
    ),
  ).toEqual([
    {
      id: "task-1",
      kind: "monitor",
      description: "Watch build",
      command: "tail -f build.log",
      canStop: true,
    },
  ]);
  expect(
    runtime.observe(message({ type: "system", subtype: "background_tasks_changed", tasks: [] })),
  ).toEqual([]);
});
