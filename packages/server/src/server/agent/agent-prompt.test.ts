import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, expect, it, test, vi } from "vitest";
import pino, { type Logger } from "pino";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import {
  AgentRunStartTimeoutError,
  formatSystemNotificationPrompt,
  isSystemInjectedEnvelope,
  sendPromptToAgent,
  setupFinishNotification,
  waitForAgentRunStartWithTimeout,
} from "./agent-prompt.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
  AgentMode,
  AgentPermissionResponse,
  AgentPermissionResult,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  FetchCatalogOptions,
  ProviderCatalog,
} from "./agent-sdk-types.js";
import type { AgentManagerEvent, ManagedAgent } from "./agent-manager.js";

interface CapturedLogger {
  logger: Logger;
  records: Array<Record<string, unknown>>;
  nextRecord: Promise<void>;
}

const tempDirs: string[] = [];
const TEST_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

function createCapturedLogger(): CapturedLogger {
  const records: Array<Record<string, unknown>> = [];
  let resolveNextRecord!: () => void;
  const nextRecord = new Promise<void>((resolve) => {
    resolveNextRecord = resolve;
  });
  const logger = pino(
    { level: "trace" },
    {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
        resolveNextRecord();
      },
    },
  );
  return { logger, records, nextRecord };
}

function hasLogMessage(records: Array<Record<string, unknown>>, message: string): boolean {
  return records.some((record) => record.msg === message);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

interface FinishNotificationScenarioOptions {
  childLastAssistantMessage?: string | null;
  childParentAgentId?: string | null;
  requireParentOwnership?: boolean;
  parentPromptError?: Error;
  logger?: Logger;
}

interface FinishNotificationScenario {
  startWatchingChild(): void;
  finishChild(): void;
  finishChildAndReadParentPrompt(): Promise<string>;
  wasParentPrompted(): boolean;
}

function createFinishNotificationScenario(
  options?: FinishNotificationScenarioOptions,
): FinishNotificationScenario {
  let subscriber: ((event: AgentManagerEvent) => void) | null = null;
  let resolveParentPrompt: ((prompt: string) => void) | null = null;
  let parentPrompted = false;

  const childAgent: ManagedAgent = Object.create(null);
  Reflect.set(childAgent, "id", "child-agent");
  Reflect.set(childAgent, "lifecycle", "idle");
  Reflect.set(childAgent, "config", { title: "Child Agent" });

  const callerAgent: ManagedAgent = Object.create(null);
  Reflect.set(callerAgent, "id", "caller-agent");
  Reflect.set(callerAgent, "lifecycle", "idle");
  Reflect.set(callerAgent, "config", { title: "Caller Agent" });

  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(agentManager, "getAgent", (agentId: string) => {
    if (agentId === "child-agent") {
      return childAgent;
    }
    if (agentId === "caller-agent") {
      return callerAgent;
    }
    return null;
  });
  Reflect.set(agentManager, "subscribe", (callback: (event: AgentManagerEvent) => void) => {
    subscriber = callback;
    return () => {
      subscriber = null;
    };
  });
  Reflect.set(agentManager, "getLastAssistantMessage", async () => {
    return options?.childLastAssistantMessage ?? null;
  });
  Reflect.set(agentManager, "tryRunOutOfBand", () => false);
  Reflect.set(agentManager, "hasInFlightRun", () => Boolean(options?.parentPromptError));
  Reflect.set(agentManager, "waitForAgentRunStart", async () => {});
  Reflect.set(agentManager, "streamAgent", (_agentId: string, prompt: string) => {
    parentPrompted = true;
    resolveParentPrompt?.(prompt);
    return (async function* noop() {})();
  });
  Reflect.set(agentManager, "replaceAgentRun", async (_agentId: string, prompt: string) => {
    resolveParentPrompt?.(prompt);
    throw options?.parentPromptError;
  });

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", async (agentId: string) => {
    if (agentId === "child-agent") {
      const parentAgentId =
        options?.childParentAgentId === undefined ? "caller-agent" : options.childParentAgentId;
      return {
        title: "Child Agent",
        labels: parentAgentId ? { "paseo.parent-agent-id": parentAgentId } : {},
      };
    }
    return null;
  });

  return {
    startWatchingChild() {
      setupFinishNotification({
        agentManager,
        agentStorage,
        childAgentId: "child-agent",
        callerAgentId: "caller-agent",
        requireParentOwnership: options?.requireParentOwnership,
        logger: options?.logger ?? createTestLogger(),
      });
    },
    finishChild() {
      childAgent.lifecycle = "running";
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });

      childAgent.lifecycle = "idle";
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });
    },
    async finishChildAndReadParentPrompt() {
      const parentPrompt = new Promise<string>((resolve) => {
        resolveParentPrompt = resolve;
      });
      this.finishChild();

      return parentPrompt;
    },
    wasParentPrompted() {
      return parentPrompted;
    },
  };
}

class FinishNotificationTestSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly id = randomUUID();
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turnCounter = 0;
  private runtimeModel: string | null = null;
  private pendingStart: ReturnType<typeof deferred<{ turnId: string }>> | null = null;
  startTurnCount = 0;
  lastPrompt: AgentPromptInput | null = null;

  constructor(
    private readonly config: AgentSessionConfig,
    private readonly role: "child" | "caller",
    private readonly callerMode: "success" | "reject" | "pending-start",
  ) {}

  async run(_prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.turnCounter += 1;
    this.startTurnCount += 1;
    this.lastPrompt = prompt;
    const turnId = `${this.role}-turn-${this.turnCounter}`;

    if (this.role === "child") {
      setTimeout(() => {
        this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
        this.runtimeModel = "gpt-5.2-codex";
      }, 0);
      return { turnId };
    }

    if (this.callerMode === "success") {
      setTimeout(() => {
        this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
        this.runtimeModel = "gpt-5.2-codex";
      }, 0);
      return { turnId };
    }

    if (this.callerMode === "reject") {
      throw new Error("Caller agent notification failed before start");
    }

    this.pendingStart = deferred<{ turnId: string }>();
    return await this.pendingStart.promise;
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  pushEvent(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) {
      callback(event);
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.runtimeModel ?? this.config.model ?? null,
      modeId: this.config.modeId ?? null,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [];
  }

  async getCurrentMode(): Promise<string | null> {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(
    _requestId: string,
    _response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void> {
    return undefined;
  }

  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}

  resolvePendingStart(turnId = `${this.role}-turn-${this.turnCounter}`): void {
    if (!this.pendingStart) {
      throw new Error("No pending start to resolve");
    }
    this.pendingStart.resolve({ turnId });
    this.pendingStart = null;
  }

  finishTurn(turnId = `${this.role}-turn-${this.turnCounter}`): void {
    this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
    this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
    this.runtimeModel = "gpt-5.2-codex";
  }
}

class FinishNotificationTestClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly sessions = new Map<string, FinishNotificationTestSession>();

  constructor(private readonly callerMode: "success" | "reject" | "pending-start") {}

  async createSession(
    config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const role = config.cwd?.includes("caller-agent") ? "caller" : "child";
    const session = new FinishNotificationTestSession(config, role, this.callerMode);
    this.sessions.set(role, session);
    return session;
  }

  async resumeSession(): Promise<AgentSession> {
    throw new Error("No session to resume");
  }

  async fetchCatalog(_options: FetchCatalogOptions): Promise<ProviderCatalog> {
    return {
      models: [{ provider: this.provider, id: "test-model", label: "Test Model", isDefault: true }],
      modes: [],
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

async function createRealFinishNotificationHarness(options: {
  callerMode: "success" | "reject" | "pending-start";
  logger?: Logger;
}) {
  const workdir = mkdtempSync(join(tmpdir(), "finish-notification-"));
  tempDirs.push(workdir);
  const childCwd = join(workdir, "child-agent");
  const callerCwd = join(workdir, "caller-agent");
  mkdirSync(childCwd, { recursive: true });
  mkdirSync(callerCwd, { recursive: true });
  const logger = options.logger ?? createTestLogger();
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new FinishNotificationTestClient(options.callerMode);
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });
  const childAgent = await manager.createAgent(
    {
      provider: "codex",
      cwd: childCwd,
      modeId: "full-access",
      model: "test-model",
    },
    undefined,
    { workspaceId: undefined },
  );
  const callerAgent = await manager.createAgent(
    {
      provider: "codex",
      cwd: callerCwd,
      modeId: "full-access",
      model: "test-model",
    },
    undefined,
    { workspaceId: undefined },
  );
  let activeStartWaiters = 0;
  let maxActiveStartWaiters = 0;
  const originalWaitForAgentRunStart = manager.waitForAgentRunStart.bind(manager);
  manager.waitForAgentRunStart = vi.fn(async (...args) => {
    activeStartWaiters += 1;
    maxActiveStartWaiters = Math.max(maxActiveStartWaiters, activeStartWaiters);
    try {
      return await originalWaitForAgentRunStart(...args);
    } finally {
      activeStartWaiters -= 1;
    }
  });

  return {
    manager,
    storage,
    client,
    childAgent,
    callerAgent,
    logger,
    getActiveStartWaiters: () => activeStartWaiters,
    getMaxActiveStartWaiters: () => maxActiveStartWaiters,
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isSystemInjectedEnvelope matches the envelope formatSystemNotificationPrompt produces", () => {
  expect(isSystemInjectedEnvelope(formatSystemNotificationPrompt("child finished"))).toBe(true);
  expect(isSystemInjectedEnvelope("hello world")).toBe(false);
});

test("sendPromptToAgent forwards the client message id as run options", async () => {
  const agent: ManagedAgent = Object.create(null);
  Reflect.set(agent, "id", "agent-1");
  Reflect.set(agent, "provider", "codex");

  const streamAgentSpy = vi.fn(() => (async function* noop() {})());
  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn(() => agent),
  );
  Reflect.set(agentManager, "tryRunOutOfBand", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "hasInFlightRun", vi.fn().mockReturnValue(false));
  Reflect.set(
    agentManager,
    "waitForAgentRunStart",
    vi.fn(async () => {}),
  );
  Reflect.set(agentManager, "streamAgent", streamAgentSpy);

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(
    agentStorage,
    "get",
    vi.fn(async () => null),
  );

  await sendPromptToAgent({
    agentManager,
    agentStorage,
    agentId: "agent-1",
    prompt: "hello",
    messageId: "msg-client-1",
    runOptions: { outputSchema: { type: "object" } },
    logger: createTestLogger(),
  });

  expect(streamAgentSpy).toHaveBeenCalledWith("agent-1", "hello", {
    outputSchema: { type: "object" },
    messageId: "msg-client-1",
  });
});

