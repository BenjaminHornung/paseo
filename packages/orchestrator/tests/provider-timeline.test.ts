import { test } from "node:test";
import assert from "node:assert/strict";
import {
  completedPiForeground,
  completedPiPoll,
  completedNonExecutingMcp,
  completedTerminalInteraction,
  completedAgentCommunication,
  failedLocalBrowserConnection,
  turnFailure,
  type Snapshot,
} from "../src/provider.ts";

// Real Pi 1.5 timeline PowerShell tools use the SDK's unknown detail envelope.
// A completed, synchronous command may be inspected; unknown process ownership
// or incomplete output must still block explicit foreground attestation.
test("Pi foreground attestation understands completed structured PowerShell without accepting unobserved jobs", () => {
  const tool = {
    name: "powershell",
    status: "completed",
    detail: {
      type: "unknown",
      input: { command: "& 'C:/IFI_SourceCode/Utils/agent-updates/runtime/node.exe' check.mjs" },
      output: { structuredContent: { exit_code: 0, truncated: false, output: "" } },
    },
  };
  assert.equal(completedPiForeground(tool), true);
  for (const command of [
    "Start-Job { do-work }",
    "Start-ThreadJob { do-work }",
    "1..5 | ForEach-Object -Parallel { do-work } -AsJob",
  ])
    assert.equal(
      completedPiForeground({ ...tool, detail: { ...tool.detail, input: { command } } }),
      false,
    );
  assert.equal(
    completedPiForeground({
      ...tool,
      detail: {
        ...tool.detail,
        output: { structuredContent: { ...tool.detail.output.structuredContent, truncated: true } },
      },
    }),
    false,
  );
  assert.equal(
    completedPiForeground({
      ...tool,
      detail: {
        ...tool.detail,
        output: {
          structuredContent: {
            ...tool.detail.output.structuredContent,
            output: "Process running with session_id 10",
          },
        },
      },
    }),
    false,
  );
  assert.equal(
    completedPiForeground({
      ...tool,
      detail: {
        ...tool.detail,
        output: {
          structuredContent: {
            ...tool.detail.output.structuredContent,
            output: "PI_SESSION_ID = fixture-id",
          },
        },
      },
    }),
    true,
  );
  assert.equal(completedPiForeground({ ...tool, status: "running" }), false);
  const exec = {
    name: "exec_command",
    status: "completed",
    detail: {
      type: "unknown",
      input: { cmd: "node check.mjs" },
      output: { details: { exit_code: 0, output: "" } },
    },
  };
  assert.equal(completedPiForeground(exec), true);
  const truncated = {
    ...exec,
    detail: {
      ...exec.detail,
      output: { details: { ...exec.detail.output.details, truncated: true } },
    },
  };
  assert.equal(completedPiForeground(truncated), false);
  assert.equal(
    completedPiForeground(truncated, true),
    true,
    "an independently monitored job proves ownership even when text output is shortened",
  );
  assert.equal(
    completedPiForeground({
      ...exec,
      detail: {
        ...exec.detail,
        output: { details: { ...exec.detail.output.details, session_id: 42 } },
      },
    }),
    false,
  );
  const polling = {
    name: "write_stdin",
    status: "completed",
    detail: {
      type: "unknown",
      input: { session_id: 42, chars: "" },
      output: { details: { exit_code: 0, output: "" } },
    },
  };
  assert.equal(completedPiPoll(polling), 42);
  assert.equal(completedPiForeground(polling, true, new Set([42])), true);
  assert.equal(completedPiForeground(polling, true), false);
  assert.equal(
    completedPiPoll({
      ...polling,
      detail: { ...polling.detail, input: { session_id: 42, chars: "run another writer" } },
    }),
    null,
  );
  assert.equal(
    completedPiForeground({
      name: "apply_patch",
      status: "completed",
      detail: {
        type: "unknown",
        input: {
          input: "*** Begin Patch\n*** Update File: value.txt\n@@\n-before\n+after\n*** End Patch",
        },
        output: {
          details: {
            status: "success",
            result: {
              changedFiles: ["value.txt"],
              createdFiles: [],
              deletedFiles: [],
              movedFiles: [],
            },
          },
        },
      },
    }),
    true,
  );
  const read = {
    name: "devtoolbox.profiles.status",
    status: "completed",
    detail: { type: "unknown", input: {} },
  };
  assert.equal(completedNonExecutingMcp(read), true);
  assert.equal(completedNonExecutingMcp({ ...read, status: "running" }), false);
  assert.equal(completedNonExecutingMcp({ ...read, name: "devtoolbox.profiles.start" }), false);
  assert.equal(
    completedNonExecutingMcp({
      ...read,
      name: "playwright_runtime.browser_tabs",
      detail: { ...read.detail, input: { action: "list" } },
    }),
    true,
  );
  assert.equal(
    completedNonExecutingMcp({
      ...read,
      name: "playwright_runtime.browser_tabs",
      detail: { ...read.detail, input: { action: "new", url: "about:blank" } },
    }),
    true,
  );
  assert.equal(
    completedNonExecutingMcp({
      ...read,
      name: "playwright_runtime.browser_tabs",
      detail: { ...read.detail, input: { action: "new", url: "https://example.invalid" } },
    }),
    false,
  );
  assert.equal(
    completedNonExecutingMcp({
      ...read,
      name: "playwright_runtime.browser_tabs",
      detail: { ...read.detail, input: { action: "close", index: 0 } },
    }),
    true,
  );
  assert.equal(
    completedNonExecutingMcp({
      ...read,
      name: "playwright_runtime.browser_tabs",
      detail: { ...read.detail, input: { action: "create" } },
    }),
    false,
  );
  const shell = {
    callId: "shell-build",
    name: "shell",
    status: "failed",
    detail: { type: "shell", command: "build", exitCode: 1 },
  };
  const interaction = {
    name: "terminal",
    status: "completed",
    metadata: { processId: "native-session" },
    detail: { type: "plain_text", label: "build", text: "" },
  };
  assert.equal(completedTerminalInteraction(interaction, [shell]), true);
  assert.equal(
    completedTerminalInteraction({ ...interaction, metadata: undefined }, [shell]),
    false,
  );
  assert.equal(
    completedTerminalInteraction(
      { ...interaction, detail: { ...interaction.detail, text: "\u0003" } },
      [shell],
    ),
    true,
  );
  assert.equal(
    completedTerminalInteraction(
      { ...interaction, detail: { ...interaction.detail, text: "\n" } },
      [shell],
    ),
    true,
  );
  assert.equal(completedTerminalInteraction(interaction, []), false);
  assert.equal(
    completedTerminalInteraction(interaction, [
      { ...shell, detail: { ...shell.detail, exitCode: null } },
    ]),
    false,
  );
  assert.equal(
    completedTerminalInteraction(
      { ...interaction, detail: { ...interaction.detail, text: "start another writer" } },
      [shell],
    ),
    false,
  );
  const message = {
    name: "agent_message",
    status: "completed",
    detail: { type: "plain_text" },
    agentMessage: { event: "message", sender: { id: "main" }, text: "Continue" },
  };
  assert.equal(completedAgentCommunication(message, "worker"), true);
  assert.equal(completedAgentCommunication(message, "main"), false);
  assert.equal(
    completedAgentCommunication(
      { ...message, agentMessage: { ...message.agentMessage, event: "spawn" } },
      "worker",
    ),
    false,
  );
  const browser = {
    name: "playwright_runtime.browser_navigate",
    status: "failed",
    detail: {
      type: "unknown",
      input: { url: "http://127.0.0.1:56101/test" },
      output: {
        content: [
          { type: "text", text: "net::ERR_CONNECTION_TIMED_OUT at http://127.0.0.1:56101/test" },
        ],
      },
    },
  };
  assert.equal(failedLocalBrowserConnection(browser), true);
  assert.equal(failedLocalBrowserConnection({ ...browser, status: "completed" }), false);
  assert.equal(
    failedLocalBrowserConnection({
      ...browser,
      detail: { ...browser.detail, input: { url: "https://example.invalid" } },
    }),
    false,
  );
});

