import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";

import type { AgentPromptInput, AgentRunOptions } from "./agent/agent-sdk-types.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage, type StoredAgentRecord } from "./agent/agent-storage.js";
import {
  AgentMessageQueueService,
  AgentMessageQueueStore,
  buildQueuedAgentPrompt,
} from "./agent-message-queue.js";
import * as atomicFile from "./atomic-file.js";

const tempDirs: string[] = [];

async function createStore(): Promise<{ dir: string; store: AgentMessageQueueStore }> {
  const dir = await mkdtemp(path.join(tmpdir(), "paseo-agent-message-queue-"));
  tempDirs.push(dir);
  return {
    dir,
    store: new AgentMessageQueueStore({
      filePath: path.join(dir, "agent-message-queue.json"),
      logger: pino({ level: "silent" }),
    }),
  };
}

function createStoredRecord(overrides: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  const now = "2026-06-30T00:00:00.000Z";
  return {
    id: "agent-record",
    provider: "codex",
    cwd: "/workspace/project",
    createdAt: now,
    updatedAt: now,
    labels: {},
    lastStatus: "idle",
    config: null,
    persistence: null,
    ...overrides,
  };
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

function withReplayAdmissionSupport<T extends object>(manager: T) {
  const admissionState = new Map<string, "committed" | "pending">();
  return {
    ...manager,
    admitRecordedUserMessage: vi.fn(async (_agentId: string, _prompt: AgentPromptInput, input) => {
      const normalized = input?.messageId?.trim();
      if (!normalized) {
        return { disposition: "new" as const };
      }
      const status = admissionState.get(normalized);
      if (status === "committed") {
        return {
          disposition: "duplicate" as const,
          messageId: normalized,
          fingerprint: `fp:${normalized}`,
        };
      }
      if (status === "pending") {
        return {
          disposition: "pending" as const,
          messageId: normalized,
          fingerprint: `fp:${normalized}`,
          error: "A previous delivery with this client messageId has an unknown outcome",
        };
      }
      return {
        disposition: "new" as const,
        messageId: normalized,
        fingerprint: `fp:${normalized}`,
      };
    }),
    commitRecordedUserMessageAdmissionForAgent: vi.fn(async (_agentId: string, admission) => {
      if (admission.messageId) {
        admissionState.set(admission.messageId, "committed");
      }
    }),
    releaseRecordedUserMessageAdmissionForAgent: vi.fn(async (_agentId: string, admission) => {
      if (admission.messageId) {
        admissionState.delete(admission.messageId);
      }
    }),
    settleRecordedUserMessageAdmissionPendingForAgent: vi.fn((_agentId: string, admission) => {
      if (admission.messageId) {
        admissionState.set(admission.messageId, "pending");
      }
    }),
  };
}

function createReplayAwareAgentManager(options?: {
  startBehavior?: "resolve" | "never" | "reject";
  startError?: Error;
  dispatchError?: Error;
  commitError?: Error;
  onProviderStart?: (prompt: AgentPromptInput, runOptions?: AgentRunOptions) => void;
}) {
  const admissionState = new Map<string, "committed" | "pending">();
  const normalizedMessageIds: string[] = [];
  const streamAgentSpy = vi.fn(
    (_agentId: string, prompt: AgentPromptInput, runOptions?: AgentRunOptions) => {
      options?.onProviderStart?.(prompt, runOptions);
      if (options?.dispatchError) {
        throw options.dispatchError;
      }
      return (async function* noop() {})();
    },
  );
  const waitForAgentRunStartSpy = vi.fn(
    async (_agentId: string, input?: { signal?: AbortSignal }) => {
      if (options?.startBehavior === "reject") {
        throw options.startError ?? new Error("provider start rejected");
      }
      if (options?.startBehavior === "never") {
        await new Promise<void>((_resolve, reject) => {
          input?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error(String(input.signal?.reason ?? "aborted")), {
                  name: "AbortError",
                }),
              ),
            {
              once: true,
            },
          );
        });
        return;
      }
    },
  );
  const manager = {
    getAgent: () =>
      ({
        id: "agent-a",
        lifecycle: "idle",
        provider: "codex",
      }) as ReturnType<AgentManager["getAgent"]>,
    hasInFlightRun: () => false,
    subscribe: () => () => {},
    addAgentArchivedCallback: () => () => {},
    waitForAgentClose: async () => {},
    tryRunOutOfBand: () => false,
    streamAgent: streamAgentSpy,
    replaceAgentRun: vi.fn(() => (async function* noop() {})()),
    waitForAgentRunStart: waitForAgentRunStartSpy,
    admitRecordedUserMessage: vi.fn(async (_agentId: string, _prompt: AgentPromptInput, input) => {
      const normalized = input?.messageId?.trim();
      if (!normalized) {
        return { disposition: "new" as const };
      }
      normalizedMessageIds.push(normalized);
      const status = admissionState.get(normalized);
      if (status === "committed") {
        return {
          disposition: "duplicate" as const,
          messageId: normalized,
          fingerprint: `fp:${normalized}`,
        };
      }
      if (status === "pending") {
        return {
          disposition: "pending" as const,
          messageId: normalized,
          fingerprint: `fp:${normalized}`,
          error: "A previous delivery with this client messageId has an unknown outcome",
        };
      }
      return {
        disposition: "new" as const,
        messageId: normalized,
        fingerprint: `fp:${normalized}`,
      };
    }),
    commitRecordedUserMessageAdmissionForAgent: vi.fn(async (_agentId: string, admission) => {
      if (admission.messageId) {
        admissionState.set(admission.messageId, "pending");
      }
      if (options?.commitError) {
        throw options.commitError;
      }
      if (admission.messageId) {
        admissionState.set(admission.messageId, "committed");
      }
    }),
    releaseRecordedUserMessageAdmissionForAgent: vi.fn(async (_agentId: string, admission) => {
      if (admission.messageId) {
        admissionState.delete(admission.messageId);
      }
    }),
    settleRecordedUserMessageAdmissionPendingForAgent: vi.fn((_agentId: string, admission) => {
      if (admission.messageId) {
        admissionState.set(admission.messageId, "pending");
      }
    }),
  } satisfies Pick<
    AgentManager,
    | "getAgent"
    | "hasInFlightRun"
    | "subscribe"
    | "addAgentArchivedCallback"
    | "waitForAgentClose"
    | "tryRunOutOfBand"
    | "streamAgent"
    | "replaceAgentRun"
    | "waitForAgentRunStart"
    | "admitRecordedUserMessage"
    | "commitRecordedUserMessageAdmissionForAgent"
    | "releaseRecordedUserMessageAdmissionForAgent"
    | "settleRecordedUserMessageAdmissionPendingForAgent"
  >;
  return { manager, admissionState, normalizedMessageIds, streamAgentSpy, waitForAgentRunStartSpy };
}