test("waitForAgentRunStartWithTimeout aborts the authoritative start waiter without leaking listeners", async () => {
  vi.useFakeTimers();
  const agent: ManagedAgent = Object.create(null);
  Reflect.set(agent, "id", "agent-timeout");
  Reflect.set(agent, "provider", "codex");

  let activeWaiters = 0;
  let maxActiveWaiters = 0;
  const waitForAgentRunStartSpy = vi.fn(
    async (_agentId: string, options?: { signal?: AbortSignal }) => {
      activeWaiters += 1;
      maxActiveWaiters = Math.max(maxActiveWaiters, activeWaiters);
      try {
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              reject(
                Object.assign(new Error(String(options.signal?.reason ?? "aborted")), {
                  name: "AbortError",
                }),
              );
            },
            { once: true },
          );
        });
      } finally {
        activeWaiters -= 1;
      }
    },
  );

  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn(() => agent),
  );
  Reflect.set(agentManager, "tryRunOutOfBand", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "hasInFlightRun", vi.fn().mockReturnValue(false));
  Reflect.set(
    agentManager,
    "streamAgent",
    vi.fn(() => (async function* noop() {})()),
  );
  Reflect.set(agentManager, "waitForAgentRunStart", waitForAgentRunStartSpy);

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(
    agentStorage,
    "get",
    vi.fn(async () => null),
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const dispatch = await sendPromptToAgent({
      agentManager,
      agentStorage,
      agentId: "agent-timeout",
      prompt: `timeout attempt ${attempt}`,
      logger: createTestLogger(),
    });
    const timeoutAssertion = expect(
      waitForAgentRunStartWithTimeout(dispatch.startAcknowledged),
    ).rejects.toBeInstanceOf(AgentRunStartTimeoutError);
    await vi.advanceTimersByTimeAsync(15_000);
    await timeoutAssertion;
  }

  expect(waitForAgentRunStartSpy).toHaveBeenCalledTimes(3);
  expect(activeWaiters).toBe(0);
  expect(maxActiveWaiters).toBe(1);
  vi.useRealTimers();
});

test("finish notifications tell the parent the child's last assistant message", async () => {
  const scenario = createFinishNotificationScenario({
    childLastAssistantMessage: "Implemented the cleanup and all checks pass.",
  });

  scenario.startWatchingChild();
  const parentPrompt = await scenario.finishChildAndReadParentPrompt();

  expect(parentPrompt).toEqual(
    formatSystemNotificationPrompt(
      "Agent child-agent (Child Agent) finished.\n\n<agent-response>\nImplemented the cleanup and all checks pass.\n</agent-response>",
    ),
  );
});

test("detaching a child ends its parent-owned finish notification", async () => {
  const scenario = createFinishNotificationScenario({
    childParentAgentId: null,
    requireParentOwnership: true,
  });
  scenario.startWatchingChild();
  scenario.finishChild();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(scenario.wasParentPrompted()).toBe(false);
});