test("completed terminal polls require exact native thread and shell parent correlation after resume", () => {
  const nativeThreadId = "session01a1c512...";
  const parentCallId = "exec-9c57...";
  const shell = {
    callId: parentCallId,
    name: "shell",
    status: "completed",
    metadata: { nativeThreadId, parentCallId },
    detail: { type: "shell", command: "npm run build", exitCode: 0 },
  };
  const poll = {
    name: "terminal",
    status: "completed",
    metadata: { nativeThreadId, parentCallId, processId: "77182" },
    detail: { type: "plain_text", text: "" },
  };

  assert.equal(completedTerminalInteraction(poll, [shell]), true);
  assert.equal(
    completedTerminalInteraction(
      {
        ...poll,
        metadata: { nativeThreadId, parentCallId },
      },
      [shell],
    ),
    true,
  );
  assert.equal(
    completedTerminalInteraction({ ...poll, detail: { ...poll.detail, text: "\u0003" } }, [shell]),
    true,
  );

  const labeledPoll = { ...poll, detail: { ...poll.detail, label: shell.detail.command } };
  assert.equal(
    completedTerminalInteraction(
      { ...labeledPoll, metadata: { ...poll.metadata, nativeThreadId: "different-thread" } },
      [shell],
    ),
    false,
  );
  assert.equal(
    completedTerminalInteraction(
      { ...labeledPoll, metadata: { ...poll.metadata, parentCallId: "different-shell" } },
      [shell],
    ),
    false,
  );
  assert.equal(
    completedTerminalInteraction(
      { ...labeledPoll, metadata: { ...poll.metadata, parentCallId: undefined } },
      [shell],
    ),
    false,
  );
  assert.equal(
    completedTerminalInteraction(labeledPoll, [
      { ...shell, metadata: { ...shell.metadata, processId: "77181" } },
    ]),
    false,
  );
  assert.equal(completedTerminalInteraction(poll, [{ ...shell, status: "running" }]), false);
  assert.equal(
    completedTerminalInteraction(poll, [{ ...shell, detail: { ...shell.detail, exitCode: null } }]),
    false,
  );
});

