/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Agent } from "@/contexts/session-context";
import {
  deriveAgentScreenViewState,
  type AgentScreenMachineInput,
  type AgentScreenMachineMemory,
  type AgentScreenViewState,
  useAgentScreenStateMachine,
} from "./use-agent-screen-state-machine";

type ReadyState = Extract<AgentScreenViewState, { tag: "ready" }>;
type CatchingUpSyncState = Extract<ReadyState["sync"], { status: "catching_up" }>;

function createAgent(id: string): Agent {
  const now = new Date("2026-02-19T00:00:00.000Z");
  return {
    serverId: "server-1",
    id,
    provider: "claude",
    status: "running",
    createdAt: now,
    updatedAt: now,
    lastUserMessageAt: now,
    lastActivityAt: now,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: {
      provider: "claude",
      sessionId: "session-1",
      model: null,
      modeId: null,
    },
    title: "Agent",
    cwd: "/repo",
    model: null,
    parentAgentId: null,
    labels: {},
  };
}

function createAgentWithStatus({ id, status }: { id: string; status: Agent["status"] }): Agent {
  return {
    ...createAgent(id),
    status,
  };
}

function createBaseInput(): AgentScreenMachineInput {
  return {
    agent: null,
    isArchived: false,
    continuity: { kind: "none" },
    missingAgentState: { kind: "idle" },
    isConnected: true,
    isArchivingCurrentAgent: false,
    isHistorySyncing: false,
    needsAuthoritativeSync: false,
    visibilityCatchUpStatus: "ready",
    hasHydratedHistoryBefore: false,
  };
}

function createBaseMemory(
  overrides: Partial<AgentScreenMachineMemory> = {},
): AgentScreenMachineMemory {
  return {
    hasRenderedReady: false,
    lastReadyAgent: null,
    hadInitialSyncFailure: false,
    ...overrides,
  };
}

function expectReadyState(state: AgentScreenViewState): ReadyState {
  expect(state.tag).toBe("ready");
  if (state.tag !== "ready") {
    throw new Error("expected ready state");
  }
  return state;
}

function expectCatchingUpSync(state: ReadyState): CatchingUpSyncState {
  expect(state.sync.status).toBe("catching_up");
  if (state.sync.status !== "catching_up") {
    throw new Error("expected catching_up sync state");
  }
  return state.sync;
}

function expectSyncErrorSync(state: ReadyState): void {
  expect(state.sync.status).toBe("sync_error");
}

function stateMachineLabel(state: AgentScreenViewState): "loading" | "resolving" | Agent["status"] {
  if (state.tag === "boot") {
    return state.reason;
  }
  if (state.tag === "ready") {
    return state.agent.status;
  }
  return "error";
}