async function createRealQueueReplayHarness(options?: { onStartTurn?: () => void }) {
  const { dir, store } = await createStore();
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(dir, "agents"), logger);
  const manager = new AgentManager({
    clients: createTestAgentClients({
      onStartTurn: () => {
        options?.onStartTurn?.();
      },
    }),
    registry: storage,
    logger,
  });
  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: dir,
      modeId: "full-access",
      model: "test-model",
    },
    undefined,
    { workspaceId: undefined },
  );
  const service = new AgentMessageQueueService({
    store,
    agentManager: manager,
    agentStorage: storage,
    logger,
    onQueueUpdated: () => {},
  });
  return { dir, store, logger, storage, manager, agent, service };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("persists queued agent messages and exposes summary payloads", async () => {
  const { dir, store } = await createStore();

  const first = await store.enqueue({
    agentId: "agent-a",
    messageId: "queued-1",
    text: "  first message  ",
    images: [{ data: "base64-image", mimeType: "image/png" }],
    attachments: [
      {
        type: "text",
        mimeType: "text/plain",
        title: "notes.txt",
        text: "attachment body",
      },
    ],
  });
  await store.enqueue({
    agentId: "agent-a",
    messageId: "queued-2",
    text: "second message",
  });

  expect(first.text).toBe("first message");

  const reloadedStore = new AgentMessageQueueStore({
    filePath: path.join(dir, "agent-message-queue.json"),
    logger: pino({ level: "silent" }),
  });

  await expect(reloadedStore.listQueues("agent-a")).resolves.toEqual([
    {
      agentId: "agent-a",
      revision: 2,
      messages: [
        {
          id: "queued-1",
          agentId: "agent-a",
          text: "first message",
          createdAt: expect.any(String),
          images: [{ data: "base64-image", mimeType: "image/png" }],
          attachments: [
            {
              type: "text",
              mimeType: "text/plain",
              title: "notes.txt",
              text: "attachment body",
            },
          ],
          imageCount: 1,
          attachmentCount: 1,
        },
        {
          id: "queued-2",
          agentId: "agent-a",
          text: "second message",
          createdAt: expect.any(String),
          images: [],
          attachments: [],
          imageCount: 0,
          attachmentCount: 0,
        },
      ],
    },
  ]);

  await expect(readFile(path.join(dir, "agent-message-queue.json"), "utf8")).resolves.toContain(
    '"revisions"',
  );
});

test("remove, shift, and unshift preserve queue order", async () => {
  const { store } = await createStore();

  await store.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });
  await store.enqueue({ agentId: "agent-a", messageId: "queued-2", text: "second" });
  await store.enqueue({ agentId: "agent-a", messageId: "queued-3", text: "third" });

  await expect(store.remove("agent-a", "missing")).resolves.toBeNull();
  await expect(store.remove("agent-a", "queued-2")).resolves.toMatchObject({
    id: "queued-2",
    text: "second",
  });

  const shifted = await store.shift("agent-a");
  expect(shifted?.id).toBe("queued-1");

  if (!shifted) {
    throw new Error("Expected shifted queued message");
  }
  await store.unshift(shifted);

  await expect(store.list("agent-a")).resolves.toMatchObject([
    { id: "queued-1", text: "first" },
    { id: "queued-3", text: "third" },
  ]);

  await expect(store.shift("agent-a")).resolves.toMatchObject({ id: "queued-1" });
  await expect(store.shift("agent-a")).resolves.toMatchObject({ id: "queued-3" });
  await expect(store.listQueues("agent-a")).resolves.toEqual([
    {
      agentId: "agent-a",
      revision: 8,
      messages: [],
    },
  ]);
});

test("explicit message ids are idempotent and do not bump revisions", async () => {
  const { store } = await createStore();

  const first = await store.enqueue({
    agentId: "agent-a",
    messageId: "queued-1",
    text: "first",
  });
  const duplicate = await store.enqueue({
    agentId: "agent-a",
    messageId: "queued-1",
    text: "duplicate text ignored",
  });

  expect(duplicate).toEqual(first);
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    {
      agentId: "agent-a",
      revision: 1,
      messages: [{ id: "queued-1", text: "first" }],
    },
  ]);
});

test("clearAgent keeps archive tombstones until delete drops them", async () => {
  const { store } = await createStore();

  await store.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });
  await expect(store.clearAgent("agent-a")).resolves.toEqual({
    agentId: "agent-a",
    revision: 2,
    messages: [],
  });

  await expect(store.listQueues("agent-a")).resolves.toEqual([
    {
      agentId: "agent-a",
      revision: 2,
      messages: [],
    },
  ]);
  await expect(store.listQueues()).resolves.toEqual([
    {
      agentId: "agent-a",
      revision: 2,
      messages: [],
    },
  ]);

  await expect(store.clearAgent("agent-a")).resolves.toBeNull();
  await expect(store.clearAgent("agent-a", { dropRevision: true })).resolves.toEqual({
    agentId: "agent-a",
    revision: 3,
    messages: [],
  });
  await expect(store.listQueues()).resolves.toEqual([]);
  await expect(store.listQueues("agent-a")).resolves.toEqual([
    {
      agentId: "agent-a",
      revision: 0,
      messages: [],
    },
  ]);
});

test("failed hard-delete persistence retains the queue and revision until retry", async () => {
  const { dir, store } = await createStore();
  const filePath = path.join(dir, "agent-message-queue.json");
  await store.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });

  const persistError = new Error("simulated hard-delete persist failure");
  const writeJsonFileAtomicSpy = vi
    .spyOn(atomicFile, "writeJsonFileAtomic")
    .mockRejectedValueOnce(persistError);
  try {
    await expect(store.clearAgent("agent-a", { dropRevision: true })).rejects.toBe(persistError);
    await expect(store.listQueues("agent-a")).resolves.toMatchObject([
      { agentId: "agent-a", revision: 1, messages: [{ id: "queued-1" }] },
    ]);

    const freshlyLoadedAfterFailure = new AgentMessageQueueStore({
      filePath,
      logger: pino({ level: "silent" }),
    });
    await expect(freshlyLoadedAfterFailure.listQueues("agent-a")).resolves.toMatchObject([
      { agentId: "agent-a", revision: 1, messages: [{ id: "queued-1" }] },
    ]);
  } finally {
    writeJsonFileAtomicSpy.mockRestore();
  }

  await expect(store.clearAgent("agent-a", { dropRevision: true })).resolves.toMatchObject({
    agentId: "agent-a",
    revision: 2,
    messages: [],
  });
  await expect(store.listQueues()).resolves.toEqual([]);

  const freshlyLoadedAfterRetry = new AgentMessageQueueStore({
    filePath,
    logger: pino({ level: "silent" }),
  });
  await expect(freshlyLoadedAfterRetry.listQueues()).resolves.toEqual([]);
  await expect(freshlyLoadedAfterRetry.listQueues("agent-a")).resolves.toMatchObject([
    { agentId: "agent-a", revision: 0, messages: [] },
  ]);
});

test("dispatch failure does not restore messages for non-replayable agents", async () => {
  const { store } = await createStore();
  const updates: Array<{ revision: number; messages: Array<{ id: string }> }> = [];
  const agentManager = {
    getAgent: () => null,
    hasInFlightRun: () => false,
    subscribe: () => () => {},
    addAgentArchivedCallback: () => () => {},
  } satisfies Pick<
    AgentManager,
    "getAgent" | "hasInFlightRun" | "subscribe" | "addAgentArchivedCallback"
  >;
  const agentStorage = {
    get: async () => null,
  } satisfies Pick<AgentStorage, "get">;
  const service = new AgentMessageQueueService({
    store,
    agentManager: withReplayAdmissionSupport(agentManager) as AgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: (queue) => {
      updates.push({
        revision: queue.revision,
        messages: queue.messages.map((message) => ({ id: message.id })),
      });
    },
  });

  await store.enqueue({ agentId: "missing-agent", messageId: "queued-1", text: "first" });

  await expect(service.dispatchNow("missing-agent", "queued-1")).rejects.toThrow(
    "Agent not found: missing-agent",
  );
  await expect(store.listQueues("missing-agent")).resolves.toEqual([
    {
      agentId: "missing-agent",
      revision: 2,
      messages: [],
    },
  ]);
  expect(updates).toEqual([{ revision: 2, messages: [] }]);
});

