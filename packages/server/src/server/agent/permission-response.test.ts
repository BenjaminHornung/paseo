import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import pino, { type Logger } from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { respondToAgentPermission } from "./permission-response.js";
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

const tempDirs: string[] = [];

interface CapturedLogger {
  logger: Logger;
  records: Array<Record<string, unknown>>;
}

function hasLogMessage(records: Array<Record<string, unknown>>, message: string): boolean {
  return records.some((record) => record.msg === message);
}

async function captureUnhandledRejections<T>(run: () => Promise<T>): Promise<unknown[]> {
  const reasons: unknown[] = [];
  const handler = (reason: unknown) => {
    reasons.push(reason);
  };
  process.on("unhandledRejection", handler);
  try {
    await run();
    await Promise.resolve();
  } finally {
    process.off("unhandledRejection", handler);
  }
  return reasons;
}

function createCapturedLogger(): CapturedLogger {
  const records: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level: "trace" },
    {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { logger, records };
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

class PermissionFollowUpSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly id = randomUUID();
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turnCounter = 0;
  private runtimeModel: string | null = null;
  private pendingStart: ReturnType<typeof deferred<{ turnId: string }>> | null = null;

  constructor(
    private readonly config: AgentSessionConfig,
    private readonly mode: "success" | "reject" | "pending-start",
    private readonly followUpPrompt: AgentPromptInput,
  ) {}

  async run(_prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.turnCounter += 1;
    const turnId = `turn-${this.turnCounter}`;
    if (prompt !== this.followUpPrompt) {
      throw new Error("Unexpected prompt");
    }

    if (this.mode === "success") {
      setTimeout(() => {
        this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
        this.runtimeModel = "gpt-5.2-codex";
      }, 0);
      return { turnId };
    }

    if (this.mode === "reject") {
      throw new Error("Permission follow-up failed before start");
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
    return { followUpPrompt: this.followUpPrompt };
  }

  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}

  resolvePendingStart(turnId = `turn-${this.turnCounter}`): void {
    if (!this.pendingStart) {
      throw new Error("No pending start to resolve");
    }
    this.pendingStart.resolve({ turnId });
    this.pendingStart = null;
  }

  finishTurn(turnId = `turn-${this.turnCounter}`): void {
    this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
    this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
    this.runtimeModel = "gpt-5.2-codex";
  }
}

class PermissionFollowUpClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  session: PermissionFollowUpSession | null = null;

  constructor(
    private readonly mode: "success" | "reject" | "pending-start",
    private readonly followUpPrompt: AgentPromptInput,
  ) {}

  async createSession(
    config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.session = new PermissionFollowUpSession(config, this.mode, this.followUpPrompt);
    return this.session;
  }

  async resumeSession(): Promise<AgentSession> {
    if (!this.session) {
      throw new Error("No session to resume");
    }
    return this.session;
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

async function createHarness(options: {
  mode: "success" | "reject" | "pending-start";
  logger?: Logger;
  followUpPrompt?: AgentPromptInput;
}) {
  const workdir = mkdtempSync(join(tmpdir(), "permission-response-"));
  tempDirs.push(workdir);
  const logger = options.logger ?? createTestLogger();
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const followUpPrompt = options.followUpPrompt ?? "implement the approved plan";
  const client = new PermissionFollowUpClient(options.mode, followUpPrompt);
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });
  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
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
    workdir,
    logger,
    storage,
    client,
    manager,
    agent,
    followUpPrompt,
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