test("a zero-token provider quota placeholder is an error, never a completed turn or a process-empty proof", () => {
  const snapshot: Snapshot = {
    id: "quota-session",
    cwd: process.cwd(),
    provider: "claude",
    model: "claude-opus-5-5",
    status: "idle",
    turnComplete: true,
    foregroundActive: false,
    reasoning: "medium",
    modeId: "auto",
    contextFraction: null,
    backgroundActive: null,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, billedMicroUsd: null },
  };
  const message = "You've hit your session limit · resets 1:40pm (Europe/Berlin)";
  const failure = turnFailure(snapshot, undefined, message);
  assert.equal(failure.status, "error");
  assert.equal(failure.failureKind, "quota-5h");
  assert.equal(failure.turnComplete, false);
  assert.equal(failure.backgroundActive, null);
  const generated = turnFailure(
    { ...snapshot, usage: { ...snapshot.usage, inputTokens: 100, outputTokens: 10 } },
    undefined,
    message,
  );
  assert.equal(generated.status, "idle");
  assert.equal(generated.failureKind, undefined);
  const budget = turnFailure(
    { ...snapshot, provider: "pi", status: "error" },
    "Orchestrator task budget exhausted",
  );
  assert.equal(budget.failureKind, "task-budget");
  assert.equal(budget.turnComplete, false);
});