test("dispatch failure does not restore messages for live internal agents", async () => {
  const { store } = await createStore();
  const updates: Array<{ revision: number; messages: Array<{ id: string }> }> = [];
  const agentManager = {
    getAgent: () =>
      ({
        id: "internal-agent",
        lifecycle: "idle",
        internal: true,
      }) as ReturnType<AgentManager["getAgent"]>,
    hasInFlightRun: () => false,
    subscribe: () => () => {},
    addAgentArchivedCallback: () => () => {},
  } satisfies Pick<
    AgentManager,
    "getAgent" | "hasInFlightRun" | "subscribe" | "addAgentArchivedCallback"
  >;
  const agentStorage = {
    get: async () => null,
  } satisfies Pick<AgentStorage, "get">;
  const service = new AgentMessageQueueService({
    store,
    agentManager: withReplayAdmissionSupport(agentManager) as AgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: (queue) => {
      updates.push({
        revision: queue.revision,
        messages: queue.messages.map((message) => ({ id: message.id })),
      });
    },
  });

  await store.enqueue({ agentId: "internal-agent", messageId: "queued-1", text: "first" });

  await expect(service.dispatchNow("internal-agent", "queued-1")).rejects.toThrow();
  await expect(store.listQueues("internal-agent")).resolves.toEqual([
    {
      agentId: "internal-agent",
      revision: 2,
      messages: [],
    },
  ]);
  expect(updates).toEqual([{ revision: 2, messages: [] }]);
});

test("dispatch reports archived agents without restoring messages", async () => {
  const { store } = await createStore();
  const updates: Array<{ revision: number; messages: Array<{ id: string }> }> = [];
  const agentManager = {
    getAgent: () =>
      ({
        id: "archiving-agent",
        lifecycle: "idle",
      }) as ReturnType<AgentManager["getAgent"]>,
    hasInFlightRun: () => false,
    subscribe: () => () => {},
    addAgentArchivedCallback: () => () => {},
  } satisfies Pick<
    AgentManager,
    "getAgent" | "hasInFlightRun" | "subscribe" | "addAgentArchivedCallback"
  >;
  const agentStorage = {
    get: async (agentId: string) =>
      createStoredRecord({
        id: agentId,
        archivedAt: "2026-06-30T00:00:01.000Z",
      }),
  } satisfies Pick<AgentStorage, "get">;
  const service = new AgentMessageQueueService({
    store,
    agentManager: withReplayAdmissionSupport(agentManager) as AgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: (queue) => {
      updates.push({
        revision: queue.revision,
        messages: queue.messages.map((message) => ({ id: message.id })),
      });
    },
  });

  await store.enqueue({ agentId: "archiving-agent", messageId: "queued-1", text: "first" });

  await expect(service.dispatchNow("archiving-agent", "queued-1")).rejects.toThrow(
    "Queued message target agent is archived: archiving-agent",
  );
  await expect(store.listQueues("archiving-agent")).resolves.toEqual([
    {
      agentId: "archiving-agent",
      revision: 2,
      messages: [],
    },
  ]);
  expect(updates).toEqual([{ revision: 2, messages: [] }]);
});

test("queued dispatch reports skipped archived agents without unarchiving them", async () => {
  const { store } = await createStore();
  const agent = {
    id: "archived-before-send",
    lifecycle: "idle",
    provider: "codex",
  } as ReturnType<AgentManager["getAgent"]>;
  const unarchiveSnapshotSpy = vi.fn(async () => true);
  const notifyAgentStateSpy = vi.fn();
  const streamAgentSpy = vi.fn(() => (async function* noop() {})());
  const replaceAgentRunSpy = vi.fn(() => (async function* noop() {})());
  const agentManager = {
    getAgent: () => agent,
    hasInFlightRun: () => false,
    subscribe: () => () => {},
    addAgentArchivedCallback: () => () => {},
    unarchiveSnapshot: unarchiveSnapshotSpy,
    notifyAgentState: notifyAgentStateSpy,
    tryRunOutOfBand: () => false,
    streamAgent: streamAgentSpy,
    replaceAgentRun: replaceAgentRunSpy,
  } satisfies Pick<
    AgentManager,
    | "getAgent"
    | "hasInFlightRun"
    | "subscribe"
    | "addAgentArchivedCallback"
    | "unarchiveSnapshot"
    | "notifyAgentState"
    | "tryRunOutOfBand"
    | "streamAgent"
    | "replaceAgentRun"
  >;
  const agentStorage = {
    get: async (agentId: string) =>
      createStoredRecord({
        id: agentId,
        archivedAt: "2026-06-30T00:00:01.000Z",
      }),
  } satisfies Pick<AgentStorage, "get">;
  const service = new AgentMessageQueueService({
    store,
    agentManager: withReplayAdmissionSupport(agentManager) as AgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });

  await store.enqueue({
    agentId: "archived-before-send",
    messageId: "queued-1",
    text: "first",
  });

  await expect(service.dispatchNow("archived-before-send", "queued-1")).rejects.toThrow(
    "Queued message target agent is archived: archived-before-send",
  );

  expect(unarchiveSnapshotSpy).not.toHaveBeenCalled();
  expect(notifyAgentStateSpy).not.toHaveBeenCalled();
  expect(streamAgentSpy).not.toHaveBeenCalled();
  expect(replaceAgentRunSpy).not.toHaveBeenCalled();
  await expect(store.listQueues("archived-before-send")).resolves.toEqual([
    {
      agentId: "archived-before-send",
      revision: 2,
      messages: [],
    },
  ]);
});

test("auto drain dispatches queued messages FIFO one idle turn at a time", async () => {
  vi.useFakeTimers();
  const { store } = await createStore();
  let inFlight = false;
  const sent: Array<{ prompt: AgentPromptInput; messageId?: string }> = [];
  const agent = {
    id: "agent-a",
    lifecycle: "idle",
    provider: "codex",
  } as ReturnType<AgentManager["getAgent"]>;
  const streamAgentSpy = vi.fn(
    (_agentId: string, prompt: AgentPromptInput, runOptions?: AgentRunOptions) => {
      sent.push({ prompt, messageId: runOptions?.messageId });
      inFlight = true;
      return (async function* noop() {})();
    },
  );
  const replaceAgentRunSpy = vi.fn(() => (async function* noop() {})());
  const agentManager = {
    getAgent: () => agent,
    hasInFlightRun: () => inFlight,
    waitForAgentRunStart: async () => {},
    subscribe: () => () => {},
    addAgentArchivedCallback: () => () => {},
    tryRunOutOfBand: () => false,
    streamAgent: streamAgentSpy,
    replaceAgentRun: replaceAgentRunSpy,
  } satisfies Pick<
    AgentManager,
    | "getAgent"
    | "hasInFlightRun"
    | "waitForAgentRunStart"
    | "subscribe"
    | "addAgentArchivedCallback"
    | "tryRunOutOfBand"
    | "streamAgent"
    | "replaceAgentRun"
  >;
  const agentStorage = {
    get: async (agentId: string) => createStoredRecord({ id: agentId }),
  } satisfies Pick<AgentStorage, "get">;
  const service = new AgentMessageQueueService({
    store,
    agentManager: withReplayAdmissionSupport(agentManager) as AgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });

  await service.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });
  await service.enqueue({ agentId: "agent-a", messageId: "queued-2", text: "second" });

  await vi.runOnlyPendingTimersAsync();

  await vi.waitFor(() => {
    expect(streamAgentSpy).toHaveBeenCalledTimes(1);
  });
  expect(replaceAgentRunSpy).not.toHaveBeenCalled();
  expect(sent).toEqual([{ prompt: "first", messageId: "queued-1" }]);
  await vi.waitFor(async () => {
    const queues = await store.listQueues("agent-a");
    expect(queues).toMatchObject([
      {
        messages: [{ id: "queued-2", text: "second" }],
      },
    ]);
  });
});

