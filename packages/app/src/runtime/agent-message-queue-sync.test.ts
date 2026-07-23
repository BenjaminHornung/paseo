import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  AgentAttachment,
  QueuedAgentMessageQueuePayload,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import type { AttachmentMetadata } from "@/attachments/types";
import * as attachmentService from "@/attachments/service";
import { useSessionStore } from "@/stores/session-store";
import * as encodeImageUtils from "@/utils/encode-images";
import {
  clearQueuedAgentMessageIntentIfCurrent,
  createAgentMessageQueueSyncState,
  enqueueRegisteredQueuedAgentMessageIntent,
  mountAgentMessageQueueSync,
  registerAgentMessageQueueSyncState,
  registerQueuedAgentMessageIntent,
} from "./agent-message-queue-sync";
import {
  orchestrateQueuedComposerServerEditCancellation,
  queueComposerServerMessage,
  recoverQueuedComposerEditCancellation,
  type QueueWriter,
} from "@/composer/actions";

const SERVER_ID = "queue-sync-test";

type QueueLifecycleMessage = Extract<
  SessionOutboundMessage,
  { type: "queue.agent_message.updated" | "agent_deleted" | "agent_archived" }
>;

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

function queuePayload(
  agentId: string,
  revision: number | undefined,
  messageIds: readonly string[],
  overrides?: Partial<QueuedAgentMessageQueuePayload["messages"][number]>,
): QueuedAgentMessageQueuePayload {
  return {
    agentId,
    ...(revision === undefined ? {} : { revision }),
    messages: messageIds.map((id) => ({
      id,
      agentId,
      text: id,
      createdAt: "2026-07-20T00:00:00.000Z",
      images: [],
      attachments: [],
      imageCount: 0,
      attachmentCount: 0,
      ...overrides,
    })),
  };
}

function reviewAttachment(body: string): Extract<AgentAttachment, { type: "review" }> {
  return {
    type: "review",
    mimeType: "application/paseo-review",
    cwd: "/repo",
    mode: "uncommitted",
    baseRef: null,
    comments: [
      {
        filePath: "src/example.ts",
        side: "new",
        lineNumber: 10,
        body,
        context: {
          hunkHeader: "@@ -10,1 +10,1 @@",
          targetLine: {
            oldLineNumber: null,
            newLineNumber: 10,
            type: "add",
            content: "const next = true;",
          },
          lines: [
            {
              oldLineNumber: null,
              newLineNumber: 10,
              type: "add",
              content: "const next = true;",
            },
          ],
        },
      },
    ],
  };
}

function persistedImage(id: string): AttachmentMetadata {
  return {
    id,
    storageKey: id,
    storageType: "web-indexeddb",
    mimeType: "image/png",
    fileName: `${id}.png`,
    byteSize: 12,
    createdAt: 1,
  };
}

function encodeByImageId(
  images: AttachmentMetadata[] | undefined,
): Array<{ data: string; mimeType: string }> {
  return (images ?? []).map((image) => ({
    data: `encoded:${image.id}`,
    mimeType: image.mimeType,
  }));
}

function createClientHarness() {
  const listeners = new Map<string, Set<(message: SessionOutboundMessage) => void>>();
  const queueAgentMessage = vi.fn<
    (
      agentId: string,
      text: string,
      options?: { messageId?: string; attachments?: AgentAttachment[] },
    ) => Promise<void>
  >(async () => {});
  const listQueuedAgentMessages = vi.fn(
    async (_agentId?: string): Promise<QueuedAgentMessageQueuePayload[]> => [],
  );
  const client = Object.create(DaemonClient.prototype) as DaemonClient;
  Reflect.set(
    client,
    "on",
    (eventType: string, listener: (message: SessionOutboundMessage) => void) => {
      const eventListeners = listeners.get(eventType) ?? new Set();
      eventListeners.add(listener);
      listeners.set(eventType, eventListeners);
      return () => eventListeners.delete(listener);
    },
  );
  Reflect.set(client, "queueAgentMessage", queueAgentMessage);
  Reflect.set(client, "listQueuedAgentMessages", listQueuedAgentMessages);

  return {
    client,
    queueAgentMessage,
    listQueuedAgentMessages,
    emit(message: QueueLifecycleMessage) {
      for (const listener of listeners.get(message.type) ?? []) listener(message);
    },
  };
}

function localMessage(id: string) {
  return { id, text: id, attachments: [] };
}

function queueWriterForServer(serverId: string): QueueWriter {
  return {
    read: (agentId) =>
      useSessionStore.getState().sessions[serverId]?.queuedMessages?.get(agentId) ?? [],
    write: (updater) => useSessionStore.getState().setQueuedMessages(serverId, updater),
  };
}

beforeEach(() => {
  useSessionStore.getState().initializeSession(SERVER_ID, null);
});

afterEach(() => {
  vi.restoreAllMocks();
  useSessionStore.getState().clearSession(SERVER_ID);
});