test("follow-up finish notifications do not require a parent relationship", async () => {
  const scenario = createFinishNotificationScenario({ childParentAgentId: "another-agent" });

  scenario.startWatchingChild();
  const parentPrompt = await scenario.finishChildAndReadParentPrompt();

  expect(parentPrompt).toContain("Agent child-agent (Child Agent) finished.");
});

test("finish notifications log a rejected parent prompt without an unhandled rejection", async () => {
  const captured = createCapturedLogger();
  const scenario = createFinishNotificationScenario({
    parentPromptError: new Error("parent provider rejected replacement"),
    logger: captured.logger,
  });

  scenario.startWatchingChild();
  await scenario.finishChildAndReadParentPrompt();
  await vi.waitFor(() => {
    expect(captured.records.some((record) => record.msg === "Failed to notify caller agent")).toBe(
      true,
    );
  });

  expect(
    captured.records.some(
      (record) =>
        record.msg === "Failed to notify caller agent" &&
        record.childAgentId === "child-agent" &&
        record.callerAgentId === "caller-agent" &&
        record.reason === "finished" &&
        (record.err as { message?: string } | undefined)?.message ===
          "parent provider rejected replacement",
    ),
  ).toBe(true);
});

test("real-manager finish notifications start and complete the caller run without leaking subscriptions", async () => {
  const harness = await createRealFinishNotificationHarness({ callerMode: "success" });
  const baselineSubscriptions = harness.manager.subscriptionCount();

  setupFinishNotification({
    agentManager: harness.manager,
    agentStorage: harness.storage,
    childAgentId: harness.childAgent.id,
    callerAgentId: harness.callerAgent.id,
    logger: harness.logger,
  });
  expect(harness.manager.subscriptionCount()).toBe(baselineSubscriptions + 1);

  const childDispatch = await sendPromptToAgent({
    agentManager: harness.manager,
    agentStorage: harness.storage,
    agentId: harness.childAgent.id,
    prompt: "finish notification child task",
    logger: harness.logger,
  });
  if (!childDispatch.outOfBand && !childDispatch.skippedReason) {
    await waitForAgentRunStartWithTimeout(childDispatch.startAcknowledged);
  }

  await vi.waitFor(() => {
    expect(harness.client.sessions.get("caller")?.lastPrompt).toEqual(
      formatSystemNotificationPrompt(
        `Agent ${harness.childAgent.id} (${harness.childAgent.id}) finished.`,
      ),
    );
  });
  await vi.waitFor(() => {
    expect(harness.manager.getAgent(harness.callerAgent.id)?.lifecycle).toBe("idle");
  });
  expect(harness.getActiveStartWaiters()).toBe(0);
  expect(harness.getMaxActiveStartWaiters()).toBeGreaterThanOrEqual(1);
  expect(harness.manager.subscriptionCount()).toBe(baselineSubscriptions);
});

test("real-manager finish notifications log caller start rejection and release the authoritative waiter", async () => {
  const captured = createCapturedLogger();
  const harness = await createRealFinishNotificationHarness({
    callerMode: "reject",
    logger: captured.logger,
  });
  const baselineSubscriptions = harness.manager.subscriptionCount();

  setupFinishNotification({
    agentManager: harness.manager,
    agentStorage: harness.storage,
    childAgentId: harness.childAgent.id,
    callerAgentId: harness.callerAgent.id,
    logger: captured.logger,
  });
  expect(harness.manager.subscriptionCount()).toBe(baselineSubscriptions + 1);

  const childDispatch = await sendPromptToAgent({
    agentManager: harness.manager,
    agentStorage: harness.storage,
    agentId: harness.childAgent.id,
    prompt: "finish notification child task",
    logger: captured.logger,
  });
  if (!childDispatch.outOfBand && !childDispatch.skippedReason) {
    await waitForAgentRunStartWithTimeout(childDispatch.startAcknowledged);
  }

  await vi.waitFor(() => {
    expect(
      hasLogMessage(
        captured.records,
        "Caller agent notification run failed before start acknowledgement",
      ),
    ).toBe(true);
  });
  expect(harness.getActiveStartWaiters()).toBe(0);
  expect(harness.manager.subscriptionCount()).toBe(baselineSubscriptions);
});