test("auto drain dispatches without a transient dequeue notification race", async () => {
  vi.useFakeTimers();
  const { store } = await createStore();
  let inFlight = false;
  let sawShiftedQueue = false;
  const agent = {
    id: "agent-a",
    lifecycle: "idle",
    provider: "codex",
  } as ReturnType<AgentManager["getAgent"]>;
  const streamAgentSpy = vi.fn(() => {
    if (inFlight) {
      throw new Error("Agent agent-a already has an active run");
    }
    return (async function* noop() {})();
  });
  const replaceAgentRunSpy = vi.fn(() => (async function* noop() {})());
  const agentManager = {
    getAgent: () => agent,
    hasInFlightRun: () => inFlight,
    waitForAgentRunStart: async () => {},
    subscribe: () => () => {},
    addAgentArchivedCallback: () => () => {},
    tryRunOutOfBand: () => false,
    streamAgent: streamAgentSpy,
    replaceAgentRun: replaceAgentRunSpy,
  } satisfies Pick<
    AgentManager,
    | "getAgent"
    | "hasInFlightRun"
    | "waitForAgentRunStart"
    | "subscribe"
    | "addAgentArchivedCallback"
    | "tryRunOutOfBand"
    | "streamAgent"
    | "replaceAgentRun"
  >;
  const agentStorage = {
    get: async (agentId: string) => createStoredRecord({ id: agentId }),
  } satisfies Pick<AgentStorage, "get">;
  const service = new AgentMessageQueueService({
    store,
    agentManager: withReplayAdmissionSupport(agentManager) as AgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: (queue) => {
      if (queue.revision === 2 && queue.messages.length === 0) {
        sawShiftedQueue = true;
        inFlight = true;
      }
    },
  });

  await service.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });

  await vi.runOnlyPendingTimersAsync();

  await vi.waitFor(() => {
    expect(sawShiftedQueue).toBe(true);
  });
  expect(sawShiftedQueue).toBe(true);
  expect(streamAgentSpy).toHaveBeenCalledTimes(1);
  expect(replaceAgentRunSpy).not.toHaveBeenCalled();
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    {
      messages: [],
    },
  ]);
});

test("dispatchNow does not replace an auto-drained message in the same dispatch window", async () => {
  vi.useFakeTimers();
  const { store } = await createStore();
  let inFlight = false;
  let dispatchNowResult: Promise<string> | null = null;
  const agent = {
    id: "agent-a",
    lifecycle: "idle",
    provider: "codex",
  } as ReturnType<AgentManager["getAgent"]>;
  const streamAgentSpy = vi.fn(() => {
    inFlight = true;
    return (async function* noop() {})();
  });
  const replaceAgentRunSpy = vi.fn(() => (async function* noop() {})());
  const agentManager = {
    getAgent: () => agent,
    hasInFlightRun: () => inFlight,
    waitForAgentRunStart: async () => {},
    subscribe: () => () => {},
    addAgentArchivedCallback: () => () => {},
    tryRunOutOfBand: () => false,
    streamAgent: streamAgentSpy,
    replaceAgentRun: replaceAgentRunSpy,
  } satisfies Pick<
    AgentManager,
    | "getAgent"
    | "hasInFlightRun"
    | "waitForAgentRunStart"
    | "subscribe"
    | "addAgentArchivedCallback"
    | "tryRunOutOfBand"
    | "streamAgent"
    | "replaceAgentRun"
  >;
  const agentStorage = {
    get: async (agentId: string) => createStoredRecord({ id: agentId }),
  } satisfies Pick<AgentStorage, "get">;
  const service = new AgentMessageQueueService({
    store,
    agentManager: withReplayAdmissionSupport(agentManager) as AgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: (queue) => {
      if (queue.revision === 3 && queue.messages.some((message) => message.id === "queued-2")) {
        dispatchNowResult ??= service.dispatchNow("agent-a", "queued-2").then(
          () => "resolved",
          (error) => (error instanceof Error ? error.message : String(error)),
        );
      }
    },
  });

  await service.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });
  await service.enqueue({ agentId: "agent-a", messageId: "queued-2", text: "second" });

  await vi.runOnlyPendingTimersAsync();

  await vi.waitFor(() => {
    expect(dispatchNowResult).not.toBeNull();
  });
  await expect(dispatchNowResult).resolves.toBe("resolved");
  expect(streamAgentSpy).toHaveBeenCalledTimes(1);
  expect(replaceAgentRunSpy).toHaveBeenCalledTimes(1);
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    {
      messages: [],
    },
  ]);
});

test("dispatchNow blocks a scheduled auto drain until the explicit dispatch finishes", async () => {
  vi.useFakeTimers();
  const { store } = await createStore();
  const firstLookupStarted = deferred<void>();
  const secondLookupStarted = deferred<void>();
  const releaseDispatchLookup = deferred<StoredAgentRecord>();
  const sent: Array<{ prompt: AgentPromptInput; messageId?: string }> = [];
  const agent = {
    id: "agent-a",
    lifecycle: "idle",
    provider: "codex",
  } as ReturnType<AgentManager["getAgent"]>;
  const streamAgentSpy = vi.fn(
    (_agentId: string, prompt: AgentPromptInput, runOptions?: AgentRunOptions) => {
      sent.push({ prompt, messageId: runOptions?.messageId });
      return (async function* noop() {})();
    },
  );
  const replaceAgentRunSpy = vi.fn(() => (async function* noop() {})());
  const agentManager = {
    getAgent: () => agent,
    hasInFlightRun: () => false,
    waitForAgentRunStart: async () => {},
    subscribe: () => () => {},
    addAgentArchivedCallback: () => () => {},
    tryRunOutOfBand: () => false,
    streamAgent: streamAgentSpy,
    replaceAgentRun: replaceAgentRunSpy,
  } satisfies Pick<
    AgentManager,
    | "getAgent"
    | "hasInFlightRun"
    | "waitForAgentRunStart"
    | "subscribe"
    | "addAgentArchivedCallback"
    | "tryRunOutOfBand"
    | "streamAgent"
    | "replaceAgentRun"
  >;
  let getCalls = 0;
  const agentStorage = {
    // Calls 1-2 are the enqueue eligibility checks; call 3 is the dispatch
    // path and call 4 the auto-drain availability check.
    get: vi.fn(async (agentId: string) => {
      getCalls += 1;
      if (getCalls === 3) {
        firstLookupStarted.resolve();
        return releaseDispatchLookup.promise;
      }
      if (getCalls === 4) {
        secondLookupStarted.resolve();
      }
      return createStoredRecord({ id: agentId });
    }),
  } satisfies Pick<AgentStorage, "get">;
  const service = new AgentMessageQueueService({
    store,
    agentManager: withReplayAdmissionSupport(agentManager) as AgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });

  await service.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });
  await service.enqueue({ agentId: "agent-a", messageId: "queued-2", text: "second" });

  const dispatchNowResult = service.dispatchNow("agent-a", "queued-1");

  await firstLookupStarted.promise;
  await vi.runOnlyPendingTimersAsync();
  await secondLookupStarted.promise;
  await Promise.resolve();

  expect(agentStorage.get).toHaveBeenCalledTimes(4);
  expect(sent).toEqual([]);
  expect(replaceAgentRunSpy).not.toHaveBeenCalled();
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    {
      messages: [
        { id: "queued-1", text: "first" },
        { id: "queued-2", text: "second" },
      ],
    },
  ]);

  releaseDispatchLookup.resolve(createStoredRecord({ id: "agent-a" }));
  await expect(dispatchNowResult).resolves.toBeUndefined();
  expect(sent).toEqual([{ prompt: "first", messageId: "queued-1" }]);
  expect(streamAgentSpy).toHaveBeenCalledTimes(1);
  expect(replaceAgentRunSpy).not.toHaveBeenCalled();
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    {
      messages: [{ id: "queued-2", text: "second" }],
    },
  ]);
});

