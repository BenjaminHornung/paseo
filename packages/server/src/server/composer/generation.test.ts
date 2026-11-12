import { expect, it, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import type { ClaudeQueryFactory } from "../agent/providers/claude/query.js";
import { PiRpcAgentClient } from "../agent/providers/pi/agent.js";
import { FakePi } from "../agent/providers/pi/test-utils/fake-pi.js";
import type { PiAgentMessage } from "../agent/providers/pi/rpc-types.js";

// These launch options are a safety contract: an automatic prediction must not
// execute project hooks or tools, including when its profile normally allows them.
it("keeps Claude predictions tool-free despite a permissive profile and closes the query", async () => {
  let options!: Parameters<ClaudeQueryFactory>[0]["options"];
  const close = vi.fn();
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => "/test/claude",
    queryFactory: (input) => {
      options = input.options;
      const stream = (async function* () {
        yield { type: "result", subtype: "success", result: "suggestion" };
      })();
      // The production path only consumes the iterator and close method.
      return Object.assign(stream, { close }) as unknown as ReturnType<ClaudeQueryFactory>;
    },
  });
  expect(
    await client.generateText(
      {
        provider: "claude",
        cwd: process.cwd(),
        model: "claude-sonnet-4-6",
        thinkingOptionId: "high",
        providerOptions: {
          allowedTools: ["Bash"],
          fast_mode: true,
          extraArgs: { tools: "Bash", resume: "old-chat" },
        },
      },
      "predict",
      new AbortController().signal,
    ),
  ).toBe("suggestion");
  expect(options).toMatchObject({
    model: "claude-sonnet-4-6",
    effort: "high",
    tools: [],
    allowedTools: [],
    mcpServers: {},
    strictMcpConfig: true,
    plugins: [],
    settingSources: [],
    persistSession: false,
    settings: { disableAllHooks: true, disableClaudeAiConnectors: true, fastMode: true },
  });
  expect(options.extraArgs).toBeUndefined();
  expect(close).toHaveBeenCalledOnce();
});

it("starts Pi prediction without tools or integrations and closes the isolated helper", async () => {
  const runtime = new FakePi();
  const client = new PiRpcAgentClient({ runtime, logger: createTestLogger() });
  const result = client.generateText(
    { provider: "pi", cwd: process.cwd(), model: "test/model", thinkingOptionId: "high" },
    "predict",
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(runtime.latestSession().prompts).toHaveLength(1));
  const launch = runtime.recordedLaunches[0];
  expect(launch).toMatchObject({ noSession: true, model: "test/model", thinkingOptionId: "high" });
  expect(launch.argv).toEqual(
    expect.arrayContaining([
      "--no-tools",
      "--exclude-tools",
      "*",
      "--no-mcp",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
    ]),
  );
  expect(launch.mcpConfigPath).toBeUndefined();
  expect(launch.extensionPaths).toBeUndefined();
  const message: PiAgentMessage = {
    role: "assistant",
    content: [{ type: "text", text: "suggestion" }],
  };
  runtime.latestSession().emit({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "text_delta", delta: "suggestion" },
  });
  runtime.latestSession().emit({ type: "message_end", message });
  runtime.latestSession().finishTurn(message);
  expect(await result).toBe("suggestion");
  expect(runtime.latestSession().closeCalls).toBe(1);
});

it("refuses custom launch commands before they can restore tools or execute hooks", async () => {
  const runtime = new FakePi();
  const pi = new PiRpcAgentClient({
    runtime,
    logger: createTestLogger(),
    runtimeSettings: { command: { mode: "replace", argv: ["pi", "-e", "hook.ts"] } },
  });
  const resolveBinary = vi.fn(async () => "/test/claude");
  const claude = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary,
    runtimeSettings: { command: { mode: "append", args: ["--tools", "Bash"] } },
  });
  for (const client of [pi, claude]) {
    expect(client.capabilities.supportsTextGeneration).toBe(false);
    await expect(
      client.generateText(
        { provider: client.provider, cwd: process.cwd() },
        "predict",
        new AbortController().signal,
      ),
    ).rejects.toThrow("custom provider command");
  }
  expect(runtime.recordedLaunches).toHaveLength(0);
  expect(resolveBinary).not.toHaveBeenCalled();
});