describe("mountAgentMessageQueueSync", () => {
  it("uses collision-proof intent tokens for re-registrations of the same stable id", () => {
    const state = createAgentMessageQueueSyncState();
    registerAgentMessageQueueSyncState(SERVER_ID, state);

    registerQueuedAgentMessageIntent({
      serverId: SERVER_ID,
      agentId: "agent-a",
      message: localMessage("stable-id"),
    });
    const firstToken = state.intentVersions.get("agent-a\u0000stable-id");

    registerQueuedAgentMessageIntent({
      serverId: SERVER_ID,
      agentId: "agent-a",
      message: { id: "stable-id", text: "updated", attachments: [] },
    });
    const secondToken = state.intentVersions.get("agent-a\u0000stable-id");

    expect(firstToken).toBeDefined();
    expect(secondToken).toBeDefined();
    expect(secondToken).not.toBe(firstToken);
  });

  it("retries a lost first durable queue response with the same stable id on reconnect and reconciles once", async () => {
    const state = createAgentMessageQueueSyncState();
    registerAgentMessageQueueSyncState(SERVER_ID, state);
    const initialHarness = createClientHarness();
    initialHarness.queueAgentMessage.mockRejectedValueOnce(new Error("response lost"));

    const prepared = queueComposerServerMessage({
      agentId: "agent-a",
      text: "durable draft",
      attachments: [],
      queue: queueWriterForServer(SERVER_ID),
      messageId: "stable-id",
      registerIntent: (message) => {
        registerQueuedAgentMessageIntent({
          serverId: SERVER_ID,
          agentId: "agent-a",
          message,
        });
      },
      send: async (message) => {
        await initialHarness.queueAgentMessage("agent-a", message.text, {
          messageId: message.id,
          attachments: [],
        });
      },
    });

    await expect(prepared.submit?.()).rejects.toThrow("response lost");
    expect(state.unacknowledged).toEqual(
      new Map([["agent-a", [{ id: "stable-id", text: "durable draft", attachments: [] }]]]),
    );
    expect(state.intentVersions.get("agent-a\u0000stable-id")).toBeDefined();
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual([
      { id: "stable-id", text: "durable draft", attachments: [] },
    ]);

    const reconnectHarness = createClientHarness();
    reconnectHarness.listQueuedAgentMessages.mockResolvedValueOnce([
      queuePayload("agent-a", 1, ["stable-id"], { text: "durable draft" }),
    ]);
    const dispose = mountAgentMessageQueueSync({
      client: reconnectHarness.client,
      serverId: SERVER_ID,
      state,
    });

    await vi.waitFor(() => expect(reconnectHarness.queueAgentMessage).toHaveBeenCalledTimes(1));
    expect(reconnectHarness.queueAgentMessage).toHaveBeenCalledWith(
      "agent-a",
      "durable draft",
      expect.objectContaining({ messageId: "stable-id" }),
    );
    await vi.waitFor(() =>
      expect(reconnectHarness.listQueuedAgentMessages).toHaveBeenCalledTimes(1),
    );
    await vi.waitFor(() => {
      expect(state.unacknowledged).toEqual(new Map());
      expect(Array.from(state.intentVersions.keys())).toEqual([]);
      expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual(
        [{ id: "stable-id", text: "durable draft", attachments: [] }],
      );
    });
    dispose();
  });

  it("preserves failed migrations and retries only their message ids after reconnect", async () => {
    const first = localMessage("first");
    const second = localMessage("second");
    useSessionStore
      .getState()
      .setQueuedMessages(SERVER_ID, new Map([["agent-a", [first, second]]]));
    const state = createAgentMessageQueueSyncState();
    const harness = createClientHarness();
    harness.queueAgentMessage.mockImplementation(
      async (_agentId, _text, options?: { messageId?: string }) => {
        if (options?.messageId === "second") throw new Error("temporary failure");
      },
    );
    harness.listQueuedAgentMessages.mockResolvedValueOnce([queuePayload("agent-a", 1, ["first"])]);

    const disposeFirst = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));
    expect(state.unacknowledged).toEqual(new Map([["agent-a", [second]]]));
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual([
      first,
      second,
    ]);
    disposeFirst();

    harness.queueAgentMessage.mockImplementation(async () => undefined);
    harness.listQueuedAgentMessages.mockResolvedValueOnce([
      queuePayload("agent-a", 2, ["first", "second"]),
    ]);
    const disposeSecond = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(2));

    expect(harness.queueAgentMessage.mock.calls.map(([, , options]) => options?.messageId)).toEqual(
      ["first", "second", "second"],
    );
    expect(state.unacknowledged).toEqual(new Map());
    expect(Array.from(state.intentVersions.keys())).toEqual([]);
    disposeSecond();
  });

  it("retries an accepted lost-response submission from the real submit path with the same stable id and clears it on authoritative reconnect", async () => {
    const state = createAgentMessageQueueSyncState();
    state.revisions.set("agent-a", 5);
    registerAgentMessageQueueSyncState(SERVER_ID, state);
    const harness = createClientHarness();
    harness.queueAgentMessage.mockRejectedValueOnce(
      new Error("response lost after durable accept"),
    );
    harness.listQueuedAgentMessages.mockResolvedValueOnce([
      queuePayload("agent-a", 6, ["stable-id"]),
    ]);

    const prepared = queueComposerServerMessage({
      agentId: "agent-a",
      text: "stable-id",
      attachments: [],
      queue: queueWriterForServer(SERVER_ID),
      messageId: "stable-id",
      registerIntent: (message) => {
        registerQueuedAgentMessageIntent({
          serverId: SERVER_ID,
          agentId: "agent-a",
          message,
        });
      },
      send: async (message) => {
        await harness.queueAgentMessage("agent-a", message.text, { messageId: message.id });
      },
    });
    expect(prepared.queued).toEqual(localMessage("stable-id"));
    await expect(prepared.submit?.()).rejects.toThrow("response lost after durable accept");
    expect(state.unacknowledged).toEqual(new Map([["agent-a", [localMessage("stable-id")]]]));

    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));

    expect(harness.queueAgentMessage).toHaveBeenCalledTimes(2);
    expect(
      harness.queueAgentMessage.mock.calls.map(([, text, options]) => ({
        text,
        messageId: options?.messageId,
      })),
    ).toEqual([
      { text: "stable-id", messageId: "stable-id" },
      { text: "stable-id", messageId: "stable-id" },
    ]);
    expect(state.unacknowledged).toEqual(new Map());
    expect(Array.from(state.intentVersions.keys())).toEqual([]);
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual([
      localMessage("stable-id"),
    ]);
    dispose();
  });

  it("immediately enqueues a recovered same-id edit draft in a healthy mounted session without overwriting newer composer input", async () => {
    const state = createAgentMessageQueueSyncState();
    state.revisions.set("agent-a", 5);
    registerAgentMessageQueueSyncState(SERVER_ID, state);
    const harness = createClientHarness();
    harness.listQueuedAgentMessages.mockResolvedValueOnce([]);

    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));

    const recoveredAttachment = reviewAttachment("Recovered review");
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const outcome = recoverQueuedComposerEditCancellation({
      agentId: "agent-a",
      queue: queueWriterForServer(SERVER_ID),
      message: {
        id: "stable-id",
        text: "recovered draft",
        attachments: [{ kind: "agent_attachment", attachment: recoveredAttachment }],
      },
      startedGeneration: 1,
      getCurrentGeneration: () => 2,
      draft: {
        text: "newer composer text",
        attachments: [],
      },
      setUserInput,
      setAttachments,
      registerRecoverableIntent: (message) => {
        registerQueuedAgentMessageIntent({
          serverId: SERVER_ID,
          agentId: "agent-a",
          message,
        });
      },
    });

    expect(outcome).toBe("requeued");
    expect(setUserInput).not.toHaveBeenCalled();
    expect(setAttachments).not.toHaveBeenCalled();
    expect(state.unacknowledged.get("agent-a")).toEqual([
      {
        id: "stable-id",
        text: "recovered draft",
        attachments: [{ kind: "agent_attachment", attachment: recoveredAttachment }],
      },
    ]);

    const registrationBeforeRpc =
      state.unacknowledged.get("agent-a")?.[0]?.id === "stable-id" &&
      state.intentVersions.get("agent-a\u0000stable-id") !== undefined;
    void enqueueRegisteredQueuedAgentMessageIntent({
      serverId: SERVER_ID,
      agentId: "agent-a",
      messageId: "stable-id",
    });
    await vi.waitFor(() => expect(harness.queueAgentMessage).toHaveBeenCalledTimes(1));

    expect(registrationBeforeRpc).toBe(true);
    expect(harness.queueAgentMessage).toHaveBeenCalledWith(
      "agent-a",
      "recovered draft",
      expect.objectContaining({
        messageId: "stable-id",
        attachments: [recoveredAttachment],
      }),
    );
    expect(state.unacknowledged.get("agent-a")).toEqual([
      {
        id: "stable-id",
        text: "recovered draft",
        attachments: [{ kind: "agent_attachment", attachment: recoveredAttachment }],
      },
    ]);
    dispose();
  });

  it("preserves a recovered pending id across higher authoritative omission while immediate enqueue is in flight and clears on later inclusion", async () => {
    const queueStart = deferred<void>();
    const state = createAgentMessageQueueSyncState();
    state.revisions.set("agent-a", 5);
    registerAgentMessageQueueSyncState(SERVER_ID, state);
    const harness = createClientHarness();
    harness.listQueuedAgentMessages.mockResolvedValueOnce([]);
    harness.queueAgentMessage.mockImplementationOnce(async () => await queueStart.promise);

    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));

    const recovered = {
      id: "stable-id",
      text: "recovered draft",
      attachments: [],
    };
    const outcome = recoverQueuedComposerEditCancellation({
      agentId: "agent-a",
      queue: queueWriterForServer(SERVER_ID),
      message: recovered,
      startedGeneration: 1,
      getCurrentGeneration: () => 2,
      draft: { text: "newer composer", attachments: [] },
      setUserInput: vi.fn(),
      setAttachments: vi.fn(),
      registerRecoverableIntent: (message) => {
        registerQueuedAgentMessageIntent({
          serverId: SERVER_ID,
          agentId: "agent-a",
          message,
        });
      },
    });
    expect(outcome).toBe("requeued");
    void enqueueRegisteredQueuedAgentMessageIntent({
      serverId: SERVER_ID,
      agentId: "agent-a",
      messageId: "stable-id",
    });
    await vi.waitFor(() => expect(harness.queueAgentMessage).toHaveBeenCalledTimes(1));

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", 6, []),
    });
    await vi.waitFor(() =>
      expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual(
        [recovered],
      ),
    );
    expect(state.unacknowledged).toEqual(new Map([["agent-a", [recovered]]]));
    expect(state.intentVersions.get("agent-a\u0000stable-id")).toBeDefined();

    queueStart.resolve();
    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", 7, ["stable-id"]),
    });
    await vi.waitFor(() => {
      expect(state.unacknowledged).toEqual(new Map());
      expect(Array.from(state.intentVersions.keys())).toEqual([]);
    });
    dispose();
  });

  it("preserves ownership through real omission before cancel reject and compensates with one same-id queue RPC", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const state = createAgentMessageQueueSyncState();
    const harness = createClientHarness();
    harness.listQueuedAgentMessages.mockResolvedValueOnce([
      queuePayload("agent-a", 5, ["stable-id"], {
        text: "queued draft",
        attachments: [reviewAttachment("queued review")],
        attachmentCount: 1,
      }),
    ]);
    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));
    const message = useSessionStore
      .getState()
      .sessions[SERVER_ID]?.queuedMessages.get("agent-a")?.[0];
    expect(message).toBeDefined();

    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const result = await orchestrateQueuedComposerServerEditCancellation({
      agentId: "agent-a",
      messageId: "stable-id",
      message: message!,
      queue: queueWriterForServer(SERVER_ID),
      startedGeneration: 3,
      getCurrentGeneration: () => 4,
      draft: {
        text: "newer composer text",
        attachments: [],
      },
      setUserInput,
      setAttachments,
      registerIntent: (queuedMessage) => {
        return registerQueuedAgentMessageIntent({
          serverId: SERVER_ID,
          agentId: "agent-a",
          message: queuedMessage,
        });
      },
      clearIntentIfCurrent: (messageId, token) =>
        clearQueuedAgentMessageIntentIfCurrent({
          serverId: SERVER_ID,
          agentId: "agent-a",
          messageId,
          token,
        }),
      enqueueCompensation: (messageId) => {
        void enqueueRegisteredQueuedAgentMessageIntent({
          serverId: SERVER_ID,
          agentId: "agent-a",
          messageId,
        });
      },
      cancelMessage: async (_agentId, messageId) => {
        expect(state.unacknowledged.get("agent-a")?.[0]?.id).toBe(messageId);
        expect(state.intentVersions.get(`agent-a\u0000${messageId}`)).toBeDefined();
        harness.emit({
          type: "queue.agent_message.updated",
          payload: queuePayload("agent-a", 6, []),
        });
        await vi.waitFor(() => expect(state.revisions.get("agent-a")).toBe(6));
        await vi.waitFor(() =>
          expect(
            useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a"),
          ).toEqual([message]),
        );
        expect(state.unacknowledged.get("agent-a")).toEqual([message!]);
        throw new Error("cancel committed but response lost");
      },
      onError: () => undefined,
    });

    expect(result).toBe("failed");
    await vi.waitFor(() => expect(harness.queueAgentMessage).toHaveBeenCalledTimes(1));
    expect(harness.queueAgentMessage).toHaveBeenCalledWith(
      "agent-a",
      "queued draft",
      expect.objectContaining({ messageId: "stable-id" }),
    );
    expect(state.unacknowledged.get("agent-a")).toEqual([message!]);
    expect(state.intentVersions.get("agent-a\u0000stable-id")).toBeDefined();
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual([
      message!,
    ]);
    expect(setUserInput).not.toHaveBeenCalled();
    expect(setAttachments).not.toHaveBeenCalled();
    dispose();
  });

  it("removes the preserved local row and clears intent when omission happens before a successful restored edit", async () => {
    const state = createAgentMessageQueueSyncState();
    const harness = createClientHarness();
    harness.listQueuedAgentMessages.mockResolvedValueOnce([
      queuePayload("agent-a", 5, ["stable-id"], {
        text: "queued draft",
        attachments: [reviewAttachment("queued review")],
        attachmentCount: 1,
      }),
    ]);
    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));
    const message = useSessionStore
      .getState()
      .sessions[SERVER_ID]?.queuedMessages.get("agent-a")?.[0];
    expect(message).toBeDefined();

    const restoredAttachments = [
      {
        kind: "agent_attachment" as const,
        attachment: reviewAttachment("queued review"),
      },
    ];
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const result = await orchestrateQueuedComposerServerEditCancellation({
      agentId: "agent-a",
      messageId: "stable-id",
      message: message!,
      queue: queueWriterForServer(SERVER_ID),
      startedGeneration: 3,
      getCurrentGeneration: () => 3,
      draft: {
        text: "queued draft",
        attachments: restoredAttachments,
      },
      setUserInput,
      setAttachments,
      registerIntent: (queuedMessage) => {
        return registerQueuedAgentMessageIntent({
          serverId: SERVER_ID,
          agentId: "agent-a",
          message: queuedMessage,
        });
      },
      clearIntentIfCurrent: (messageId, token) =>
        clearQueuedAgentMessageIntentIfCurrent({
          serverId: SERVER_ID,
          agentId: "agent-a",
          messageId,
          token,
        }),
      enqueueCompensation: (messageId) => {
        void enqueueRegisteredQueuedAgentMessageIntent({
          serverId: SERVER_ID,
          agentId: "agent-a",
          messageId,
        });
      },
      cancelMessage: async (_agentId, messageId) => {
        expect(state.unacknowledged.get("agent-a")?.[0]?.id).toBe(messageId);
        harness.emit({
          type: "queue.agent_message.updated",
          payload: queuePayload("agent-a", 6, []),
        });
        await vi.waitFor(() => expect(state.revisions.get("agent-a")).toBe(6));
        await vi.waitFor(() =>
          expect(
            useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a"),
          ).toEqual([message]),
        );
      },
      onError: () => undefined,
    });

    expect(result).toBe("restored");
    expect(setUserInput).toHaveBeenCalledWith("queued draft");
    expect(setAttachments).toHaveBeenCalledWith(restoredAttachments);
    expect(state.unacknowledged).toEqual(new Map());
    expect(Array.from(state.intentVersions.keys())).toEqual([]);
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual(
      [],
    );
    expect(harness.queueAgentMessage).not.toHaveBeenCalled();
    dispose();
  });

  it("retains a newer same-id replacement intent and mirror when the original cancel succeeds after re-registration", async () => {
    const state = createAgentMessageQueueSyncState();
    const harness = createClientHarness();
    harness.listQueuedAgentMessages.mockResolvedValueOnce([
      queuePayload("agent-a", 5, ["stable-id"], {
        text: "queued draft",
      }),
    ]);
    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));
    const original = useSessionStore
      .getState()
      .sessions[SERVER_ID]?.queuedMessages.get("agent-a")?.[0];
    expect(original).toBeDefined();

    const replacement = { id: "stable-id", text: "replacement draft", attachments: [] };
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const result = await orchestrateQueuedComposerServerEditCancellation({
      agentId: "agent-a",
      messageId: "stable-id",
      message: original!,
      queue: queueWriterForServer(SERVER_ID),
      startedGeneration: 3,
      getCurrentGeneration: () => 3,
      draft: { text: "queued draft", attachments: [] },
      setUserInput,
      setAttachments,
      registerIntent: (queuedMessage) =>
        registerQueuedAgentMessageIntent({
          serverId: SERVER_ID,
          agentId: "agent-a",
          message: queuedMessage,
        }),
      clearIntentIfCurrent: (messageId, token) =>
        clearQueuedAgentMessageIntentIfCurrent({
          serverId: SERVER_ID,
          agentId: "agent-a",
          messageId,
          token,
        }),
      enqueueCompensation: () => undefined,
      cancelMessage: async (_agentId, messageId) => {
        expect(state.unacknowledged.get("agent-a")?.[0]?.id).toBe(messageId);
        harness.emit({
          type: "queue.agent_message.updated",
          payload: queuePayload("agent-a", 6, []),
        });
        await vi.waitFor(() => expect(state.revisions.get("agent-a")).toBe(6));
        await vi.waitFor(() =>
          expect(
            useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a"),
          ).toEqual([original]),
        );
        registerQueuedAgentMessageIntent({
          serverId: SERVER_ID,
          agentId: "agent-a",
          message: replacement,
        });
        useSessionStore
          .getState()
          .setQueuedMessages(SERVER_ID, new Map([["agent-a", [replacement]]]));
      },
      onError: () => undefined,
    });

    expect(result).toBe("restored");
    expect(setUserInput).toHaveBeenCalledWith("queued draft");
    expect(setAttachments).toHaveBeenCalledWith([]);
    expect(state.unacknowledged.get("agent-a")).toEqual([replacement]);
    expect(state.intentVersions.get("agent-a\u0000stable-id")).toBeDefined();
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual([
      replacement,
    ]);
    dispose();
  });

  it("retains a rejected immediate recovery enqueue for same-id reconnect retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const state = createAgentMessageQueueSyncState();
    state.revisions.set("agent-a", 5);
    registerAgentMessageQueueSyncState(SERVER_ID, state);
    const firstHarness = createClientHarness();
    firstHarness.listQueuedAgentMessages.mockResolvedValueOnce([]);
    firstHarness.queueAgentMessage.mockRejectedValueOnce(new Error("response lost"));

    const disposeFirst = mountAgentMessageQueueSync({
      client: firstHarness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(firstHarness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));

    const recovered = {
      id: "stable-id",
      text: "recovered draft",
      attachments: [],
    };
    recoverQueuedComposerEditCancellation({
      agentId: "agent-a",
      queue: queueWriterForServer(SERVER_ID),
      message: recovered,
      startedGeneration: 1,
      getCurrentGeneration: () => 2,
      draft: { text: "newer composer", attachments: [] },
      setUserInput: vi.fn(),
      setAttachments: vi.fn(),
      registerRecoverableIntent: (message) => {
        registerQueuedAgentMessageIntent({
          serverId: SERVER_ID,
          agentId: "agent-a",
          message,
        });
      },
    });
    await enqueueRegisteredQueuedAgentMessageIntent({
      serverId: SERVER_ID,
      agentId: "agent-a",
      messageId: "stable-id",
    });
    expect(state.unacknowledged).toEqual(new Map([["agent-a", [recovered]]]));
    disposeFirst();

    const reconnectHarness = createClientHarness();
    reconnectHarness.listQueuedAgentMessages.mockResolvedValueOnce([
      queuePayload("agent-a", 6, ["stable-id"]),
    ]);
    const disposeReconnect = mountAgentMessageQueueSync({
      client: reconnectHarness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(reconnectHarness.queueAgentMessage).toHaveBeenCalledTimes(1));
    expect(reconnectHarness.queueAgentMessage).toHaveBeenCalledWith(
      "agent-a",
      "recovered draft",
      expect.objectContaining({ messageId: "stable-id" }),
    );
    await vi.waitFor(() => {
      expect(state.unacknowledged).toEqual(new Map());
      expect(Array.from(state.intentVersions.keys())).toEqual([]);
    });
    disposeReconnect();
  });

  it("runs exactly one latest follow-up when a newer same-id recovery arrives during migration", async () => {
    const firstSend = deferred<void>();
    const recoveredAttachment = reviewAttachment("Recovered review");
    const initial = { id: "stable-id", text: "old draft", attachments: [] };
    useSessionStore.getState().setQueuedMessages(SERVER_ID, new Map([["agent-a", [initial]]]));
    const state = createAgentMessageQueueSyncState();
    state.revisions.set("agent-a", 5);
    registerAgentMessageQueueSyncState(SERVER_ID, state);
    registerQueuedAgentMessageIntent({
      serverId: SERVER_ID,
      agentId: "agent-a",
      message: initial,
    });
    const harness = createClientHarness();
    harness.listQueuedAgentMessages.mockResolvedValueOnce([]);
    harness.queueAgentMessage
      .mockImplementationOnce(async () => await firstSend.promise)
      .mockResolvedValueOnce(undefined);

    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.queueAgentMessage).toHaveBeenCalledTimes(1));

    const recoveryOutcome = recoverQueuedComposerEditCancellation({
      agentId: "agent-a",
      queue: queueWriterForServer(SERVER_ID),
      message: {
        id: "stable-id",
        text: "recovered draft",
        attachments: [{ kind: "agent_attachment", attachment: recoveredAttachment }],
      },
      startedGeneration: 1,
      getCurrentGeneration: () => 2,
      draft: {
        text: "recovered draft",
        attachments: [{ kind: "agent_attachment", attachment: recoveredAttachment }],
      },
      setUserInput: vi.fn(),
      setAttachments: vi.fn(),
      registerRecoverableIntent: (message) => {
        registerQueuedAgentMessageIntent({
          serverId: SERVER_ID,
          agentId: "agent-a",
          message,
        });
      },
    });
    expect(recoveryOutcome).toBe("requeued");
    void enqueueRegisteredQueuedAgentMessageIntent({
      serverId: SERVER_ID,
      agentId: "agent-a",
      messageId: "stable-id",
    });

    await vi.waitFor(() => expect(harness.queueAgentMessage).toHaveBeenCalledTimes(1));
    firstSend.resolve();
    await vi.waitFor(() => expect(harness.queueAgentMessage).toHaveBeenCalledTimes(2));

    expect(
      harness.queueAgentMessage.mock.calls.map(([, text, options]) => ({
        text,
        messageId: options?.messageId,
        attachments: options?.attachments ?? [],
      })),
    ).toEqual([
      { text: "old draft", messageId: "stable-id", attachments: [] },
      {
        text: "recovered draft",
        messageId: "stable-id",
        attachments: [recoveredAttachment],
      },
    ]);
    dispose();
  });

  it("never sends a stale same-id payload after async image encoding and instead sends exactly one newest follow-up", async () => {
    const firstEncode = deferred<Array<{ data: string; mimeType: string }> | undefined>();
    const encodeSpy = vi.spyOn(encodeImageUtils, "encodeImages");
    encodeSpy
      .mockImplementationOnce(async () => await firstEncode.promise)
      .mockImplementationOnce(async (images) => encodeByImageId(images));
    const state = createAgentMessageQueueSyncState();
    registerAgentMessageQueueSyncState(SERVER_ID, state);
    const harness = createClientHarness();
    harness.listQueuedAgentMessages.mockResolvedValueOnce([]);
    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));

    registerQueuedAgentMessageIntent({
      serverId: SERVER_ID,
      agentId: "agent-a",
      message: {
        id: "stable-id",
        text: "old draft",
        attachments: [{ kind: "image", metadata: persistedImage("img-old") }],
      },
    });
    void enqueueRegisteredQueuedAgentMessageIntent({
      serverId: SERVER_ID,
      agentId: "agent-a",
      messageId: "stable-id",
    });
    await vi.waitFor(() => expect(encodeSpy).toHaveBeenCalledTimes(1));

    registerQueuedAgentMessageIntent({
      serverId: SERVER_ID,
      agentId: "agent-a",
      message: {
        id: "stable-id",
        text: "new draft",
        attachments: [{ kind: "image", metadata: persistedImage("img-new") }],
      },
    });
    void enqueueRegisteredQueuedAgentMessageIntent({
      serverId: SERVER_ID,
      agentId: "agent-a",
      messageId: "stable-id",
    });

    firstEncode.resolve([{ data: "encoded:img-old", mimeType: "image/png" }]);
    await vi.waitFor(() => expect(harness.queueAgentMessage).toHaveBeenCalledTimes(1));
    expect(harness.queueAgentMessage).toHaveBeenCalledWith(
      "agent-a",
      "new draft",
      expect.objectContaining({
        messageId: "stable-id",
        images: [{ data: "encoded:img-new", mimeType: "image/png" }],
      }),
    );
    expect(encodeSpy).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("retains retry state when a coalesced same-id follow-up enqueue rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const firstSend = deferred<void>();
    const recoveredAttachment = reviewAttachment("Recovered review");
    const initial = { id: "stable-id", text: "old draft", attachments: [] };
    useSessionStore.getState().setQueuedMessages(SERVER_ID, new Map([["agent-a", [initial]]]));
    const state = createAgentMessageQueueSyncState();
    state.revisions.set("agent-a", 5);
    registerAgentMessageQueueSyncState(SERVER_ID, state);
    registerQueuedAgentMessageIntent({
      serverId: SERVER_ID,
      agentId: "agent-a",
      message: initial,
    });
    const harness = createClientHarness();
    harness.queueAgentMessage
      .mockImplementationOnce(async () => await firstSend.promise)
      .mockRejectedValueOnce(new Error("follow-up lost"));
    harness.listQueuedAgentMessages.mockResolvedValueOnce([]);

    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.queueAgentMessage).toHaveBeenCalledTimes(1));

    const recovered = {
      id: "stable-id",
      text: "recovered draft",
      attachments: [{ kind: "agent_attachment" as const, attachment: recoveredAttachment }],
    };
    expect(
      recoverQueuedComposerEditCancellation({
        agentId: "agent-a",
        queue: queueWriterForServer(SERVER_ID),
        message: recovered,
        startedGeneration: 1,
        getCurrentGeneration: () => 2,
        draft: {
          text: "recovered draft",
          attachments: [{ kind: "agent_attachment", attachment: recoveredAttachment }],
        },
        setUserInput: vi.fn(),
        setAttachments: vi.fn(),
        registerRecoverableIntent: (message) => {
          registerQueuedAgentMessageIntent({
            serverId: SERVER_ID,
            agentId: "agent-a",
            message,
          });
        },
      }),
    ).toBe("requeued");
    void enqueueRegisteredQueuedAgentMessageIntent({
      serverId: SERVER_ID,
      agentId: "agent-a",
      messageId: "stable-id",
    });

    firstSend.resolve();
    await vi.waitFor(() => expect(harness.queueAgentMessage).toHaveBeenCalledTimes(2));
    await Promise.resolve();

    expect(state.unacknowledged).toEqual(new Map([["agent-a", [recovered]]]));
    expect(state.intentVersions.get("agent-a\u0000stable-id")).toBeDefined();
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual([
      recovered,
    ]);
    dispose();
  });

  it("preserves a same-id edit recovery registered during reconnect migration and retries the recovered payload exactly once", async () => {
    const queueStart = deferred<void>();
    const initial = { id: "stable-id", text: "old draft", attachments: [] };
    useSessionStore.getState().setQueuedMessages(SERVER_ID, new Map([["agent-a", [initial]]]));
    const state = createAgentMessageQueueSyncState();
    state.revisions.set("agent-a", 5);
    registerAgentMessageQueueSyncState(SERVER_ID, state);
    registerQueuedAgentMessageIntent({
      serverId: SERVER_ID,
      agentId: "agent-a",
      message: initial,
    });
    const harness = createClientHarness();
    harness.queueAgentMessage.mockImplementationOnce(async () => await queueStart.promise);
    harness.listQueuedAgentMessages
      .mockResolvedValueOnce([queuePayload("agent-a", 6, ["server-msg"])])
      .mockResolvedValueOnce([queuePayload("agent-a", 7, ["server-msg", "stable-id"])]);

    const disposeFirst = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.queueAgentMessage).toHaveBeenCalledTimes(1));

    const recoveredAttachment = reviewAttachment("Recovered review");
    const recoveryQueue = queueWriterForServer(SERVER_ID);
    const recoveryOutcome = recoverQueuedComposerEditCancellation({
      agentId: "agent-a",
      queue: recoveryQueue,
      message: {
        id: "stable-id",
        text: "recovered draft",
        attachments: [{ kind: "agent_attachment", attachment: recoveredAttachment }],
      },
      startedGeneration: 1,
      getCurrentGeneration: () => 2,
      draft: {
        text: "recovered draft",
        attachments: [{ kind: "agent_attachment", attachment: recoveredAttachment }],
      },
      setUserInput: vi.fn(),
      setAttachments: vi.fn(),
      registerRecoverableIntent: (message) => {
        registerQueuedAgentMessageIntent({
          serverId: SERVER_ID,
          agentId: "agent-a",
          message,
        });
      },
    });
    expect(recoveryOutcome).toBe("requeued");
    expect(state.unacknowledged.get("agent-a")).toEqual([
      {
        id: "stable-id",
        text: "recovered draft",
        attachments: [{ kind: "agent_attachment", attachment: recoveredAttachment }],
      },
    ]);

    queueStart.resolve();
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));
    expect(
      useSessionStore
        .getState()
        .sessions[SERVER_ID]?.queuedMessages.get("agent-a")
        ?.map((message) => ({
          id: message.id,
          text: message.text,
        })),
    ).toEqual([
      { id: "server-msg", text: "server-msg" },
      { id: "stable-id", text: "recovered draft" },
    ]);
    expect(state.unacknowledged.get("agent-a")).toEqual([
      {
        id: "stable-id",
        text: "recovered draft",
        attachments: [{ kind: "agent_attachment", attachment: recoveredAttachment }],
      },
    ]);
    disposeFirst();

    harness.queueAgentMessage.mockImplementation(async () => undefined);
    const disposeSecond = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(2));

    expect(
      harness.queueAgentMessage.mock.calls.map(([, text, options]) => ({
        text,
        messageId: options?.messageId,
        attachments: options?.attachments ?? [],
      })),
    ).toEqual([
      { text: "old draft", messageId: "stable-id", attachments: [] },
      {
        text: "recovered draft",
        messageId: "stable-id",
        attachments: [recoveredAttachment],
      },
    ]);
    expect(
      useSessionStore
        .getState()
        .sessions[SERVER_ID]?.queuedMessages.get("agent-a")
        ?.map((message) => ({
          id: message.id,
          text: message.text,
        })),
    ).toEqual([
      { id: "server-msg", text: "server-msg" },
      { id: "stable-id", text: "stable-id" },
    ]);
    expect(state.unacknowledged).toEqual(new Map());
    expect(Array.from(state.intentVersions.keys())).toEqual([]);
    disposeSecond();
  });

  it("retains versioned legacy migration candidates across authoritative omission and clears on later inclusion", async () => {
    useSessionStore
      .getState()
      .setQueuedMessages(SERVER_ID, new Map([["agent-a", [localMessage("legacy-local")]]]));
    const state = createAgentMessageQueueSyncState();
    const harness = createClientHarness();
    harness.listQueuedAgentMessages.mockResolvedValueOnce([queuePayload("agent-a", 1, [])]);

    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));

    expect(harness.queueAgentMessage).toHaveBeenCalledTimes(1);
    expect(harness.queueAgentMessage).toHaveBeenCalledWith(
      "agent-a",
      "legacy-local",
      expect.objectContaining({ messageId: "legacy-local" }),
    );
    expect(state.unacknowledged).toEqual(new Map([["agent-a", [localMessage("legacy-local")]]]));
    expect(state.intentVersions.get("agent-a\u0000legacy-local")).toBeDefined();
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual([
      localMessage("legacy-local"),
    ]);
    dispose();

    const reconnectHarness = createClientHarness();
    reconnectHarness.listQueuedAgentMessages.mockResolvedValueOnce([
      queuePayload("agent-a", 2, ["legacy-local"]),
    ]);
    const disposeReconnect = mountAgentMessageQueueSync({
      client: reconnectHarness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() =>
      expect(reconnectHarness.listQueuedAgentMessages).toHaveBeenCalledTimes(1),
    );
    expect(reconnectHarness.queueAgentMessage).toHaveBeenCalledTimes(1);
    expect(reconnectHarness.queueAgentMessage).toHaveBeenCalledWith(
      "agent-a",
      "legacy-local",
      expect.objectContaining({ messageId: "legacy-local" }),
    );
    expect(state.unacknowledged).toEqual(new Map());
    expect(Array.from(state.intentVersions.keys())).toEqual([]);
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual([
      localMessage("legacy-local"),
    ]);
    disposeReconnect();
  });

  it("retains an intent token for failed legacy migration until explicit authoritative disposition", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    useSessionStore
      .getState()
      .setQueuedMessages(SERVER_ID, new Map([["agent-a", [localMessage("legacy-local")]]]));
    const state = createAgentMessageQueueSyncState();
    const harness = createClientHarness();
    harness.queueAgentMessage.mockRejectedValue(new Error("unknown legacy outcome"));
    harness.listQueuedAgentMessages.mockResolvedValueOnce([]);

    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));

    expect(state.unacknowledged).toEqual(new Map([["agent-a", [localMessage("legacy-local")]]]));
    expect(state.intentVersions.get("agent-a\u0000legacy-local")).toBeDefined();
    dispose();
  });

  it("applies the authoritative empty queue before archive and blocks later enqueue attempts", async () => {
    const state = createAgentMessageQueueSyncState();
    const harness = createClientHarness();
    harness.listQueuedAgentMessages.mockResolvedValueOnce([
      queuePayload("agent-archive", 3, ["acknowledged"]),
    ]);

    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() =>
      expect(
        useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-archive"),
      ).toEqual([localMessage("acknowledged")]),
    );
    expect(state.revisions).toEqual(new Map([["agent-archive", 3]]));

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-archive", 4, []),
    });
    await vi.waitFor(() =>
      expect(
        useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.has("agent-archive"),
      ).toBe(false),
    );
    expect(state.revisions).toEqual(new Map([["agent-archive", 4]]));

    harness.emit({
      type: "agent_archived",
      payload: {
        agentId: "agent-archive",
        archivedAt: "2026-07-20T00:00:00.000Z",
        requestId: "archive-request",
      },
    });
    expect(state.inactiveAgentIds.has("agent-archive")).toBe(true);
    expect(
      registerQueuedAgentMessageIntent({
        serverId: SERVER_ID,
        agentId: "agent-archive",
        message: localMessage("blocked-archive"),
      }),
    ).toBeNull();
    expect(
      enqueueRegisteredQueuedAgentMessageIntent({
        serverId: SERVER_ID,
        agentId: "agent-archive",
        messageId: "blocked-archive",
      }),
    ).toBeNull();
    expect(harness.queueAgentMessage).not.toHaveBeenCalled();
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages).toEqual(new Map());
    expect(state.unacknowledged).toEqual(new Map());
    expect(state.intentVersions).toEqual(new Map());
    dispose();
  });

  it("keeps an archived queue empty through unarchive reconciliation and reconnect", async () => {
    const state = createAgentMessageQueueSyncState();
    const firstHarness = createClientHarness();
    firstHarness.listQueuedAgentMessages.mockResolvedValueOnce([
      queuePayload("agent-archive", 3, ["acknowledged"]),
    ]);

    const disposeFirst = mountAgentMessageQueueSync({
      client: firstHarness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() =>
      expect(
        useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-archive"),
      ).toEqual([localMessage("acknowledged")]),
    );

    firstHarness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-archive", 4, []),
    });
    await vi.waitFor(() =>
      expect(
        useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.has("agent-archive"),
      ).toBe(false),
    );

    firstHarness.emit({
      type: "agent_archived",
      payload: {
        agentId: "agent-archive",
        archivedAt: "2026-07-20T00:00:00.000Z",
        requestId: "archive-request",
      },
    });
    useSessionStore.getState().setHasHydratedAgents(SERVER_ID, true);
    useSessionStore.getState().setAgents(
      SERVER_ID,
      new Map([
        [
          "agent-archive",
          {
            id: "agent-archive",
            serverId: SERVER_ID,
            workspaceId: null,
            name: "Archived agent",
            model: "test",
            status: "idle",
            taskStatus: null,
            createdAt: new Date("2026-07-20T00:00:00.000Z"),
            updatedAt: new Date("2026-07-20T00:00:00.000Z"),
            archivedAt: null,
            systemPrompt: null,
            workingDirectory: null,
            branchName: null,
            baseBranchName: null,
            hasUncommittedChanges: false,
            aheadCount: 0,
            behindCount: 0,
            workspaceName: null,
            projectId: null,
            parentAgentId: null,
            latestCommitSha: null,
            latestCommitSummary: null,
            currentTaskId: null,
            currentTaskTitle: null,
          },
        ],
      ]) as never,
    );

    await vi.waitFor(() => expect(state.inactiveAgentIds.has("agent-archive")).toBe(true));
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages).toEqual(new Map());
    expect(state.revisions).toEqual(new Map([["agent-archive", 4]]));
    disposeFirst();

    const secondHarness = createClientHarness();
    secondHarness.listQueuedAgentMessages.mockResolvedValueOnce([
      queuePayload("agent-archive", 4, []),
    ]);
    const disposeSecond = mountAgentMessageQueueSync({
      client: secondHarness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(secondHarness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));
    expect(secondHarness.queueAgentMessage).not.toHaveBeenCalled();
    expect(
      registerQueuedAgentMessageIntent({
        serverId: SERVER_ID,
        agentId: "agent-archive",
        message: localMessage("blocked-remount"),
      }),
    ).toBeNull();
    expect(
      enqueueRegisteredQueuedAgentMessageIntent({
        serverId: SERVER_ID,
        agentId: "agent-archive",
        messageId: "blocked-remount",
      }),
    ).toBeNull();
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages).toEqual(new Map());
    expect(state.revisions).toEqual(new Map([["agent-archive", 4]]));
    disposeSecond();
  });

  it("applies an archived reconnect tombstone to stale local queue state", async () => {
    const metadata = persistedImage("archived-stale-image");
    const staleMessage = {
      id: "stale-local",
      text: "stale-local",
      attachments: [{ kind: "image" as const, metadata }],
    };
    useSessionStore
      .getState()
      .setQueuedMessages(SERVER_ID, new Map([["agent-archive", [staleMessage]]]));
    const state = createAgentMessageQueueSyncState();
    state.inactiveAgentIds.add("agent-archive");
    state.revisions.set("agent-archive", 3);
    state.unacknowledged.set("agent-archive", [staleMessage]);
    state.intentVersions.set("agent-archive\u0000stale-local", {});
    state.pendingEnqueueFollowUps.set("agent-archive\u0000stale-local", {
      serverId: SERVER_ID,
      agentId: "agent-archive",
      message: staleMessage,
      token: {},
    });
    const cleanup = vi.spyOn(attachmentService, "deleteAttachments").mockResolvedValue();
    const harness = createClientHarness();
    harness.listQueuedAgentMessages.mockResolvedValueOnce([queuePayload("agent-archive", 4, [])]);

    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });

    await vi.waitFor(() =>
      expect(
        useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.has("agent-archive"),
      ).toBe(false),
    );
    expect(state.revisions).toEqual(new Map([["agent-archive", 4]]));
    expect(state.unacknowledged).toEqual(new Map());
    expect(state.intentVersions).toEqual(new Map());
    expect(state.pendingEnqueueFollowUps).toEqual(new Map());
    expect(cleanup).toHaveBeenCalledWith([metadata]);
    expect(harness.queueAgentMessage).not.toHaveBeenCalled();
    dispose();
  });

  it("prunes pending queues missing from an authoritative active-agent directory", async () => {
    useSessionStore
      .getState()
      .setQueuedMessages(
        SERVER_ID,
        new Map([["removed-while-disconnected", [localMessage("pending")]]]),
      );
    useSessionStore.getState().setHasHydratedAgents(SERVER_ID, true);
    const state = createAgentMessageQueueSyncState();
    state.revisions.set("removed-while-disconnected", 3);
    state.unacknowledged.set("removed-while-disconnected", [localMessage("pending")]);
    const harness = createClientHarness();

    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));

    expect(harness.queueAgentMessage).not.toHaveBeenCalled();
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages).toEqual(
      new Map([["removed-while-disconnected", [localMessage("pending")]]]),
    );
    expect(state.revisions).toEqual(new Map([["removed-while-disconnected", 3]]));
    expect(state.unacknowledged).toEqual(
      new Map([["removed-while-disconnected", [localMessage("pending")]]]),
    );
    dispose();
  });

  it("tombstones a deleted agent across delayed registration, in-flight encoding, and remount", async () => {
    const encodeStart = deferred<Array<{ data: string; mimeType: string }> | undefined>();
    const encodeSpy = vi
      .spyOn(encodeImageUtils, "encodeImages")
      .mockImplementationOnce(async () => await encodeStart.promise);
    useSessionStore.getState().setQueuedMessages(
      SERVER_ID,
      new Map([
        [
          "agent-delete",
          [
            {
              id: "stable-id",
              text: "delete me",
              attachments: [{ kind: "image", metadata: persistedImage("img-delete") }],
            },
          ],
        ],
      ]),
    );
    const state = createAgentMessageQueueSyncState();
    state.revisions.set("agent-delete", 7);
    registerAgentMessageQueueSyncState(SERVER_ID, state);
    registerQueuedAgentMessageIntent({
      serverId: SERVER_ID,
      agentId: "agent-delete",
      message: {
        id: "stable-id",
        text: "delete me",
        attachments: [{ kind: "image", metadata: persistedImage("img-delete") }],
      },
    });
    const harness = createClientHarness();
    harness.listQueuedAgentMessages.mockResolvedValueOnce([]);
    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });

    void enqueueRegisteredQueuedAgentMessageIntent({
      serverId: SERVER_ID,
      agentId: "agent-delete",
      messageId: "stable-id",
    });
    await vi.waitFor(() => expect(encodeSpy).toHaveBeenCalledTimes(1));
    state.pendingEnqueueFollowUps.set("agent-delete\u0000stable-id", {
      serverId: SERVER_ID,
      agentId: "agent-delete",
      message: {
        id: "stable-id",
        text: "delete me later",
        attachments: [],
      },
      token: {},
    });

    harness.emit({
      type: "agent_deleted",
      payload: { agentId: "agent-delete", requestId: "delete-request" },
    });
    expect(state.deletedAgentIds.has("agent-delete")).toBe(true);
    expect(state.revisions.has("agent-delete")).toBe(false);
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-delete")).toBe(
      undefined,
    );
    expect(state.unacknowledged.get("agent-delete")).toBe(undefined);
    expect(state.intentVersions.get("agent-delete\u0000stable-id")).toBe(undefined);
    expect(state.pendingEnqueueFollowUps.get("agent-delete\u0000stable-id")).toBe(undefined);
    expect(
      registerQueuedAgentMessageIntent({
        serverId: SERVER_ID,
        agentId: "agent-delete",
        message: {
          id: "stable-id",
          text: "late recovery",
          attachments: [],
        },
      }),
    ).toBeNull();

    encodeStart.resolve([{ data: "encoded:img-delete", mimeType: "image/png" }]);
    await vi.waitFor(() => expect(harness.queueAgentMessage).toHaveBeenCalledTimes(0));
    dispose();

    const remountHarness = createClientHarness();
    remountHarness.listQueuedAgentMessages.mockResolvedValueOnce([
      queuePayload("agent-delete", 4, ["stable-id"], {
        images: [{ data: "Zm9v", mimeType: "image/png" }],
        imageCount: 1,
      }),
    ]);
    const disposeRemount = mountAgentMessageQueueSync({
      client: remountHarness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(remountHarness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));
    expect(remountHarness.queueAgentMessage).not.toHaveBeenCalled();
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-delete")).toBe(
      undefined,
    );
    disposeRemount();
  });

  it("cleans only staged hydration metadata when an agent is deleted before deferred persistence settles", async () => {
    const persistGate = deferred<AttachmentMetadata>();
    const liveImage = persistedImage("img-live-delete-hydration");
    const cleanup = vi.spyOn(attachmentService, "deleteAttachments").mockResolvedValue();
    const persist = vi
      .spyOn(attachmentService, "persistAttachmentFromDataUrl")
      .mockImplementation(async ({ id }) => {
        await persistGate.promise;
        return {
          id: id ?? "missing-staged-id",
          storageKey: id ?? "missing-staged-id",
          storageType: "web-indexeddb",
          mimeType: "image/png",
          fileName: `${id}.png`,
          byteSize: 1,
          createdAt: 1,
        };
      });
    useSessionStore.getState().setQueuedMessages(
      SERVER_ID,
      new Map([
        [
          "agent-delete-hydration",
          [
            {
              id: "same-id",
              text: "stable",
              attachments: [{ kind: "image", metadata: liveImage }],
            },
          ],
        ],
      ]),
    );
    const state = createAgentMessageQueueSyncState();
    state.revisions.set("agent-delete-hydration", 5);
    const harness = createClientHarness();
    harness.listQueuedAgentMessages.mockResolvedValueOnce([]);
    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-delete-hydration", 6, ["same-id"], {
        text: "stable",
        images: [{ data: "ZGVsZXRlZA==", mimeType: "image/png" }],
        imageCount: 1,
      }),
    });
    const stagedId = (await vi.waitFor(() => persist.mock.calls[0]?.[0].id)) ?? "missing-staged-id";

    harness.emit({
      type: "agent_deleted",
      payload: {
        agentId: "agent-delete-hydration",
        requestId: "delete-during-hydration",
      },
    });
    expect(state.deletedAgentIds.has("agent-delete-hydration")).toBe(true);
    expect(
      useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-delete-hydration"),
    ).toBe(undefined);
    expect(state.revisions.has("agent-delete-hydration")).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();

    persistGate.resolve({
      id: stagedId,
      storageKey: stagedId,
      storageType: "web-indexeddb",
      mimeType: "image/png",
      fileName: `${stagedId}.png`,
      byteSize: 1,
      createdAt: 1,
    });

    await vi.waitFor(() =>
      expect(cleanup).toHaveBeenCalledWith([
        expect.objectContaining({ id: stagedId, storageKey: stagedId }),
      ]),
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup.mock.calls[0]?.[0]?.map((metadata) => metadata.id)).toEqual([stagedId]);
    expect(harness.queueAgentMessage).not.toHaveBeenCalled();
    expect(
      useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-delete-hydration"),
    ).toBe(undefined);
    expect(state.deletedAgentIds.has("agent-delete-hydration")).toBe(true);
    expect(state.revisions.has("agent-delete-hydration")).toBe(false);
    expect(state.unacknowledged.get("agent-delete-hydration")).toBe(undefined);
    dispose();
  });

  it("cleans only staged hydration metadata when an agent becomes directory-ineligible before deferred persistence settles", async () => {
    const persistGate = deferred<AttachmentMetadata>();
    const liveImage = persistedImage("img-live-directory-hydration");
    const cleanup = vi.spyOn(attachmentService, "deleteAttachments").mockResolvedValue();
    const persist = vi
      .spyOn(attachmentService, "persistAttachmentFromDataUrl")
      .mockImplementation(async ({ id }) => {
        await persistGate.promise;
        return {
          id: id ?? "missing-directory-staged-id",
          storageKey: id ?? "missing-directory-staged-id",
          storageType: "web-indexeddb",
          mimeType: "image/png",
          fileName: `${id}.png`,
          byteSize: 1,
          createdAt: 1,
        };
      });
    useSessionStore.getState().setQueuedMessages(
      SERVER_ID,
      new Map([
        [
          "agent-directory-hydration",
          [
            {
              id: "same-id",
              text: "stable",
              attachments: [{ kind: "image", metadata: liveImage }],
            },
          ],
        ],
      ]),
    );
    const state = createAgentMessageQueueSyncState();
    state.revisions.set("agent-directory-hydration", 5);
    const harness = createClientHarness();
    harness.listQueuedAgentMessages.mockResolvedValueOnce([]);
    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-directory-hydration", 6, ["same-id"], {
        text: "stable",
        images: [{ data: "ZGlyZWN0b3J5", mimeType: "image/png" }],
        imageCount: 1,
      }),
    });
    const stagedId =
      (await vi.waitFor(() => persist.mock.calls[0]?.[0].id)) ?? "missing-directory-staged-id";

    useSessionStore.getState().setHasHydratedAgents(SERVER_ID, true);
    useSessionStore.getState().setAgents(SERVER_ID, new Map());
    expect(cleanup).not.toHaveBeenCalled();

    persistGate.resolve({
      id: stagedId,
      storageKey: stagedId,
      storageType: "web-indexeddb",
      mimeType: "image/png",
      fileName: `${stagedId}.png`,
      byteSize: 1,
      createdAt: 1,
    });

    await vi.waitFor(() =>
      expect(cleanup).toHaveBeenCalledWith([
        expect.objectContaining({ id: stagedId, storageKey: stagedId }),
      ]),
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup.mock.calls[0]?.[0]?.map((metadata) => metadata.id)).toEqual([stagedId]);
    expect(harness.queueAgentMessage).not.toHaveBeenCalled();
    expect(
      useSessionStore
        .getState()
        .sessions[SERVER_ID]?.queuedMessages.get("agent-directory-hydration"),
    ).toEqual([
      {
        id: "same-id",
        text: "stable",
        attachments: [{ kind: "image", metadata: liveImage }],
      },
    ]);
    expect(state.revisions).toEqual(new Map([["agent-directory-hydration", 5]]));
    dispose();
  });

  it("prefers the later received legacy event when hydration resolves out of order", async () => {
    const first = deferred<QueuedAgentMessageQueuePayload[]>();
    const second = deferred<QueuedAgentMessageQueuePayload[]>();
    const harness = createClientHarness();
    harness.listQueuedAgentMessages
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () => await first.promise)
      .mockImplementationOnce(async () => await second.promise);

    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state: createAgentMessageQueueSyncState(),
    });

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", undefined, ["legacy-a"], {
        imageCount: 1,
      }),
    });
    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", undefined, ["legacy-b"], {
        imageCount: 1,
      }),
    });
    second.resolve([queuePayload("agent-a", undefined, ["legacy-b-full"])]);
    await vi.waitFor(() =>
      expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual(
        [localMessage("legacy-b-full")],
      ),
    );

    first.resolve([queuePayload("agent-a", undefined, ["legacy-a-full"])]);
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(3));
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual([
      localMessage("legacy-b-full"),
    ]);
    dispose();
  });

  it("still applies sequential legacy updates when they resolve in receipt order", async () => {
    const harness = createClientHarness();
    harness.listQueuedAgentMessages
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([queuePayload("agent-a", undefined, ["legacy-a-full"])])
      .mockResolvedValueOnce([queuePayload("agent-a", undefined, ["legacy-b-full"])]);

    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state: createAgentMessageQueueSyncState(),
    });

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", undefined, ["legacy-a"], {
        attachmentCount: 1,
      }),
    });
    await vi.waitFor(() =>
      expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual(
        [localMessage("legacy-a-full")],
      ),
    );

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", undefined, ["legacy-b"], {
        attachmentCount: 1,
      }),
    });
    await vi.waitFor(() =>
      expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual(
        [localMessage("legacy-b-full")],
      ),
    );
    dispose();
  });

  it("hydrates compact structured attachments when attachment counts exceed the represented payload", async () => {
    vi.spyOn(attachmentService, "persistAttachmentFromDataUrl").mockResolvedValue(
      persistedImage("img-structured"),
    );
    const harness = createClientHarness();
    harness.listQueuedAgentMessages.mockResolvedValueOnce([queuePayload("agent-a", 1, [])]);
    harness.listQueuedAgentMessages.mockResolvedValueOnce([
      queuePayload("agent-a", 3, ["structured-full"], {
        attachmentCount: 1,
        attachments: [reviewAttachment("Recovered review")],
      }),
    ]);

    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state: createAgentMessageQueueSyncState(),
    });

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", 2, ["structured-full"], {
        attachmentCount: 1,
        attachments: [],
      }),
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(2));
    expect(
      useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")?.[0]
        ?.attachments,
    ).toEqual([{ kind: "agent_attachment", attachment: reviewAttachment("Recovered review") }]);
    dispose();
  });

  it("repairs same-id partial mirrors with fully hydrated images and structured attachments", async () => {
    vi.spyOn(attachmentService, "persistAttachmentFromDataUrl").mockResolvedValue(
      persistedImage("img-repaired"),
    );
    useSessionStore.getState().setQueuedMessages(
      SERVER_ID,
      new Map([
        [
          "agent-a",
          [
            {
              id: "same-id",
              text: "same-id",
              attachments: [
                {
                  kind: "agent_attachment",
                  attachment: reviewAttachment("stale"),
                },
              ],
            },
          ],
        ],
      ]),
    );
    const harness = createClientHarness();
    harness.listQueuedAgentMessages.mockResolvedValueOnce([]).mockResolvedValueOnce([
      queuePayload("agent-a", 3, ["same-id"], {
        images: [{ data: "Zm9v", mimeType: "image/png" }],
        imageCount: 1,
        attachments: [reviewAttachment("fresh review")],
        attachmentCount: 1,
      }),
    ]);

    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state: createAgentMessageQueueSyncState(),
    });

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", 2, ["same-id"], {
        images: [],
        imageCount: 1,
        attachments: [],
        attachmentCount: 1,
      }),
    });
    await vi.waitFor(() =>
      expect(
        useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")?.[0]
          ?.attachments,
      ).toEqual([
        { kind: "image", metadata: persistedImage("img-repaired") },
        { kind: "agent_attachment", attachment: reviewAttachment("fresh review") },
      ]),
    );
    dispose();
  });

  it("retains the previous mirror when image persistence fails and retries successfully later", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const persist = vi.spyOn(attachmentService, "persistAttachmentFromDataUrl");
    persist
      .mockRejectedValueOnce(new Error("transient persist failure"))
      .mockResolvedValueOnce(persistedImage("img-retry"));
    useSessionStore.getState().setQueuedMessages(
      SERVER_ID,
      new Map([
        [
          "agent-a",
          [
            {
              id: "hydrated",
              text: "hydrated",
              attachments: [],
            },
          ],
        ],
      ]),
    );
    const harness = createClientHarness();
    harness.listQueuedAgentMessages
      .mockResolvedValueOnce([
        queuePayload("agent-a", 2, ["hydrated"], {
          images: [{ data: "Zm9v", mimeType: "image/png" }],
          imageCount: 1,
        }),
      ])
      .mockResolvedValueOnce([
        queuePayload("agent-a", 3, ["hydrated"], {
          images: [{ data: "Zm9v", mimeType: "image/png" }],
          imageCount: 1,
        }),
      ]);

    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state: createAgentMessageQueueSyncState(),
    });

    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual([
      { id: "hydrated", text: "hydrated", attachments: [] },
    ]);

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", 3, ["hydrated"], {
        images: [],
        imageCount: 1,
      }),
    });
    await vi.waitFor(() =>
      expect(
        useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")?.[0]
          ?.attachments,
      ).toEqual([{ kind: "image", metadata: persistedImage("img-retry") }]),
    );
    dispose();
  });

  it("uses distinct persisted image ids for the same message id across different servers and agents", async () => {
    const persist = vi
      .spyOn(attachmentService, "persistAttachmentFromDataUrl")
      .mockResolvedValue(persistedImage("img-collision-safe"));
    const serverA = "queue-sync-collision-a";
    const serverB = "queue-sync-collision-b";
    const serverC = "queue-sync-collision-c";
    useSessionStore.getState().initializeSession(serverA, null);
    useSessionStore.getState().initializeSession(serverB, null);
    useSessionStore.getState().initializeSession(serverC, null);
    const harnessA = createClientHarness();
    harnessA.listQueuedAgentMessages.mockResolvedValueOnce([
      queuePayload("agent-a", 1, ["same-id"], {
        images: [{ data: "Zm9v", mimeType: "image/png" }],
        imageCount: 1,
      }),
    ]);
    const harnessB = createClientHarness();
    harnessB.listQueuedAgentMessages.mockResolvedValueOnce([
      queuePayload("agent-b", 1, ["same-id"], {
        images: [{ data: "YmFy", mimeType: "image/png" }],
        imageCount: 1,
      }),
    ]);
    const harnessC = createClientHarness();
    harnessC.listQueuedAgentMessages.mockResolvedValueOnce([
      queuePayload("agent-a", 1, ["same-id"], {
        images: [{ data: "YmF6", mimeType: "image/png" }],
        imageCount: 1,
      }),
    ]);

    const disposeA = mountAgentMessageQueueSync({
      client: harnessA.client,
      serverId: serverA,
      state: createAgentMessageQueueSyncState(),
    });
    const disposeB = mountAgentMessageQueueSync({
      client: harnessB.client,
      serverId: serverB,
      state: createAgentMessageQueueSyncState(),
    });
    const disposeC = mountAgentMessageQueueSync({
      client: harnessC.client,
      serverId: serverC,
      state: createAgentMessageQueueSyncState(),
    });

    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(3));
    const ids = Array.from(new Set(persist.mock.calls.map(([input]) => input.id))).sort();
    expect(ids).toHaveLength(3);
    expect(ids.every((id) => id?.includes(":queue-sync-collision-"))).toBe(true);
    expect(
      ids.some((id) =>
        /^queued-staged:[^:]+:queue-sync-collision-a:agent-a:same-id:rev-1:1:0$/.test(id ?? ""),
      ),
    ).toBe(true);
    expect(
      ids.some((id) =>
        /^queued-staged:[^:]+:queue-sync-collision-b:agent-b:same-id:rev-1:1:0$/.test(id ?? ""),
      ),
    ).toBe(true);
    expect(
      ids.some((id) =>
        /^queued-staged:[^:]+:queue-sync-collision-c:agent-a:same-id:rev-1:1:0$/.test(id ?? ""),
      ),
    ).toBe(true);
    expect(new Set(ids.map((id) => id?.split(":")[1]))).toHaveLength(3);

    disposeA();
    disposeB();
    disposeC();
    useSessionStore.getState().clearSession(serverA);
    useSessionStore.getState().clearSession(serverB);
    useSessionStore.getState().clearSession(serverC);
  });

  it("keeps the live image mirror for lower and conflicting-equal revisions, then publishes staged images on a higher revision", async () => {
    const originalImage = persistedImage("img-original");
    const equalConflictImage = persistedImage("img-equal-conflict");
    const acceptedImage = persistedImage("img-accepted");
    const persist = vi.spyOn(attachmentService, "persistAttachmentFromDataUrl");
    const cleanup = vi.spyOn(attachmentService, "deleteAttachments").mockResolvedValue();
    persist.mockResolvedValueOnce(equalConflictImage).mockResolvedValueOnce(acceptedImage);
    useSessionStore.getState().setQueuedMessages(
      SERVER_ID,
      new Map([
        [
          "agent-a",
          [
            {
              id: "same-id",
              text: "stable",
              attachments: [{ kind: "image", metadata: originalImage }],
            },
          ],
        ],
      ]),
    );
    const state = createAgentMessageQueueSyncState();
    state.revisions.set("agent-a", 5);
    const harness = createClientHarness();
    harness.listQueuedAgentMessages.mockResolvedValueOnce([]).mockResolvedValueOnce([
      queuePayload("agent-a", 6, ["same-id"], {
        text: "stable",
        images: [
          { data: "Zmlyc3Q=", mimeType: "image/png" },
          { data: "c2Vjb25k", mimeType: "image/png" },
        ],
        imageCount: 2,
      }),
    ]);

    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", 4, ["same-id"], {
        text: "lower",
        images: [{ data: "bG93ZXI=", mimeType: "image/png" }],
        imageCount: 1,
      }),
    });
    await vi.waitFor(() =>
      expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual(
        [
          {
            id: "same-id",
            text: "stable",
            attachments: [{ kind: "image", metadata: originalImage }],
          },
        ],
      ),
    );
    expect(persist).not.toHaveBeenCalled();
    expect(state.revisions).toEqual(new Map([["agent-a", 5]]));

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", 5, ["same-id"], {
        text: "stable",
        images: [{ data: "ZXF1YWw=", mimeType: "image/png" }],
        imageCount: 1,
      }),
    });
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledWith([equalConflictImage]));
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual([
      {
        id: "same-id",
        text: "stable",
        attachments: [{ kind: "image", metadata: originalImage }],
      },
    ]);
    expect(state.revisions).toEqual(new Map([["agent-a", 5]]));

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", 6, ["same-id"], {
        text: "stable",
        images: [{ data: "aGlnaGVy", mimeType: "image/png" }],
        imageCount: 1,
      }),
    });
    await vi.waitFor(() =>
      expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual(
        [
          {
            id: "same-id",
            text: "stable",
            attachments: [{ kind: "image", metadata: acceptedImage }],
          },
        ],
      ),
    );
    expect(state.revisions).toEqual(new Map([["agent-a", 6]]));
    dispose();
  });

  it("cleans staged images after a partial multi-image hydration failure and leaves the live mirror untouched", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const originalImageA = persistedImage("img-original-a");
    const originalImageB = persistedImage("img-original-b");
    const stagedImage = persistedImage("img-staged-first");
    const persist = vi.spyOn(attachmentService, "persistAttachmentFromDataUrl");
    const cleanup = vi.spyOn(attachmentService, "deleteAttachments").mockResolvedValue();
    persist
      .mockResolvedValueOnce(stagedImage)
      .mockRejectedValueOnce(new Error("second image failed"));
    useSessionStore.getState().setQueuedMessages(
      SERVER_ID,
      new Map([
        [
          "agent-a",
          [
            {
              id: "same-id",
              text: "stable",
              attachments: [
                { kind: "image", metadata: originalImageA },
                { kind: "image", metadata: originalImageB },
              ],
            },
          ],
        ],
      ]),
    );
    const state = createAgentMessageQueueSyncState();
    state.revisions.set("agent-a", 5);
    const harness = createClientHarness();
    harness.listQueuedAgentMessages.mockResolvedValueOnce([]);

    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", 6, ["same-id"], {
        text: "stable",
        images: [
          { data: "Zmlyc3Q=", mimeType: "image/png" },
          { data: "c2Vjb25k", mimeType: "image/png" },
        ],
        imageCount: 2,
      }),
    });
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledWith([stagedImage]));
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual([
      {
        id: "same-id",
        text: "stable",
        attachments: [
          { kind: "image", metadata: originalImageA },
          { kind: "image", metadata: originalImageB },
        ],
      },
    ]);
    expect(state.revisions).toEqual(new Map([["agent-a", 5]]));
    dispose();
  });

  it("uses attempt-unique staged ids so old cleanup cannot target newer accepted images for the same tuple", async () => {
    const persist = vi
      .spyOn(attachmentService, "persistAttachmentFromDataUrl")
      .mockImplementation(async ({ id, mimeType }) => {
        return {
          id: id ?? "missing-id",
          storageKey: id ?? "missing-id",
          storageType: "web-indexeddb",
          mimeType: mimeType ?? "image/png",
          fileName: `${id}.png`,
          byteSize: 1,
          createdAt: 1,
        };
      });
    const cleanupGate = deferred<void>();
    let cleanupCalls = 0;
    const cleanup = vi
      .spyOn(attachmentService, "deleteAttachments")
      .mockImplementation(async () => {
        cleanupCalls += 1;
        if (cleanupCalls === 1) {
          await cleanupGate.promise;
        }
      });
    const serverId = "queue-sync-same-server";
    useSessionStore.getState().initializeSession(serverId, null);

    const oldHarness = createClientHarness();
    oldHarness.listQueuedAgentMessages.mockResolvedValueOnce([]).mockResolvedValueOnce([
      queuePayload("agent-a", 5, ["same-id"], {
        text: "same-id",
        images: [{ data: "b2xk", mimeType: "image/png" }],
        imageCount: 1,
        attachments: [reviewAttachment("old conflict")],
        attachmentCount: 1,
      }),
    ]);
    const oldState = createAgentMessageQueueSyncState();
    oldState.revisions.set("agent-a", 5);
    registerAgentMessageQueueSyncState(serverId, oldState);
    registerQueuedAgentMessageIntent({
      serverId,
      agentId: "agent-a",
      message: {
        id: "same-id",
        text: "recovered",
        attachments: [{ kind: "agent_attachment", attachment: reviewAttachment("recovered") }],
      },
    });
    const disposeOld = mountAgentMessageQueueSync({
      client: oldHarness.client,
      serverId,
      state: oldState,
    });
    await vi.waitFor(() => expect(oldHarness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));
    oldHarness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", 5, ["same-id"], {
        imageCount: 1,
        attachmentCount: 1,
      }),
    });
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
    disposeOld();

    const newHarness = createClientHarness();
    newHarness.listQueuedAgentMessages.mockResolvedValueOnce([
      queuePayload("agent-a", 5, ["same-id"], {
        text: "same-id",
        images: [{ data: "bmV3", mimeType: "image/png" }],
        imageCount: 1,
      }),
    ]);
    const newState = createAgentMessageQueueSyncState();
    const disposeNew = mountAgentMessageQueueSync({
      client: newHarness.client,
      serverId,
      state: newState,
    });
    await vi.waitFor(() => expect(newHarness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));

    const ids = persist.mock.calls.map(([input]) => input.id ?? "");
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toMatch(
      /^queued-staged:[^:]+:queue-sync-same-server:agent-a:same-id:rev-5:1:0$/,
    );
    expect(ids[1]).toMatch(
      /^queued-staged:[^:]+:queue-sync-same-server:agent-a:same-id:rev-5:1:0$/,
    );
    expect(cleanup.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ id: ids[0], storageKey: ids[0] }),
    ]);
    expect(
      useSessionStore.getState().sessions[serverId]?.queuedMessages.get("agent-a")?.[0]
        ?.attachments,
    ).toEqual([
      expect.objectContaining({
        kind: "image",
        metadata: expect.objectContaining({ id: ids[1], storageKey: ids[1] }),
      }),
    ]);
    cleanupGate.resolve();

    disposeNew();
    useSessionStore.getState().clearSession(serverId);
  });

  it("cleans staged metadata when a stale hydration attempt is superseded before publish", async () => {
    const stalePersist = deferred<AttachmentMetadata>();
    const acceptedImage = persistedImage("img-accepted");
    const liveImage = persistedImage("img-live");
    const persist = vi
      .spyOn(attachmentService, "persistAttachmentFromDataUrl")
      .mockImplementation(async ({ id, mimeType }) => {
        if (id?.includes(":rev-6:")) {
          return await stalePersist.promise;
        }
        return {
          ...acceptedImage,
          id: id ?? acceptedImage.id,
          storageKey: id ?? acceptedImage.storageKey,
          mimeType: mimeType ?? acceptedImage.mimeType,
          fileName: `${id}.png`,
        };
      });
    const cleanup = vi.spyOn(attachmentService, "deleteAttachments").mockResolvedValue();
    useSessionStore.getState().setQueuedMessages(
      SERVER_ID,
      new Map([
        [
          "agent-a",
          [
            {
              id: "same-id",
              text: "stable",
              attachments: [{ kind: "image", metadata: liveImage }],
            },
          ],
        ],
      ]),
    );
    const state = createAgentMessageQueueSyncState();
    state.revisions.set("agent-a", 5);
    const harness = createClientHarness();
    harness.listQueuedAgentMessages.mockResolvedValueOnce([]);
    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", 6, ["same-id"], {
        text: "stable",
        images: [{ data: "b2xk", mimeType: "image/png" }],
        imageCount: 1,
      }),
    });
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", 7, ["same-id"], {
        text: "stable",
        images: [{ data: "bmV3", mimeType: "image/png" }],
        imageCount: 1,
      }),
    });
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(2));

    const staleId = persist.mock.calls[0]?.[0].id ?? "missing-stale-id";
    stalePersist.resolve({
      id: staleId,
      storageKey: staleId,
      storageType: "web-indexeddb",
      mimeType: "image/png",
      fileName: `${staleId}.png`,
      byteSize: 1,
      createdAt: 1,
    });

    await vi.waitFor(() =>
      expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual(
        [
          {
            id: "same-id",
            text: "stable",
            attachments: [
              {
                kind: "image",
                metadata: expect.objectContaining({
                  id: persist.mock.calls[1]?.[0].id,
                  storageKey: persist.mock.calls[1]?.[0].id,
                }),
              },
            ],
          },
        ],
      ),
    );
    await vi.waitFor(() => expect(state.revisions.get("agent-a")).toBe(7));
    await vi.waitFor(() =>
      expect(cleanup).toHaveBeenCalledWith([
        expect.objectContaining({ id: staleId, storageKey: staleId }),
      ]),
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("cleans staged metadata when the sync is disposed after hydration settles but before publish", async () => {
    const cleanup = vi.spyOn(attachmentService, "deleteAttachments").mockResolvedValue();
    const liveImage = persistedImage("img-live-dispose");
    const state = createAgentMessageQueueSyncState();
    state.revisions.set("agent-a", 5);
    useSessionStore.getState().setQueuedMessages(
      SERVER_ID,
      new Map([
        [
          "agent-a",
          [
            {
              id: "same-id",
              text: "stable",
              attachments: [{ kind: "image", metadata: liveImage }],
            },
          ],
        ],
      ]),
    );
    const harness = createClientHarness();
    harness.listQueuedAgentMessages.mockResolvedValueOnce([]);
    let dispose = () => {};
    const persist = vi
      .spyOn(attachmentService, "persistAttachmentFromDataUrl")
      .mockImplementation(async ({ id, mimeType }) => {
        dispose();
        return {
          id: id ?? "disposed-before-publish",
          storageKey: id ?? "disposed-before-publish",
          storageType: "web-indexeddb",
          mimeType: mimeType ?? "image/png",
          fileName: `${id}.png`,
          byteSize: 1,
          createdAt: 1,
        };
      });

    dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", 6, ["same-id"], {
        text: "stable",
        images: [{ data: "ZGlzcG9zZQ==", mimeType: "image/png" }],
        imageCount: 1,
      }),
    });

    const stagedId = await vi.waitFor(() => persist.mock.calls[0]?.[0].id);
    await vi.waitFor(() =>
      expect(cleanup).toHaveBeenCalledWith([
        expect.objectContaining({ id: stagedId, storageKey: stagedId }),
      ]),
    );
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual([
      { id: "same-id", text: "stable", attachments: [{ kind: "image", metadata: liveImage }] },
    ]);
    expect(state.revisions).toEqual(new Map([["agent-a", 5]]));
  });

  it("cleans staged metadata and blocks enqueue when an agent is archived during hydration", async () => {
    const persistGate = deferred<AttachmentMetadata>();
    const cleanup = vi.spyOn(attachmentService, "deleteAttachments").mockResolvedValue();
    const persist = vi
      .spyOn(attachmentService, "persistAttachmentFromDataUrl")
      .mockImplementation(async () => await persistGate.promise);
    const liveImage = persistedImage("img-live");
    useSessionStore.getState().setQueuedMessages(
      SERVER_ID,
      new Map([
        [
          "agent-a",
          [
            {
              id: "same-id",
              text: "stable",
              attachments: [{ kind: "image", metadata: liveImage }],
            },
          ],
        ],
      ]),
    );
    const state = createAgentMessageQueueSyncState();
    state.revisions.set("agent-a", 5);
    const harness = createClientHarness();
    harness.listQueuedAgentMessages.mockResolvedValueOnce([]);
    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", 6, ["same-id"], {
        text: "stable",
        images: [{ data: "YXJjaGl2ZWQ=", mimeType: "image/png" }],
        imageCount: 1,
      }),
    });
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));

    harness.emit({
      type: "agent_archived",
      payload: {
        agentId: "agent-a",
        archivedAt: "2026-07-23T00:00:00.000Z",
        requestId: "archive-during-hydration",
      },
    });
    const stagedId = persist.mock.calls[0]?.[0].id ?? "missing-archived-id";
    persistGate.resolve({
      id: stagedId,
      storageKey: stagedId,
      storageType: "web-indexeddb",
      mimeType: "image/png",
      fileName: `${stagedId}.png`,
      byteSize: 1,
      createdAt: 1,
    });

    await vi.waitFor(() =>
      expect(cleanup).toHaveBeenCalledWith([
        expect.objectContaining({ id: stagedId, storageKey: stagedId }),
      ]),
    );
    expect(state.inactiveAgentIds.has("agent-a")).toBe(true);
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual([
      {
        id: "same-id",
        text: "stable",
        attachments: [{ kind: "image", metadata: liveImage }],
      },
    ]);
    expect(state.revisions).toEqual(new Map([["agent-a", 5]]));
    expect(
      registerQueuedAgentMessageIntent({
        serverId: SERVER_ID,
        agentId: "agent-a",
        message: localMessage("blocked-archive-hydration"),
      }),
    ).toBeNull();
    expect(
      enqueueRegisteredQueuedAgentMessageIntent({
        serverId: SERVER_ID,
        agentId: "agent-a",
        messageId: "same-id",
      }),
    ).toBeNull();
    expect(harness.queueAgentMessage).not.toHaveBeenCalled();
    dispose();
  });

  it("preserves mirror, revision, unacknowledged intent, and token across failed lower and conflicting-equal hydration before a later successful retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const persist = vi.spyOn(attachmentService, "persistAttachmentFromDataUrl");
    persist
      .mockResolvedValueOnce(persistedImage("img-equal-conflict"))
      .mockResolvedValueOnce(persistedImage("img-final"));
    const recoveredAttachment = reviewAttachment("recovered");
    const recovered = {
      id: "same-id",
      text: "recovered",
      attachments: [{ kind: "agent_attachment" as const, attachment: recoveredAttachment }],
    };
    useSessionStore.getState().setQueuedMessages(SERVER_ID, new Map([["agent-a", [recovered]]]));
    const state = createAgentMessageQueueSyncState();
    state.revisions.set("agent-a", 5);
    registerAgentMessageQueueSyncState(SERVER_ID, state);
    registerQueuedAgentMessageIntent({
      serverId: SERVER_ID,
      agentId: "agent-a",
      message: recovered,
    });
    const token = state.intentVersions.get("agent-a\u0000same-id");
    const harness = createClientHarness();
    harness.queueAgentMessage.mockRejectedValue(new Error("preserve recovered intent"));
    harness.listQueuedAgentMessages
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        queuePayload("agent-a", 4, ["same-id"], {
          text: "stale-lower",
          images: [{ data: "Zm9v", mimeType: "image/png" }],
          imageCount: 1,
        }),
      ])
      .mockResolvedValueOnce([
        queuePayload("agent-a", 5, ["same-id"], {
          text: "stale-equal",
          images: [{ data: "Zm9v", mimeType: "image/png" }],
          imageCount: 1,
          attachments: [reviewAttachment("server-conflict")],
          attachmentCount: 1,
        }),
      ])
      .mockResolvedValueOnce([
        queuePayload("agent-a", 6, ["same-id"], {
          text: "same-id",
          images: [{ data: "Zm9v", mimeType: "image/png" }],
          imageCount: 1,
          attachments: [recoveredAttachment],
          attachmentCount: 1,
        }),
      ]);

    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", 4, ["same-id"], {
        imageCount: 1,
      }),
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(2));
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual([
      recovered,
    ]);
    expect(state.revisions).toEqual(new Map([["agent-a", 5]]));
    expect(state.unacknowledged).toEqual(new Map([["agent-a", [recovered]]]));
    expect(state.intentVersions.get("agent-a\u0000same-id")).toBe(token);
    expect(persist).not.toHaveBeenCalled();

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", 5, ["same-id"], {
        imageCount: 1,
        attachmentCount: 1,
      }),
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(3));
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual([
      recovered,
    ]);
    expect(state.revisions).toEqual(new Map([["agent-a", 5]]));
    expect(state.unacknowledged).toEqual(new Map([["agent-a", [recovered]]]));
    expect(state.intentVersions.get("agent-a\u0000same-id")).toBe(token);
    expect(
      useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")?.[0]
        ?.attachments,
    ).toEqual([{ kind: "agent_attachment", attachment: recoveredAttachment }]);

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", 6, ["same-id"], {
        imageCount: 1,
        attachmentCount: 1,
      }),
    });
    await vi.waitFor(() =>
      expect(
        useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")?.[0]
          ?.attachments,
      ).toEqual([
        { kind: "image", metadata: persistedImage("img-final") },
        { kind: "agent_attachment", attachment: recoveredAttachment },
      ]),
    );
    expect(state.unacknowledged).toEqual(new Map());
    expect(Array.from(state.intentVersions.keys())).toEqual([]);
    dispose();
  });

  it("rejects same-revision stale authoritative attachments even when merged same-id content matches local recovery", async () => {
    const recoveredAttachment = reviewAttachment("recovered");
    const recovered = {
      id: "same-id",
      text: "same text",
      attachments: [{ kind: "agent_attachment" as const, attachment: recoveredAttachment }],
    };
    useSessionStore.getState().setQueuedMessages(SERVER_ID, new Map([["agent-a", [recovered]]]));
    const state = createAgentMessageQueueSyncState();
    state.revisions.set("agent-a", 4);
    registerAgentMessageQueueSyncState(SERVER_ID, state);
    registerQueuedAgentMessageIntent({
      serverId: SERVER_ID,
      agentId: "agent-a",
      message: recovered,
    });
    const token = state.intentVersions.get("agent-a\u0000same-id");
    const harness = createClientHarness();
    harness.queueAgentMessage.mockRejectedValue(new Error("preserve recovered intent"));
    harness.listQueuedAgentMessages
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        queuePayload("agent-a", 4, ["same-id"], {
          text: "same text",
          attachments: [reviewAttachment("stale")],
          attachmentCount: 1,
        }),
      ])
      .mockResolvedValueOnce([
        queuePayload("agent-a", 5, ["same-id"], {
          text: "same text",
          attachments: [recoveredAttachment],
          attachmentCount: 1,
        }),
      ]);

    const dispose = mountAgentMessageQueueSync({
      client: harness.client,
      serverId: SERVER_ID,
      state,
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", 4, ["same-id"], {
        attachmentCount: 1,
      }),
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(2));
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual([
      recovered,
    ]);
    expect(state.unacknowledged).toEqual(new Map([["agent-a", [recovered]]]));
    expect(state.intentVersions.get("agent-a\u0000same-id")).toBe(token);

    harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", 5, ["same-id"], {
        attachmentCount: 1,
      }),
    });
    await vi.waitFor(() => {
      expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual(
        [recovered],
      );
      expect(state.unacknowledged).toEqual(new Map());
      expect(Array.from(state.intentVersions.keys())).toEqual([]);
    });
    dispose();
  });
});