test("auto drain accepts a turn that starts and finishes immediately after ack registration", async () => {
  vi.useFakeTimers();
  const { store } = await createStore();
  const turnStart = deferred<void>();
  let ackRegistered = false;
  let deliveries = 0;
  const agent = {
    id: "agent-a",
    lifecycle: "idle",
    provider: "codex",
  } as ReturnType<AgentManager["getAgent"]>;
  const streamAgentSpy = vi.fn(() =>
    (async function* startAndFinish() {
      if (!ackRegistered) {
        throw new Error("Turn iterator consumed before start acknowledgement registration");
      }
      deliveries += 1;
      turnStart.resolve();
      yield { type: "turn_started", provider: "codex", turnId: "turn-1" };
    })(),
  );
  const agentManager = {
    getAgent: () => agent,
    hasInFlightRun: () => false,
    waitForAgentRunStart: async () => {
      ackRegistered = true;
      await turnStart.promise;
    },
    subscribe: () => () => {},
    addAgentArchivedCallback: () => () => {},
    tryRunOutOfBand: () => false,
    streamAgent: streamAgentSpy,
    replaceAgentRun: vi.fn(() => (async function* noop() {})()),
  } satisfies Pick<
    AgentManager,
    | "getAgent"
    | "hasInFlightRun"
    | "waitForAgentRunStart"
    | "subscribe"
    | "addAgentArchivedCallback"
    | "tryRunOutOfBand"
    | "streamAgent"
    | "replaceAgentRun"
  >;
  const agentStorage = {
    get: async (agentId: string) => createStoredRecord({ id: agentId }),
  } satisfies Pick<AgentStorage, "get">;
  const service = new AgentMessageQueueService({
    store,
    agentManager: withReplayAdmissionSupport(agentManager) as AgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });

  await service.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });
  await vi.runOnlyPendingTimersAsync();

  await vi.waitFor(() => {
    expect(streamAgentSpy).toHaveBeenCalledTimes(1);
  });
  expect(deliveries).toBe(1);
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([{ messages: [] }]);

  await vi.advanceTimersByTimeAsync(60_000);
  expect(streamAgentSpy).toHaveBeenCalledTimes(1);
  expect(deliveries).toBe(1);
});

test("dispatchNow times out a delayed turn start, leaves the item recoverable, and does not retry the original provider call", async () => {
  vi.useFakeTimers();
  const { store } = await createStore();
  const releaseStart = deferred<void>();
  const turnStart = deferred<void>();
  const agent = {
    id: "agent-a",
    lifecycle: "idle",
    provider: "codex",
  } as ReturnType<AgentManager["getAgent"]>;
  const streamAgentSpy = vi.fn(() =>
    (async function* delayedStart() {
      await releaseStart.promise;
      turnStart.resolve();
      yield { type: "turn_started", provider: "codex", turnId: "turn-1" };
    })(),
  );
  const agentManager = {
    getAgent: () => agent,
    hasInFlightRun: () => false,
    waitForAgentRunStart: async (_agentId: string, input?: { signal?: AbortSignal }) => {
      await Promise.race([
        turnStart.promise,
        new Promise<void>((_resolve, reject) => {
          input?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error(String(input.signal?.reason ?? "aborted")), {
                  name: "AbortError",
                }),
              ),
            {
              once: true,
            },
          );
        }),
      ]);
    },
    subscribe: () => () => {},
    addAgentArchivedCallback: () => () => {},
    tryRunOutOfBand: () => false,
    streamAgent: streamAgentSpy,
    replaceAgentRun: vi.fn(() => (async function* noop() {})()),
  } satisfies Pick<
    AgentManager,
    | "getAgent"
    | "hasInFlightRun"
    | "waitForAgentRunStart"
    | "subscribe"
    | "addAgentArchivedCallback"
    | "tryRunOutOfBand"
    | "streamAgent"
    | "replaceAgentRun"
  >;
  const agentStorage = {
    get: async (agentId: string) => createStoredRecord({ id: agentId }),
  } satisfies Pick<AgentStorage, "get">;
  const replayAgentManager = withReplayAdmissionSupport(agentManager) as AgentManager;
  const service = new AgentMessageQueueService({
    store,
    agentManager: replayAgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });

  await service.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });
  const dispatch = service.dispatchNow("agent-a", "queued-1");
  const dispatchResult = dispatch.catch((error: unknown) => error);

  await vi.advanceTimersByTimeAsync(15_000);

  const dispatchError = await dispatchResult;
  expect(dispatchError).toBeInstanceOf(Error);
  expect((dispatchError as Error).message).toBe(
    "Provider start timed out; delivery outcome is unknown",
  );
  expect(streamAgentSpy).toHaveBeenCalledTimes(1);
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    {
      revision: 1,
      messages: [{ id: "queued-1", text: "first" }],
    },
  ]);
  expect(
    replayAgentManager.settleRecordedUserMessageAdmissionPendingForAgent,
  ).toHaveBeenCalledTimes(1);

  releaseStart.resolve();
  expect(streamAgentSpy).toHaveBeenCalledTimes(1);
});

test("auto drain retries after a transient dispatch failure", async () => {
  vi.useFakeTimers();
  const { store } = await createStore();
  let inFlight = false;
  let turnStart = deferred<void>();
  const agent = {
    id: "agent-a",
    lifecycle: "idle",
    provider: "codex",
  } as ReturnType<AgentManager["getAgent"]>;
  const streamAgentSpy = vi.fn(() => {
    turnStart = deferred<void>();
    const attempt = streamAgentSpy.mock.calls.length;
    return (async function* startTurn() {
      await Promise.resolve();
      if (attempt === 1) {
        const error = new Error("Transient async turn-start failure");
        turnStart.reject(error);
        yield await Promise.reject(error);
        return;
      }
      inFlight = true;
      turnStart.resolve();
      yield { type: "turn_started", provider: "codex", turnId: "turn-1" };
    })();
  });
  const replaceAgentRunSpy = vi.fn(() => (async function* noop() {})());
  const agentManager = {
    getAgent: () => agent,
    hasInFlightRun: () => inFlight,
    waitForAgentRunStart: async () => await turnStart.promise,
    subscribe: () => () => {},
    addAgentArchivedCallback: () => () => {},
    tryRunOutOfBand: () => false,
    streamAgent: streamAgentSpy,
    replaceAgentRun: replaceAgentRunSpy,
  } satisfies Pick<
    AgentManager,
    | "getAgent"
    | "hasInFlightRun"
    | "waitForAgentRunStart"
    | "subscribe"
    | "addAgentArchivedCallback"
    | "tryRunOutOfBand"
    | "streamAgent"
    | "replaceAgentRun"
  >;
  const agentStorage = {
    get: async (agentId: string) => createStoredRecord({ id: agentId }),
  } satisfies Pick<AgentStorage, "get">;
  const service = new AgentMessageQueueService({
    store,
    agentManager: withReplayAdmissionSupport(agentManager) as AgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });

  await service.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });

  await vi.runOnlyPendingTimersAsync();
  await vi.waitFor(() => {
    expect(streamAgentSpy).toHaveBeenCalledTimes(1);
  });
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    {
      messages: [{ id: "queued-1", text: "first" }],
    },
  ]);

  await vi.advanceTimersByTimeAsync(25);

  await vi.waitFor(() => {
    expect(streamAgentSpy).toHaveBeenCalledTimes(2);
  });
  expect(replaceAgentRunSpy).not.toHaveBeenCalled();
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    {
      messages: [],
    },
  ]);
});