test("real-manager finish notifications time out a hung caller start, clean up the waiter, and tolerate a late start", async () => {
  vi.useFakeTimers();
  const captured = createCapturedLogger();
  const harness = await createRealFinishNotificationHarness({
    callerMode: "pending-start",
    logger: captured.logger,
  });
  const baselineSubscriptions = harness.manager.subscriptionCount();

  setupFinishNotification({
    agentManager: harness.manager,
    agentStorage: harness.storage,
    childAgentId: harness.childAgent.id,
    callerAgentId: harness.callerAgent.id,
    logger: captured.logger,
  });
  expect(harness.manager.subscriptionCount()).toBe(baselineSubscriptions + 1);

  const childDispatch = await sendPromptToAgent({
    agentManager: harness.manager,
    agentStorage: harness.storage,
    agentId: harness.childAgent.id,
    prompt: "finish notification child task",
    logger: captured.logger,
  });
  if (!childDispatch.outOfBand && !childDispatch.skippedReason) {
    await waitForAgentRunStartWithTimeout(childDispatch.startAcknowledged);
  }

  await vi.advanceTimersByTimeAsync(15_000);
  await vi.waitFor(() => {
    expect(
      hasLogMessage(
        captured.records,
        "Caller agent notification run did not acknowledge start before timeout",
      ),
    ).toBe(true);
  });
  expect(harness.getActiveStartWaiters()).toBe(0);
  expect(harness.manager.subscriptionCount()).toBe(baselineSubscriptions);

  const callerSession = harness.client.sessions.get("caller");
  if (!callerSession) {
    throw new Error("Expected caller session");
  }
  callerSession.resolvePendingStart("caller-turn-1");
  await vi.runAllTimersAsync();
  callerSession.finishTurn("caller-turn-1");
  await vi.runAllTimersAsync();

  await vi.waitFor(() => {
    expect(harness.manager.getAgent(harness.callerAgent.id)?.lifecycle).toBe("idle");
  });
  expect(callerSession.startTurnCount).toBe(1);
  expect(harness.getActiveStartWaiters()).toBe(0);
  expect(harness.manager.subscriptionCount()).toBe(baselineSubscriptions);
});

it("does not notify archived callers", async () => {
  let subscriber: ((event: AgentManagerEvent) => void) | null = null;

  const childAgent: ManagedAgent = Object.create(null);
  Reflect.set(childAgent, "id", "child-agent");
  Reflect.set(childAgent, "lifecycle", "idle");
  Reflect.set(childAgent, "config", { title: "Child Agent" });

  const callerAgent: ManagedAgent = Object.create(null);
  Reflect.set(callerAgent, "id", "caller-agent");
  Reflect.set(callerAgent, "lifecycle", "idle");
  Reflect.set(callerAgent, "config", { title: "Caller Agent" });

  const streamAgentSpy = vi.fn(() => (async function* noop() {})());
  const replaceAgentRunSpy = vi.fn(() => (async function* noop() {})());

  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn((agentId: string) => {
      if (agentId === "child-agent") {
        return childAgent;
      }
      if (agentId === "caller-agent") {
        return callerAgent;
      }
      return null;
    }),
  );
  Reflect.set(
    agentManager,
    "subscribe",
    vi.fn((callback: (event: AgentManagerEvent) => void) => {
      subscriber = callback;
      return () => {
        subscriber = null;
      };
    }),
  );
  Reflect.set(agentManager, "hasInFlightRun", vi.fn().mockReturnValue(false));
  Reflect.set(
    agentManager,
    "waitForAgentRunStart",
    vi.fn(async () => {}),
  );
  Reflect.set(agentManager, "streamAgent", streamAgentSpy);
  Reflect.set(agentManager, "replaceAgentRun", replaceAgentRunSpy);

  const agentStorageGetSpy = vi.fn(async (agentId: string) =>
    agentId === "caller-agent" ? { archivedAt: "2024-01-01" } : null,
  );
  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", agentStorageGetSpy);

  setupFinishNotification({
    agentManager,
    agentStorage,
    childAgentId: "child-agent",
    callerAgentId: "caller-agent",
    logger: createTestLogger(),
  });

  expect(subscriber).not.toBeNull();

  childAgent.lifecycle = "running";
  subscriber?.({
    type: "agent_state",
    agent: childAgent,
  });

  childAgent.lifecycle = "idle";
  subscriber?.({
    type: "agent_state",
    agent: childAgent,
  });

  await vi.waitFor(() => {
    expect(agentStorageGetSpy).toHaveBeenCalledWith("caller-agent");
  });

  expect(streamAgentSpy).not.toHaveBeenCalled();
  expect(replaceAgentRunSpy).not.toHaveBeenCalled();
});