describe("deriveAgentScreenViewState", () => {
  it("returns boot loading before first interactive paint", () => {
    const memory = createBaseMemory();
    const input = createBaseInput();

    const result = deriveAgentScreenViewState({ input, memory });

    expect(result.state.tag).toBe("boot");
    if (result.state.tag !== "boot") {
      throw new Error("expected boot state");
    }
    expect(result.state.reason).toBe("loading");
    expect(result.state.source).toBe("none");
  });

  it("stays ready after first paint even if agent is temporarily missing", () => {
    const memory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const input = createBaseInput();

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);

    expect(ready.source).toBe("stale");
    expect(ready.sync.status).toBe("idle");
    expect(ready.agent.id).toBe("agent-1");
  });

  it("shows reconnecting sync status without blocking after first paint", () => {
    const memory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      isConnected: false,
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);

    expect(ready.sync.status).toBe("reconnecting");
  });

  it("shows overlay catching-up state for first open while loading history", () => {
    const memory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      needsAuthoritativeSync: true,
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);
    const sync = expectCatchingUpSync(ready);

    expect(sync.ui).toBe("overlay");
  });

  it("uses silent catching-up state for already-hydrated agents", () => {
    const memory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      needsAuthoritativeSync: true,
      hasHydratedHistoryBefore: true,
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);
    const sync = expectCatchingUpSync(ready);

    expect(sync.ui).toBe("silent");
  });

  it("keeps hydrated history visible while reconnect revalidation and visibility catch-up overlap", () => {
    const memory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      hasHydratedHistoryBefore: true,
      needsAuthoritativeSync: true,
      visibilityCatchUpStatus: "pending",
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);
    const sync = expectCatchingUpSync(ready);

    expect(sync.ui).toBe("silent");
  });

  it("keeps already-hydrated history visible while a newly visible agent catches up", () => {
    const memory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      agent: createAgent("agent-1"),
      hasHydratedHistoryBefore: true,
      visibilityCatchUpStatus: "pending",
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);
    const sync = expectCatchingUpSync(ready);

    expect(sync.ui).toBe("silent");
  });

  it("keeps hydrated history readable after a visibility catch-up error", () => {
    const memory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      agent: createAgent("agent-1"),
      hasHydratedHistoryBefore: true,
      visibilityCatchUpStatus: "error",
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);

    expectSyncErrorSync(ready);
  });

  it("keeps sync errors non-blocking once the screen was ready", () => {
    const memory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      needsAuthoritativeSync: true,
      missingAgentState: { kind: "error", message: "network timeout" },
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);
    expectSyncErrorSync(ready);
  });

  it("remembers first-load sync failure and keeps catch-up overlay off after error clears", () => {
    const initialMemory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const errorInput: AgentScreenMachineInput = {
      ...createBaseInput(),
      needsAuthoritativeSync: true,
      missingAgentState: { kind: "error", message: "network timeout" },
    };

    const errorResult = deriveAgentScreenViewState({
      input: errorInput,
      memory: initialMemory,
    });
    const errorReady = expectReadyState(errorResult.state);
    expectSyncErrorSync(errorReady);
    expect(errorResult.memory.hadInitialSyncFailure).toBe(true);

    const retryInput: AgentScreenMachineInput = {
      ...createBaseInput(),
      needsAuthoritativeSync: true,
      missingAgentState: { kind: "idle" },
    };
    const retryResult = deriveAgentScreenViewState({
      input: retryInput,
      memory: errorResult.memory,
    });
    const retryReady = expectReadyState(retryResult.state);
    const retrySync = expectCatchingUpSync(retryReady);

    expect(retrySync.ui).toBe("silent");
    expect(retryResult.memory.hadInitialSyncFailure).toBe(true);
  });

  it("keeps ready with sync_error when refresh fails after first paint", () => {
    const memory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      missingAgentState: { kind: "error", message: "network timeout" },
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);
    expectSyncErrorSync(ready);

    expect(ready.source).toBe("stale");
    expect(ready.agent.id).toBe("agent-1");
  });

  it("returns blocking error before first paint when refresh fails", () => {
    const memory = createBaseMemory();
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      missingAgentState: { kind: "error", message: "network timeout" },
    };

    const result = deriveAgentScreenViewState({ input, memory });

    expect(result.state.tag).toBe("error");
    if (result.state.tag !== "error") {
      throw new Error("expected error state");
    }
    expect(result.state.message).toContain("network timeout");
  });

  it("keeps a previously rendered timeline visible when history sync fails for the current agent", () => {
    const memory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      agent: createAgent("agent-1"),
      needsAuthoritativeSync: true,
      isHistorySyncing: false,
      hasHydratedHistoryBefore: false,
      missingAgentState: { kind: "error", message: "history sync failed" },
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);

    expect(ready.agent.id).toBe("agent-1");
    expect(ready.source).toBe("authoritative");
    expectSyncErrorSync(ready);
    expect(result.memory.hadInitialSyncFailure).toBe(true);

    const retry = deriveAgentScreenViewState({
      input: {
        ...input,
        missingAgentState: { kind: "idle" },
      },
      memory: result.memory,
    });
    const retryReady = expectReadyState(retry.state);
    const retrySync = expectCatchingUpSync(retryReady);
    expect(retrySync.ui).toBe("silent");
  });

  it("keeps first-load errors blocking when no agent timeline can be rendered", () => {
    const memory = createBaseMemory();
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      agent: null,
      needsAuthoritativeSync: true,
      missingAgentState: { kind: "error", message: "history sync failed" },
    };

    const result = deriveAgentScreenViewState({ input, memory });

    expect(result.state).toEqual({
      tag: "error",
      message: "history sync failed",
    });
  });

  it("keeps first-load sync errors blocking before any ready render even when an authoritative agent exists", () => {
    const result = deriveAgentScreenViewState({
      input: {
        ...createBaseInput(),
        agent: createAgent("agent-1"),
        missingAgentState: { kind: "error", message: "history sync failed" },
        needsAuthoritativeSync: true,
        hasHydratedHistoryBefore: false,
      },
      memory: createBaseMemory(),
    });

    expect(result.state).toEqual({
      tag: "error",
      message: "history sync failed",
    });
    expect(result.memory.hasRenderedReady).toBe(false);
    expect(result.memory.lastReadyAgent).toBeNull();
    expect(result.memory.hadInitialSyncFailure).toBe(true);
  });

  it("keeps retry blocked after an initial sync failure that never rendered history", () => {
    const errorResult = deriveAgentScreenViewState({
      input: {
        ...createBaseInput(),
        agent: null,
        missingAgentState: { kind: "error", message: "history sync failed" },
      },
      memory: createBaseMemory(),
    });

    expect(errorResult.state).toEqual({
      tag: "error",
      message: "history sync failed",
    });
    expect(errorResult.memory.hasRenderedReady).toBe(false);
    expect(errorResult.memory.hadInitialSyncFailure).toBe(true);

    const retryResult = deriveAgentScreenViewState({
      input: {
        ...createBaseInput(),
        agent: createAgent("agent-1"),
        needsAuthoritativeSync: true,
        hasHydratedHistoryBefore: false,
      },
      memory: errorResult.memory,
    });

    expect(retryResult.state).toEqual({
      tag: "boot",
      reason: "loading",
      source: "none",
    });
    expect(retryResult.memory.hasRenderedReady).toBe(false);
    expect(retryResult.memory.lastReadyAgent).toBeNull();
  });

  it("returns not_found when resolver confirms missing agent", () => {
    const memory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      missingAgentState: { kind: "not_found", message: "agent missing" },
    };

    const result = deriveAgentScreenViewState({ input, memory });

    expect(result.state.tag).toBe("not_found");
    if (result.state.tag !== "not_found") {
      throw new Error("expected not_found state");
    }
    expect(result.state.message).toContain("missing");
  });

  it("promotes optimistic source while placeholder is used", () => {
    const memory = createBaseMemory();
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      continuity: { kind: "optimistic-create", agent: createAgent("draft-agent") },
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);

    expect(ready.source).toBe("optimistic");
    expect(ready.sync.status).toBe("idle");
  });

  it("keeps first route entry blocked until authoritative history is applied", () => {
    const memory = createBaseMemory();
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      agent: createAgent("agent-1"),
      needsAuthoritativeSync: true,
      isHistorySyncing: true,
      hasHydratedHistoryBefore: false,
    };

    const result = deriveAgentScreenViewState({ input, memory });

    expect(result.state).toEqual({
      tag: "boot",
      reason: "loading",
      source: "none",
    });
    expect(result.memory.hasRenderedReady).toBe(false);
    expect(result.memory.lastReadyAgent).toBeNull();
  });

  it("renders an archived agent before provider history is initialized", () => {
    const result = deriveAgentScreenViewState({
      input: {
        ...createBaseInput(),
        agent: createAgent("agent-1"),
        isArchived: true,
        needsAuthoritativeSync: true,
      },
      memory: createBaseMemory(),
    });

    const ready = expectReadyState(result.state);
    expect(ready.agent.id).toBe("agent-1");
    expect(ready.sync).toEqual({ status: "idle" });
  });

  it("keeps optimistic create non-blocking while timeline and authoritative history catch up", () => {
    const memory = createBaseMemory();
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      agent: createAgentWithStatus({ id: "agent-1", status: "idle" }),
      continuity: { kind: "optimistic-create", agent: createAgent("agent-1") },
      needsAuthoritativeSync: true,
      isHistorySyncing: true,
      visibilityCatchUpStatus: "pending",
      hasHydratedHistoryBefore: false,
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);

    expect(ready.source).toBe("optimistic");
    expect(ready.agent.status).toBe("running");
    expect(ready.sync).toEqual({ status: "catching_up", ui: "silent" });
  });

  it("keeps optimistic flow non-blocking while transitioning to authoritative stream", () => {
    const initialMemory = createBaseMemory();
    const optimisticInput: AgentScreenMachineInput = {
      ...createBaseInput(),
      continuity: { kind: "optimistic-create", agent: createAgent("draft-agent") },
    };

    const optimistic = deriveAgentScreenViewState({
      input: optimisticInput,
      memory: initialMemory,
    });
    const optimisticReady = expectReadyState(optimistic.state);
    expect(optimisticReady.source).toBe("optimistic");

    const handoffInput: AgentScreenMachineInput = {
      ...createBaseInput(),
    };
    const handoff = deriveAgentScreenViewState({
      input: handoffInput,
      memory: optimistic.memory,
    });
    const handoffReady = expectReadyState(handoff.state);

    expect(handoffReady.source).toBe("stale");
    expect(handoffReady.agent.id).toBe("draft-agent");
  });

  it("keeps optimistic running status while authoritative agent is still bootstrapping", () => {
    const memory = createBaseMemory();
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      agent: createAgentWithStatus({ id: "agent-1", status: "idle" }),
      continuity: { kind: "optimistic-create", agent: createAgent("agent-1") },
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);

    expect(ready.source).toBe("optimistic");
    expect(ready.agent.status).toBe("running");
  });

  it("keeps send lifecycle transitions forward-only across optimistic and authoritative handoff", () => {
    let memory = createBaseMemory();
    const transitions: Array<"loading" | "resolving" | Agent["status"]> = [];

    for (const input of [
      createBaseInput(),
      {
        ...createBaseInput(),
        agent: createAgentWithStatus({ id: "agent-1", status: "idle" }),
        continuity: { kind: "optimistic-create", agent: createAgent("agent-1") },
      },
      {
        ...createBaseInput(),
        agent: createAgentWithStatus({ id: "agent-1", status: "running" }),
        continuity: { kind: "optimistic-create", agent: createAgent("agent-1") },
      },
      {
        ...createBaseInput(),
        agent: createAgentWithStatus({ id: "agent-1", status: "idle" }),
      },
    ] satisfies AgentScreenMachineInput[]) {
      const result = deriveAgentScreenViewState({ input, memory });
      memory = result.memory;
      transitions.push(stateMachineLabel(result.state));
    }

    expect(transitions).toEqual(["loading", "running", "running", "idle"]);
    expect(transitions.join(" -> ")).not.toContain("running -> loading");
    expect(transitions.join(" -> ")).not.toContain("loading -> idle");
  });

  it("uses authoritative initializing status instead of optimistic running status", () => {
    const memory = createBaseMemory();
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      agent: createAgentWithStatus({ id: "agent-1", status: "initializing" }),
      continuity: { kind: "optimistic-create", agent: createAgent("agent-1") },
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);

    expect(ready.source).toBe("authoritative");
    expect(ready.agent.status).toBe("initializing");
  });

  it("hands off to authoritative once agent reaches running", () => {
    const memory = createBaseMemory();
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      agent: createAgentWithStatus({ id: "agent-1", status: "running" }),
      continuity: { kind: "optimistic-create", agent: createAgent("agent-1") },
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);

    expect(ready.source).toBe("authoritative");
    expect(ready.agent.status).toBe("running");
  });

  it("hands off to authoritative for terminal error states", () => {
    const memory = createBaseMemory();
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      agent: createAgentWithStatus({ id: "agent-1", status: "error" }),
      continuity: { kind: "optimistic-create", agent: createAgent("agent-1") },
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);

    expect(ready.source).toBe("authoritative");
    expect(ready.agent.status).toBe("error");
  });

  it("hands off to authoritative for terminal closed states", () => {
    const memory = createBaseMemory();
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      agent: createAgentWithStatus({ id: "agent-1", status: "closed" }),
      continuity: { kind: "optimistic-create", agent: createAgent("agent-1") },
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);

    expect(ready.source).toBe("authoritative");
    expect(ready.agent.status).toBe("closed");
  });

  it("clears initial sync failure memory after history is hydrated", () => {
    const memory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
      hadInitialSyncFailure: true,
    });
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      hasHydratedHistoryBefore: true,
      needsAuthoritativeSync: true,
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);
    const sync = expectCatchingUpSync(ready);

    expect(sync.ui).toBe("silent");
    expect(result.memory.hadInitialSyncFailure).toBe(false);
  });

  it("keeps successfully hydrated history visible when a later sync fails", () => {
    const hydrated = deriveAgentScreenViewState({
      input: {
        ...createBaseInput(),
        agent: createAgent("agent-1"),
        hasHydratedHistoryBefore: true,
      },
      memory: createBaseMemory({ hadInitialSyncFailure: true }),
    });

    expect(expectReadyState(hydrated.state).sync.status).toBe("idle");
    expect(hydrated.memory.hadInitialSyncFailure).toBe(false);

    const failedRefresh = deriveAgentScreenViewState({
      input: {
        ...createBaseInput(),
        agent: createAgent("agent-1"),
        hasHydratedHistoryBefore: true,
        missingAgentState: { kind: "error", message: "history sync failed" },
      },
      memory: hydrated.memory,
    });

    expectSyncErrorSync(expectReadyState(failedRefresh.state));
    expect(failedRefresh.memory.hadInitialSyncFailure).toBe(false);
  });

  it("stays non-blocking from a post-hydration error through retry and success", () => {
    const hydratedMemory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const failedRefresh = deriveAgentScreenViewState({
      input: {
        ...createBaseInput(),
        agent: createAgent("agent-1"),
        hasHydratedHistoryBefore: true,
        missingAgentState: { kind: "error", message: "history sync failed" },
      },
      memory: hydratedMemory,
    });
    expectSyncErrorSync(expectReadyState(failedRefresh.state));

    const retry = deriveAgentScreenViewState({
      input: {
        ...createBaseInput(),
        agent: createAgent("agent-1"),
        hasHydratedHistoryBefore: true,
        needsAuthoritativeSync: true,
      },
      memory: failedRefresh.memory,
    });
    const retrySync = expectCatchingUpSync(expectReadyState(retry.state));
    expect(retrySync.ui).toBe("silent");

    const success = deriveAgentScreenViewState({
      input: {
        ...createBaseInput(),
        agent: createAgent("agent-1"),
        hasHydratedHistoryBefore: true,
      },
      memory: retry.memory,
    });
    expect(expectReadyState(success.state).sync.status).toBe("idle");
    expect(success.memory.hadInitialSyncFailure).toBe(false);
  });

  it("recovers a hydrated candidate after remount when sync fails", () => {
    const result = deriveAgentScreenViewState({
      input: {
        ...createBaseInput(),
        agent: createAgent("agent-1"),
        hasHydratedHistoryBefore: true,
        missingAgentState: { kind: "error", message: "history sync failed" },
      },
      memory: createBaseMemory(),
    });

    const ready = expectReadyState(result.state);
    expect(ready.source).toBe("authoritative");
    expectSyncErrorSync(ready);
  });

  it("uses the stale agent when a post-hydration sync failure temporarily removes the candidate", () => {
    const result = deriveAgentScreenViewState({
      input: {
        ...createBaseInput(),
        hasHydratedHistoryBefore: true,
        missingAgentState: { kind: "error", message: "history sync failed" },
      },
      memory: createBaseMemory({
        hasRenderedReady: true,
        lastReadyAgent: createAgent("agent-1"),
      }),
    });

    const ready = expectReadyState(result.state);
    expect(ready.agent.id).toBe("agent-1");
    expect(ready.source).toBe("stale");
    expectSyncErrorSync(ready);
  });

  it("keeps hydrated empty history renderable when a later sync fails", () => {
    const emptyHydration = deriveAgentScreenViewState({
      input: {
        ...createBaseInput(),
        agent: createAgent("agent-1"),
        hasHydratedHistoryBefore: true,
      },
      memory: createBaseMemory(),
    });
    expect(expectReadyState(emptyHydration.state).sync.status).toBe("idle");

    const failedRefresh = deriveAgentScreenViewState({
      input: {
        ...createBaseInput(),
        agent: createAgent("agent-1"),
        hasHydratedHistoryBefore: true,
        missingAgentState: { kind: "error", message: "history sync failed" },
      },
      memory: emptyHydration.memory,
    });

    expectSyncErrorSync(expectReadyState(failedRefresh.state));
  });
});

describe("useAgentScreenStateMachine", () => {
  it("does not inherit hydrated recovery memory after a route switch", () => {
    const hydratedInput: AgentScreenMachineInput = {
      ...createBaseInput(),
      agent: createAgent("agent-1"),
      hasHydratedHistoryBefore: true,
    };
    const { result, rerender } = renderHook(
      ({ routeKey, input }: { routeKey: string; input: AgentScreenMachineInput }) =>
        useAgentScreenStateMachine({ routeKey, input }),
      {
        initialProps: { routeKey: "agent-1", input: hydratedInput },
      },
    );
    expect(result.current.tag).toBe("ready");

    rerender({
      routeKey: "agent-2",
      input: {
        ...createBaseInput(),
        agent: createAgent("agent-2"),
        needsAuthoritativeSync: true,
        missingAgentState: { kind: "error", message: "history sync failed" },
      },
    });

    expect(result.current).toEqual({
      tag: "error",
      message: "history sync failed",
    });
  });
});