test("dispatchNow durably restores a message after an asynchronous turn-start failure", async () => {
  const { store } = await createStore();
  const turnStart = deferred<void>();
  const agent = {
    id: "agent-a",
    lifecycle: "idle",
    provider: "codex",
  } as ReturnType<AgentManager["getAgent"]>;
  const streamAgentSpy = vi.fn(() =>
    (async function* startTurn() {
      await Promise.resolve();
      const error = new Error("Explicit async turn-start failure");
      turnStart.reject(error);
      yield await Promise.reject(error);
    })(),
  );
  const agentManager = {
    getAgent: () => agent,
    hasInFlightRun: () => false,
    waitForAgentRunStart: async () => await turnStart.promise,
    subscribe: () => () => {},
    addAgentArchivedCallback: () => () => {},
    tryRunOutOfBand: () => false,
    streamAgent: streamAgentSpy,
    replaceAgentRun: vi.fn(() => (async function* noop() {})()),
  } satisfies Pick<
    AgentManager,
    | "getAgent"
    | "hasInFlightRun"
    | "waitForAgentRunStart"
    | "subscribe"
    | "addAgentArchivedCallback"
    | "tryRunOutOfBand"
    | "streamAgent"
    | "replaceAgentRun"
  >;
  const agentStorage = {
    get: async (agentId: string) => createStoredRecord({ id: agentId }),
  } satisfies Pick<AgentStorage, "get">;
  const service = new AgentMessageQueueService({
    store,
    agentManager: withReplayAdmissionSupport(agentManager) as AgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });

  await service.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });

  await expect(service.dispatchNow("agent-a", "queued-1")).rejects.toThrow(
    "Explicit async turn-start failure",
  );
  expect(streamAgentSpy).toHaveBeenCalledTimes(1);
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    {
      revision: 1,
      messages: [{ id: "queued-1", text: "first" }],
    },
  ]);
});

test("a failed persist leaves no phantom record in memory", async () => {
  const { store } = await createStore();
  await store.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });

  const persistError = new Error("simulated persist failure");
  const writeJsonFileAtomicSpy = vi
    .spyOn(atomicFile, "writeJsonFileAtomic")
    .mockImplementationOnce(async () => {
      throw persistError;
    });
  try {
    await expect(
      store.enqueue({ agentId: "agent-a", messageId: "queued-2", text: "second" }),
    ).rejects.toThrow("simulated persist failure");

    await expect(store.list("agent-a")).resolves.toMatchObject([{ id: "queued-1" }]);
    await expect(store.listQueues("agent-a")).resolves.toMatchObject([
      { agentId: "agent-a", revision: 1 },
    ]);
  } finally {
    writeJsonFileAtomicSpy.mockRestore();
  }
});

test("auto drain stops retrying after consecutive dispatch failures", async () => {
  vi.useFakeTimers();
  const { store } = await createStore();
  const agent = {
    id: "agent-a",
    lifecycle: "idle",
    provider: "codex",
  } as ReturnType<AgentManager["getAgent"]>;
  const streamAgentSpy = vi.fn(() => {
    throw new Error("Persistent dispatch failure");
  });
  const replaceAgentRunSpy = vi.fn(() => (async function* noop() {})());
  const agentManager = {
    getAgent: () => agent,
    hasInFlightRun: () => false,
    waitForAgentRunStart: async () => {},
    subscribe: () => () => {},
    addAgentArchivedCallback: () => () => {},
    tryRunOutOfBand: () => false,
    streamAgent: streamAgentSpy,
    replaceAgentRun: replaceAgentRunSpy,
  } satisfies Pick<
    AgentManager,
    | "getAgent"
    | "hasInFlightRun"
    | "waitForAgentRunStart"
    | "subscribe"
    | "addAgentArchivedCallback"
    | "tryRunOutOfBand"
    | "streamAgent"
    | "replaceAgentRun"
  >;
  const agentStorage = {
    get: async (agentId: string) => createStoredRecord({ id: agentId }),
  } satisfies Pick<AgentStorage, "get">;
  const service = new AgentMessageQueueService({
    store,
    agentManager: withReplayAdmissionSupport(agentManager) as AgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });

  await service.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });

  // One initial attempt plus one retry per remaining rung of the delay
  // ladder; afterwards the drain waits for the next agent event instead of
  // looping.
  await vi.runOnlyPendingTimersAsync();
  await vi.waitFor(() => {
    expect(streamAgentSpy).toHaveBeenCalledTimes(1);
  });
  for (const [attempt, delayMs] of [25, 100, 250, 1000].entries()) {
    await vi.advanceTimersByTimeAsync(delayMs);
    await vi.waitFor(() => {
      expect(streamAgentSpy).toHaveBeenCalledTimes(attempt + 2);
    });
  }

  await vi.advanceTimersByTimeAsync(60_000);
  expect(streamAgentSpy).toHaveBeenCalledTimes(5);
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    {
      messages: [{ id: "queued-1", text: "first" }],
    },
  ]);
});

test("enqueue is rejected inside the mutation when the agent is archived", async () => {
  const { store } = await createStore();
  const agentManager = {
    getAgent: () => undefined,
    hasInFlightRun: () => false,
    subscribe: () => () => {},
    addAgentArchivedCallback: () => () => {},
  } satisfies Pick<
    AgentManager,
    "getAgent" | "hasInFlightRun" | "subscribe" | "addAgentArchivedCallback"
  >;
  const agentStorage = {
    get: async (agentId: string) =>
      createStoredRecord({ id: agentId, archivedAt: "2026-06-30T00:00:00.000Z" }),
  } satisfies Pick<AgentStorage, "get">;
  const updates: string[] = [];
  const service = new AgentMessageQueueService({
    store,
    agentManager: agentManager as unknown as AgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: (queue) => {
      updates.push(queue.agentId);
    },
  });

  await expect(
    service.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" }),
  ).rejects.toThrow("Cannot queue message for archived agent: agent-a");

  expect(updates).toEqual([]);
  await expect(store.list("agent-a")).resolves.toEqual([]);
});

test("queue update broadcasts omit image bytes but keep counts", async () => {
  vi.useFakeTimers();
  const { store } = await createStore();
  const agent = {
    id: "agent-a",
    lifecycle: "running",
    provider: "codex",
  } as ReturnType<AgentManager["getAgent"]>;
  const agentManager = {
    getAgent: () => agent,
    hasInFlightRun: () => true,
    subscribe: () => () => {},
    addAgentArchivedCallback: () => () => {},
  } satisfies Pick<
    AgentManager,
    "getAgent" | "hasInFlightRun" | "subscribe" | "addAgentArchivedCallback"
  >;
  const agentStorage = {
    get: async (agentId: string) => createStoredRecord({ id: agentId }),
  } satisfies Pick<AgentStorage, "get">;
  const broadcasts: Array<{
    images: Array<{ data: string; mimeType: string }>;
    imageCount: number;
  }> = [];
  const service = new AgentMessageQueueService({
    store,
    agentManager: agentManager as unknown as AgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: (queue) => {
      for (const message of queue.messages) {
        broadcasts.push({ images: message.images, imageCount: message.imageCount });
      }
    },
  });

  await service.enqueue({
    agentId: "agent-a",
    messageId: "queued-1",
    text: "first",
    images: [{ data: "base64-image", mimeType: "image/png" }],
  });

  expect(broadcasts).toEqual([{ images: [], imageCount: 1 }]);
  // The store keeps the full payload for list responses and replay.
  await expect(store.list("agent-a")).resolves.toMatchObject([
    { images: [{ data: "base64-image", mimeType: "image/png" }] },
  ]);
});

