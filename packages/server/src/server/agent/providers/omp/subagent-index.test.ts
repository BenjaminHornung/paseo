import { describe, expect, test } from "vitest";

import { OmpSubagentIndex } from "./subagent-index.js";

describe("OMP provider subagent mapper", () => {
  test("maps lifecycle and progress frames to stable provider_subagent descriptors", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    expect(
      index.handleLifecycle(parent, {
        id: "child-1",
        agent: "explore",
        description: "Inspect files",
        status: "started",
        parentToolCallId: "task-1",
        index: 0,
      }),
    ).toEqual([
      {
        type: "provider_subagent",
        provider: "omp",
        event: {
          type: "upsert",
          id: "child-1",
          title: "explore",
          description: "Inspect files",
          status: "running",
          toolCallId: "task-1",
        },
      },
    ]);

    expect(
      index.handleProgress(parent, {
        index: 0,
        agent: "explore",
        task: "Inspect files",
        parentToolCallId: "task-1",
        progress: {
          id: "child-1",
          status: "running",
          resolvedModel: "openai-codex/gpt-5.5",
        },
      })[0],
    ).toMatchObject({
      event: {
        id: "child-1",
        status: "running",
        title: "explore · gpt-5.5 (openai-codex)",
      },
    });

    expect(
      index.handleProgress(parent, {
        index: 0,
        agent: "explore",
        task: "Inspect files",
        parentToolCallId: "task-1",
        progress: {
          id: "child-1",
          status: "completed",
          resolvedModel: "anthropic/claude-sonnet-5",
        },
      })[0],
    ).toMatchObject({
      event: {
        id: "child-1",
        status: "completed",
        title: "explore · claude-sonnet-5 (anthropic)",
      },
    });
  });

  test("maps child message events onto the descriptor timeline", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    expect(
      index.handleEvent(parent, {
        id: "child-1",
        event: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Child answer" }],
          },
        },
      }),
    ).toEqual([
      {
        type: "provider_subagent",
        provider: "omp",
        event: {
          type: "timeline",
          id: "child-1",
          item: {
            type: "assistant_message",
            text: "Child answer",
            messageId: "omp-history-assistant-1",
          },
        },
      },
    ]);
  });

  test("maps aborted lifecycle status to canceled", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    expect(
      index.handleLifecycle(parent, {
        id: "child-1",
        agent: "task",
        status: "aborted",
        index: 0,
      })[0],
    ).toMatchObject({ event: { id: "child-1", status: "canceled" } });
  });

  test("tracks running children and reconciles only changed snapshots", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    const runningSnapshot = {
      id: "child-2",
      agent: "audit",
      description: "Audit the API",
      status: "running" as const,
      parentToolCallId: "task-9",
    };

    expect(index.hasRunning(parent)).toBe(false);
    expect(index.reconcileSnapshots(parent, [runningSnapshot])).toMatchObject([
      { event: { id: "child-2", status: "running" } },
    ]);
    expect(index.hasRunning(parent)).toBe(true);
    expect(index.reconcileSnapshots(parent, [runningSnapshot])).toEqual([]);

    expect(
      index.reconcileSnapshots(parent, [{ ...runningSnapshot, status: "completed" }]),
    ).toMatchObject([{ event: { id: "child-2", status: "completed" } }]);
    expect(index.hasRunning(parent)).toBe(false);
  });

  test("does not resurrect a terminal child from stale running observations", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    index.handleLifecycle(parent, {
      id: "child-3",
      agent: "worker",
      status: "started",
      index: 0,
    });
    index.terminalizeRunning(parent);

    expect(
      index.handleProgress(parent, {
        id: "child-3",
        agent: "worker",
        task: "slow work",
        index: 0,
        progress: { id: "child-3", status: "running" },
      }),
    ).toEqual([]);
    expect(
      index.reconcileSnapshots(parent, [{ id: "child-3", agent: "worker", status: "pending" }]),
    ).toEqual([]);
    expect(index.hasRunning(parent)).toBe(false);
  });
});