describe("respondToAgentPermission", () => {
  test("starts and completes a real-manager permission follow-up run without leaking the start waiter", async () => {
    const { manager, agent, getActiveStartWaiters, getMaxActiveStartWaiters } = await createHarness(
      {
        mode: "success",
      },
    );
    const baselineSubscriptions = manager.subscriptionCount();

    await respondToAgentPermission({
      agentManager: manager,
      agentId: agent.id,
      requestId: "permission-1",
      response: { behavior: "allow" },
      logger: createTestLogger(),
    });

    await vi.waitFor(() => {
      expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
    });
    expect(getActiveStartWaiters()).toBe(0);
    expect(getMaxActiveStartWaiters()).toBe(1);
    expect(manager.subscriptionCount()).toBe(baselineSubscriptions);
  });

  test("logs a real-manager permission follow-up start rejection without leaking the authoritative waiter", async () => {
    const captured = createCapturedLogger();
    const { manager, agent, getActiveStartWaiters, getMaxActiveStartWaiters } = await createHarness(
      {
        mode: "reject",
        logger: captured.logger,
      },
    );
    const baselineSubscriptions = manager.subscriptionCount();

    await respondToAgentPermission({
      agentManager: manager,
      agentId: agent.id,
      requestId: "permission-reject",
      response: { behavior: "allow" },
      logger: captured.logger,
    });

    await vi.waitFor(() => {
      expect(manager.getAgent(agent.id)?.lifecycle).toBe("error");
    });
    await vi.waitFor(() => {
      expect(
        hasLogMessage(
          captured.records,
          "Permission follow-up run failed before start acknowledgement",
        ),
      ).toBe(true);
    });
    expect(getActiveStartWaiters()).toBe(0);
    expect(getMaxActiveStartWaiters()).toBe(1);
    expect(manager.subscriptionCount()).toBe(baselineSubscriptions);
  });

  test("times out a hung real-manager permission follow-up start, cleans up the authoritative waiter, and tolerates a late provider start", async () => {
    vi.useFakeTimers();
    const captured = createCapturedLogger();
    const { manager, agent, client, getActiveStartWaiters, getMaxActiveStartWaiters } =
      await createHarness({
        mode: "pending-start",
        logger: captured.logger,
      });
    const baselineSubscriptions = manager.subscriptionCount();

    await respondToAgentPermission({
      agentManager: manager,
      agentId: agent.id,
      requestId: "permission-timeout",
      response: { behavior: "allow" },
      logger: captured.logger,
    });

    expect(getActiveStartWaiters()).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => {
      expect(
        hasLogMessage(
          captured.records,
          "Permission follow-up run did not acknowledge start before timeout",
        ),
      ).toBe(true);
    });
    expect(getActiveStartWaiters()).toBe(0);

    const session = client.session;
    if (!session) {
      throw new Error("Expected permission follow-up session");
    }
    session.resolvePendingStart("turn-1");
    await vi.runAllTimersAsync();
    session.finishTurn("turn-1");
    await vi.runAllTimersAsync();
    await vi.waitFor(() => {
      expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
    });
    expect(getActiveStartWaiters()).toBe(0);
    expect(getMaxActiveStartWaiters()).toBe(1);
    expect(manager.subscriptionCount()).toBe(baselineSubscriptions);
  });

  test("swallows permission follow-up background ownership rejections even if logger.warn throws", async () => {
    vi.useFakeTimers();
    const { manager, agent, getActiveStartWaiters, getMaxActiveStartWaiters } = await createHarness(
      {
        mode: "pending-start",
      },
    );
    const baselineSubscriptions = manager.subscriptionCount();
    const throwingLogger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(() => {
        throw new Error("logger warn failed");
      }),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(() => throwingLogger),
    } as unknown as Logger;

    const unhandledRejections = await captureUnhandledRejections(async () => {
      await respondToAgentPermission({
        agentManager: manager,
        agentId: agent.id,
        requestId: "permission-timeout-throwing-logger",
        response: { behavior: "allow" },
        logger: throwingLogger,
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.runAllTimersAsync();
    });

    expect(unhandledRejections).toEqual([]);
    expect(getActiveStartWaiters()).toBe(0);
    expect(getMaxActiveStartWaiters()).toBe(1);
    expect(manager.subscriptionCount()).toBe(baselineSubscriptions);
  });
});