test("buildQueuedAgentPrompt preserves text, image, and structured attachments", () => {
  expect(
    buildQueuedAgentPrompt(
      "  replay this  ",
      [{ data: "base64-image", mimeType: "image/png" }],
      [
        {
          type: "text",
          mimeType: "text/plain",
          title: "notes.txt",
          text: "attachment body",
        },
      ],
    ),
  ).toEqual([
    { type: "text", text: "replay this" },
    { type: "image", data: "base64-image", mimeType: "image/png" },
    {
      type: "text",
      mimeType: "text/plain",
      title: "notes.txt",
      text: "attachment body",
    },
  ]);

  expect(buildQueuedAgentPrompt("  plain text  ", [], [])).toBe("plain text");
});

test("dispatchNow reserves normalized replay admission before provider start and commits only after start", async () => {
  const { store } = await createStore();
  const providerStarts: Array<{ prompt: AgentPromptInput; messageId?: string }> = [];
  const { manager, normalizedMessageIds, streamAgentSpy } = createReplayAwareAgentManager({
    startBehavior: "resolve",
    onProviderStart: (prompt, runOptions) => {
      providerStarts.push({ prompt, messageId: runOptions?.messageId });
    },
  });
  const agentStorage = {
    get: async (agentId: string) => createStoredRecord({ id: agentId }),
  } satisfies Pick<AgentStorage, "get">;
  const service = new AgentMessageQueueService({
    store,
    agentManager: manager as AgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });

  await store.enqueue({ agentId: "agent-a", messageId: "  queued-1  ", text: "first" });
  await service.dispatchNow("agent-a", "  queued-1  ");

  expect(normalizedMessageIds).toEqual(["queued-1"]);
  expect(streamAgentSpy).toHaveBeenCalledTimes(1);
  expect(providerStarts).toEqual([{ prompt: "first", messageId: "queued-1" }]);
  expect(manager.commitRecordedUserMessageAdmissionForAgent).toHaveBeenCalledTimes(1);
  expect(manager.releaseRecordedUserMessageAdmissionForAgent).not.toHaveBeenCalled();
  await expect(store.listQueues("agent-a")).resolves.toEqual([
    { agentId: "agent-a", revision: 2, messages: [] },
  ]);
});

test("duplicate replay after committed start but failed dequeue suppresses a second provider start and removes the queue item", async () => {
  const { store } = await createStore();
  const { manager, streamAgentSpy } = createReplayAwareAgentManager({
    startBehavior: "resolve",
  });
  const agentStorage = {
    get: async (agentId: string) => createStoredRecord({ id: agentId }),
  } satisfies Pick<AgentStorage, "get">;
  const service = new AgentMessageQueueService({
    store,
    agentManager: manager as AgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });
  await store.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });

  const removeSpy = vi.spyOn(store, "remove").mockImplementationOnce(async () => {
    throw new Error("crash before dequeue persist");
  });

  await expect(service.dispatchNow("agent-a", "queued-1")).rejects.toThrow(
    "crash before dequeue persist",
  );
  expect(streamAgentSpy).toHaveBeenCalledTimes(1);
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    { messages: [{ id: "queued-1", text: "first" }] },
  ]);

  removeSpy.mockRestore();

  const restartedService = new AgentMessageQueueService({
    store,
    agentManager: manager as AgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });
  await expect(restartedService.dispatchNow("agent-a", "queued-1")).resolves.toBeUndefined();
  expect(streamAgentSpy).toHaveBeenCalledTimes(1);
  await expect(store.listQueues("agent-a")).resolves.toEqual([
    { agentId: "agent-a", revision: 2, messages: [] },
  ]);
});

test("real manager commits a fast turn before dequeue replay and suppresses duplicate provider execution after restart", async () => {
  let providerStarts = 0;
  const first = await createRealQueueReplayHarness({
    onStartTurn: () => {
      providerStarts += 1;
    },
  });

  await first.store.enqueue({ agentId: first.agent.id, messageId: "queued-1", text: "fast turn" });
  const originalRemove = first.store.remove.bind(first.store);
  const removeSpy = vi.spyOn(first.store, "remove").mockImplementationOnce(async () => {
    throw new Error("crash before dequeue persist");
  });

  await expect(first.service.dispatchNow(first.agent.id, "queued-1")).rejects.toThrow(
    "crash before dequeue persist",
  );
  await first.manager.flush();
  await first.storage.flush();
  expect(providerStarts).toBe(1);
  await expect(first.store.listQueues(first.agent.id)).resolves.toMatchObject([
    { messages: [{ id: "queued-1", text: "fast turn" }] },
  ]);

  removeSpy.mockRestore();
  vi.spyOn(first.store, "remove").mockImplementation(originalRemove);

  const restartedStorage = new AgentStorage(path.join(first.dir, "agents"), first.logger);
  const restartedManager = new AgentManager({
    clients: createTestAgentClients({
      onStartTurn: () => {
        providerStarts += 1;
      },
    }),
    registry: restartedStorage,
    logger: first.logger,
  });
  const restartedService = new AgentMessageQueueService({
    store: first.store,
    agentManager: restartedManager,
    agentStorage: restartedStorage,
    logger: first.logger,
    onQueueUpdated: () => {},
  });

  await expect(restartedService.dispatchNow(first.agent.id, "queued-1")).resolves.toBeUndefined();
  await restartedManager.flush();
  await restartedStorage.flush();
  expect(providerStarts).toBe(1);
  await expect(first.store.listQueues(first.agent.id)).resolves.toEqual([
    { agentId: first.agent.id, revision: 2, messages: [] },
  ]);
});

test("definitive pre-start rejection releases replay admission and keeps the queued item recoverable", async () => {
  const { store } = await createStore();
  const { manager, streamAgentSpy } = createReplayAwareAgentManager({
    dispatchError: new Error("provider rejected before start"),
  });
  const agentStorage = {
    get: async (agentId: string) => createStoredRecord({ id: agentId }),
  } satisfies Pick<AgentStorage, "get">;
  const service = new AgentMessageQueueService({
    store,
    agentManager: manager as AgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });

  await store.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });
  await expect(service.dispatchNow("agent-a", "queued-1")).rejects.toThrow(
    "provider rejected before start",
  );
  expect(manager.releaseRecordedUserMessageAdmissionForAgent).toHaveBeenCalledTimes(1);
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    { revision: 1, messages: [{ id: "queued-1", text: "first" }] },
  ]);
  expect(streamAgentSpy).toHaveBeenCalledTimes(1);
});

test("hung start times out without wedging the drainer, keeps the item exact, and later dispatch stays duplicate-safe", async () => {
  vi.useFakeTimers();
  const { store } = await createStore();
  const { manager, streamAgentSpy } = createReplayAwareAgentManager({
    startBehavior: "never",
  });
  const agentStorage = {
    get: async (agentId: string) => createStoredRecord({ id: agentId }),
  } satisfies Pick<AgentStorage, "get">;
  const service = new AgentMessageQueueService({
    store,
    agentManager: manager as AgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });

  await store.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });
  const firstDispatch = service.dispatchNow("agent-a", "queued-1");
  const firstDispatchAssertion = expect(firstDispatch).rejects.toThrow(
    "Provider start timed out; delivery outcome is unknown",
  );
  await vi.advanceTimersByTimeAsync(15_000);
  await firstDispatchAssertion;

  expect(manager.settleRecordedUserMessageAdmissionPendingForAgent).toHaveBeenCalledTimes(1);
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    { revision: 1, messages: [{ id: "queued-1", text: "first" }] },
  ]);
  expect(streamAgentSpy).toHaveBeenCalledTimes(1);

  await expect(service.dispatchNow("agent-a", "queued-1")).rejects.toThrow(
    "A previous delivery with this client messageId has an unknown outcome",
  );
  expect(streamAgentSpy).toHaveBeenCalledTimes(1);
});

test("cancel and clear wait behind unresolved dispatch and only apply after explicit outcome", async () => {
  vi.useFakeTimers();
  const { store } = await createStore();
  const { manager, streamAgentSpy } = createReplayAwareAgentManager({
    startBehavior: "never",
  });
  const agentStorage = {
    get: async (agentId: string) => createStoredRecord({ id: agentId }),
  } satisfies Pick<AgentStorage, "get">;
  const service = new AgentMessageQueueService({
    store,
    agentManager: manager as AgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });

  await store.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });
  const dispatch = service.dispatchNow("agent-a", "queued-1");
  const dispatchAssertion = expect(dispatch).rejects.toThrow(
    "Provider start timed out; delivery outcome is unknown",
  );
  const cancel = service.cancel("agent-a", "queued-1");
  const clear = service.clearAgent("agent-a");

  await Promise.resolve();
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    { revision: 1, messages: [{ id: "queued-1", text: "first" }] },
  ]);
  expect(streamAgentSpy).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(15_000);
  await dispatchAssertion;
  await expect(cancel).resolves.toBe(true);
  await expect(clear).resolves.toBeUndefined();
  await expect(store.listQueues("agent-a")).resolves.toEqual([
    { agentId: "agent-a", revision: 2, messages: [] },
  ]);
});

test("cancel that acquires ownership first prevents a later dispatch from reading a stale queued record", async () => {
  const { store } = await createStore();
  const streamAgentSpy = vi.fn(() => (async function* noop() {})());
  const agentManager = {
    getAgent: () =>
      ({
        id: "agent-a",
        lifecycle: "idle",
        provider: "codex",
      }) as ReturnType<AgentManager["getAgent"]>,
    hasInFlightRun: () => false,
    waitForAgentRunStart: async () => {},
    subscribe: () => () => {},
    addAgentArchivedCallback: () => () => {},
    tryRunOutOfBand: () => false,
    streamAgent: streamAgentSpy,
    replaceAgentRun: vi.fn(() => (async function* noop() {})()),
  } satisfies Pick<
    AgentManager,
    | "getAgent"
    | "hasInFlightRun"
    | "waitForAgentRunStart"
    | "subscribe"
    | "addAgentArchivedCallback"
    | "tryRunOutOfBand"
    | "streamAgent"
    | "replaceAgentRun"
  >;
  const replayAgentManager = withReplayAdmissionSupport(agentManager) as AgentManager;
  const agentStorage = {
    get: async (agentId: string) => createStoredRecord({ id: agentId }),
  } satisfies Pick<AgentStorage, "get">;
  const service = new AgentMessageQueueService({
    store,
    agentManager: replayAgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });
  await store.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });

  const originalRemove = store.remove.bind(store);
  const removeStarted = deferred<void>();
  const releaseRemove = deferred<void>();
  const removeSpy = vi.spyOn(store, "remove").mockImplementationOnce(async (agentId, messageId) => {
    removeStarted.resolve();
    await releaseRemove.promise;
    return await originalRemove(agentId, messageId);
  });

  const cancelPromise = service.cancel("agent-a", "queued-1");
  await removeStarted.promise;
  const dispatchPromise = service.dispatchNow("agent-a", "queued-1").then(
    () => "resolved",
    (error) => (error instanceof Error ? error.message : String(error)),
  );
  await Promise.resolve();
  expect(streamAgentSpy).not.toHaveBeenCalled();

  releaseRemove.resolve();
  await expect(cancelPromise).resolves.toBe(true);
  await expect(dispatchPromise).resolves.toBe("Queued message not found: queued-1");
  expect(streamAgentSpy).not.toHaveBeenCalled();
  await expect(store.listQueues("agent-a")).resolves.toEqual([
    { agentId: "agent-a", revision: 2, messages: [] },
  ]);
  removeSpy.mockRestore();
});

test("clear that acquires ownership first prevents a later dispatch from reading stale queue state and preserves monotonic revisions", async () => {
  const { store } = await createStore();
  const streamAgentSpy = vi.fn(() => (async function* noop() {})());
  const agentManager = {
    getAgent: () =>
      ({
        id: "agent-a",
        lifecycle: "idle",
        provider: "codex",
      }) as ReturnType<AgentManager["getAgent"]>,
    hasInFlightRun: () => false,
    waitForAgentRunStart: async () => {},
    subscribe: () => () => {},
    addAgentArchivedCallback: () => () => {},
    tryRunOutOfBand: () => false,
    streamAgent: streamAgentSpy,
    replaceAgentRun: vi.fn(() => (async function* noop() {})()),
  } satisfies Pick<
    AgentManager,
    | "getAgent"
    | "hasInFlightRun"
    | "waitForAgentRunStart"
    | "subscribe"
    | "addAgentArchivedCallback"
    | "tryRunOutOfBand"
    | "streamAgent"
    | "replaceAgentRun"
  >;
  const replayAgentManager = withReplayAdmissionSupport(agentManager) as AgentManager;
  const agentStorage = {
    get: async (agentId: string) => createStoredRecord({ id: agentId }),
  } satisfies Pick<AgentStorage, "get">;
  const service = new AgentMessageQueueService({
    store,
    agentManager: replayAgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });
  await store.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });

  const originalClearAgent = store.clearAgent.bind(store);
  const clearStarted = deferred<void>();
  const releaseClear = deferred<void>();
  const clearSpy = vi
    .spyOn(store, "clearAgent")
    .mockImplementationOnce(async (agentId, options) => {
      clearStarted.resolve();
      await releaseClear.promise;
      return await originalClearAgent(agentId, options);
    });

  const clearPromise = service.clearAgent("agent-a");
  await clearStarted.promise;
  const dispatchPromise = service.dispatchNow("agent-a", "queued-1").then(
    () => "resolved",
    (error) => (error instanceof Error ? error.message : String(error)),
  );
  await Promise.resolve();
  expect(streamAgentSpy).not.toHaveBeenCalled();

  releaseClear.resolve();
  await expect(clearPromise).resolves.toBeUndefined();
  await expect(dispatchPromise).resolves.toBe("Queued message not found: queued-1");
  expect(streamAgentSpy).not.toHaveBeenCalled();
  await expect(store.listQueues("agent-a")).resolves.toEqual([
    { agentId: "agent-a", revision: 2, messages: [] },
  ]);
  clearSpy.mockRestore();
});

test("commit persistence failure keeps the queue item and leaves later dispatches in unknown pending state", async () => {
  const { store } = await createStore();
  const { manager, streamAgentSpy } = createReplayAwareAgentManager({
    commitError: new Error("commit failed"),
  });
  const agentStorage = {
    get: async (agentId: string) => createStoredRecord({ id: agentId }),
  } satisfies Pick<AgentStorage, "get">;
  const service = new AgentMessageQueueService({
    store,
    agentManager: manager as AgentManager,
    agentStorage: agentStorage as AgentStorage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });

  await store.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });
  await expect(service.dispatchNow("agent-a", "queued-1")).rejects.toThrow(
    "Provider dispatch succeeded but durable replay commit failed; delivery outcome is unknown",
  );
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    { revision: 1, messages: [{ id: "queued-1", text: "first" }] },
  ]);
  expect(streamAgentSpy).toHaveBeenCalledTimes(1);

  await expect(service.dispatchNow("agent-a", "queued-1")).rejects.toThrow(
    "A previous delivery with this client messageId has an unknown outcome",
  );
  expect(streamAgentSpy).toHaveBeenCalledTimes(1);
});
