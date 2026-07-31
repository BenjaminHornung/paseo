import { describe, expect, it } from "vitest";

import {
  applyQueuedComposerQueueMirrors,
  migrateQueuedComposerMessages,
  pruneQueuedComposerQueueMirrorsToAgentIds,
  registerQueuedComposerUnacknowledgedMessage,
  removeQueuedComposerUnacknowledgedMessage,
  removeQueuedComposerQueueMirrorForAgent,
  type QueuedComposerMessageMirror,
} from "./queued-message-queues";

function message(id: string, text = id): QueuedComposerMessageMirror {
  return { id, text, attachments: [] };
}

function messageWithAttachment(
  id: string,
  text: string,
  attachmentId: string,
): QueuedComposerMessageMirror {
  return {
    id,
    text,
    attachments: [
      {
        kind: "agent_attachment",
        attachment: {
          type: "text",
          text: attachmentId,
          mimeType: "text/plain",
        },
      },
    ],
  };
}

describe("applyQueuedComposerQueueMirrors", () => {
  it("preserves locally queued messages that were not durably acknowledged", () => {
    const local = message("local-failed");
    const previous = new Map([["agent-a", [local]]]);
    const revisions = new Map<string, number>();

    const result = applyQueuedComposerQueueMirrors({
      previous,
      revisions,
      queues: [],
      replaceAll: true,
      unacknowledged: new Map([["agent-a", [local]]]),
    });

    expect(result.get("agent-a")).toEqual([local]);
  });

  it("combines unacknowledged local messages with a newer server revision", () => {
    const local = message("local-failed");
    const server = message("server-acknowledged");
    const unacknowledged = new Map([["agent-a", [local]]]);

    const result = applyQueuedComposerQueueMirrors({
      previous: new Map([["agent-a", [local]]]),
      revisions: new Map([["agent-a", 0]]),
      queues: [{ agentId: "agent-a", revision: 4, messages: [server] }],
      replaceAll: true,
      unacknowledged,
    });

    expect(result.get("agent-a")).toEqual([server, local]);
    expect(unacknowledged).toEqual(new Map([["agent-a", [local]]]));
  });

  it("removes acknowledged ids from the retry set when authoritative state contains them", () => {
    const local = message("local-failed");
    const unacknowledged = new Map([["agent-a", [local]]]);

    const result = applyQueuedComposerQueueMirrors({
      previous: new Map([["agent-a", [local]]]),
      revisions: new Map([["agent-a", 0]]),
      queues: [{ agentId: "agent-a", revision: 4, messages: [message("local-failed")] }],
      replaceAll: true,
      unacknowledged,
    });

    expect(result.get("agent-a")).toEqual([message("local-failed")]);
    expect(unacknowledged).toEqual(new Map());
  });

  it("ignores stale per-agent updates", () => {
    const current = message("current");
    const previous = new Map([["agent-a", [current]]]);
    const revisions = new Map([["agent-a", 2]]);
    const unacknowledged = new Map([["agent-a", [message("current", "recovered")]]]);

    const result = applyQueuedComposerQueueMirrors({
      previous,
      revisions,
      unacknowledged,
      queues: [{ agentId: "agent-a", revision: 1, messages: [message("stale")] }],
    });

    expect(result).toBe(previous);
    expect(result.get("agent-a")).toEqual([current]);
    expect(revisions.get("agent-a")).toBe(2);
    expect(unacknowledged).toEqual(new Map([["agent-a", [message("current", "recovered")]]]));
  });

  it("applies an empty queue when its revision is current", () => {
    const previous = new Map([["agent-a", [message("queued")]]]);
    const revisions = new Map([["agent-a", 1]]);

    const result = applyQueuedComposerQueueMirrors({
      previous,
      revisions,
      queues: [{ agentId: "agent-a", revision: 2, messages: [] }],
    });

    expect(result.has("agent-a")).toBe(false);
    expect(revisions.get("agent-a")).toBe(2);
  });

  it("keeps revisioned queues that are missing from a stale replace-all snapshot", () => {
    const queued = message("queued");
    const previous = new Map([["agent-a", [queued]]]);
    const revisions = new Map([["agent-a", 1]]);

    const result = applyQueuedComposerQueueMirrors({
      previous,
      revisions,
      queues: [],
      replaceAll: true,
    });

    expect(result).toBe(previous);
    expect(result.get("agent-a")).toEqual([queued]);
  });

  it("clears legacy no-revision queues that are missing from a replace-all snapshot", () => {
    const previous = new Map([["agent-a", [message("legacy")]]]);
    const revisions = new Map([["agent-a", null]]);

    const result = applyQueuedComposerQueueMirrors({
      previous,
      revisions,
      queues: [],
      replaceAll: true,
    });

    expect(result.has("agent-a")).toBe(false);
  });

  it("accepts same-revision snapshots for idempotent resync", () => {
    const current = message("current");
    const previous = new Map([["agent-a", [current]]]);
    const revisions = new Map([["agent-a", 3]]);

    const result = applyQueuedComposerQueueMirrors({
      previous,
      revisions,
      queues: [{ agentId: "agent-a", revision: 3, messages: [message("new")] }],
    });

    expect(result).toBe(previous);
    expect(result.get("agent-a")).toEqual([current]);
    expect(revisions.get("agent-a")).toBe(3);
  });

  it("keeps same-id recovered intent when a conflicting equal revision snapshot is rejected", () => {
    const current = message("current");
    const recovered = message("same-id", "recovered");
    const previous = new Map([["agent-a", [current, recovered]]]);
    const revisions = new Map([["agent-a", 3]]);
    const unacknowledged = new Map([["agent-a", [recovered]]]);

    const result = applyQueuedComposerQueueMirrors({
      previous,
      revisions,
      unacknowledged,
      queues: [{ agentId: "agent-a", revision: 3, messages: [message("same-id", "stale")] }],
    });

    expect(result).toBe(previous);
    expect(unacknowledged).toEqual(new Map([["agent-a", [recovered]]]));
    expect(revisions.get("agent-a")).toBe(3);
  });

  it("keeps a newer known revision when a legacy snapshot arrives later", () => {
    const current = message("current");
    const previous = new Map([["agent-a", [current]]]);
    const revisions = new Map([["agent-a", 4]]);

    const result = applyQueuedComposerQueueMirrors({
      previous,
      revisions,
      queues: [{ agentId: "agent-a", messages: [message("legacy-stale")] }],
    });

    expect(result).toBe(previous);
    expect(result.get("agent-a")).toEqual([current]);
    expect(revisions.get("agent-a")).toBe(4);
  });

  it("rejects conflicting equal-revision same-id attachment payloads using authoritative content and clears only on later authoritative inclusion", () => {
    const recovered = messageWithAttachment("same-id", "same text", "recovered");
    const stale = messageWithAttachment("same-id", "same text", "stale");
    const previous = new Map([["agent-a", [recovered]]]);
    const revisions = new Map([["agent-a", 4]]);
    const unacknowledged = new Map([["agent-a", [recovered]]]);

    const conflictingEqual = applyQueuedComposerQueueMirrors({
      previous,
      revisions,
      unacknowledged,
      queues: [
        {
          agentId: "agent-a",
          revision: 4,
          messages: [recovered],
          authoritativeMessages: [stale],
        },
      ],
    });

    expect(conflictingEqual).toBe(previous);
    expect(unacknowledged).toEqual(new Map([["agent-a", [recovered]]]));
    expect(revisions.get("agent-a")).toBe(4);

    const acceptedLater = applyQueuedComposerQueueMirrors({
      previous,
      revisions,
      unacknowledged,
      queues: [
        {
          agentId: "agent-a",
          revision: 5,
          messages: [recovered],
          authoritativeMessages: [recovered],
        },
      ],
    });

    expect(acceptedLater.get("agent-a")).toEqual([recovered]);
    expect(unacknowledged).toEqual(new Map());
    expect(revisions.get("agent-a")).toBe(5);
  });

  it("preserves recovered same-id local state across rejected stale and conflicting snapshots until later omission", () => {
    const recovered = message("same-id", "recovered");
    const previous = new Map([["agent-a", [recovered]]]);
    const revisions = new Map([["agent-a", 4]]);
    const unacknowledged = new Map([["agent-a", [recovered]]]);

    const staleResult = applyQueuedComposerQueueMirrors({
      previous,
      revisions,
      unacknowledged,
      queues: [{ agentId: "agent-a", revision: 3, messages: [message("same-id", "stale")] }],
    });
    expect(staleResult).toBe(previous);
    expect(unacknowledged).toEqual(new Map([["agent-a", [recovered]]]));

    const conflictingEqual = applyQueuedComposerQueueMirrors({
      previous,
      revisions,
      unacknowledged,
      queues: [{ agentId: "agent-a", revision: 4, messages: [message("same-id", "conflict")] }],
    });
    expect(conflictingEqual).toBe(previous);
    expect(unacknowledged).toEqual(new Map([["agent-a", [recovered]]]));

    const laterHigherOmission = applyQueuedComposerQueueMirrors({
      previous,
      revisions,
      unacknowledged,
      queues: [{ agentId: "agent-a", revision: 5, messages: [] }],
    });
    expect(laterHigherOmission.get("agent-a")).toEqual([recovered]);
    expect(unacknowledged).toEqual(new Map([["agent-a", [recovered]]]));
  });
});

describe("migrateQueuedComposerMessages", () => {
  it("keeps only the message whose migration fails", async () => {
    const first = message("first");
    const second = message("second");
    const enqueued: string[] = [];

    const unacknowledged = await migrateQueuedComposerMessages({
      local: new Map([["agent-a", [first, second]]]),
      revisions: new Map([["agent-a", null]]),
      unacknowledged: new Map(),
      enqueue: async (_agentId, queued) => {
        if (queued.id === "second") {
          throw new Error("encoding failed");
        }
        enqueued.push(queued.id);
      },
    });

    expect(enqueued).toEqual(["first"]);
    expect(unacknowledged).toEqual(new Map([["agent-a", [second]]]));
  });

  it("preserves every message when migration completely fails", async () => {
    const first = message("first");
    const second = message("second");

    const unacknowledged = await migrateQueuedComposerMessages({
      local: new Map([["agent-a", [first, second]]]),
      revisions: new Map(),
      unacknowledged: new Map(),
      enqueue: async () => {
        throw new Error("daemon unavailable");
      },
    });

    expect(unacknowledged).toEqual(new Map([["agent-a", [first, second]]]));
  });

  it("retries only unacknowledged message ids after reconnect", async () => {
    const first = message("first");
    const second = message("second");
    const firstAttempt = await migrateQueuedComposerMessages({
      local: new Map([["agent-a", [first, second]]]),
      revisions: new Map(),
      unacknowledged: new Map(),
      enqueue: async (_agentId, queued) => {
        if (queued.id === "second") {
          throw new Error("temporary failure");
        }
      },
    });
    const retried: string[] = [];

    const secondAttempt = await migrateQueuedComposerMessages({
      local: new Map([["agent-a", [first, second]]]),
      revisions: new Map([["agent-a", 7]]),
      unacknowledged: firstAttempt,
      enqueue: async (_agentId, queued) => {
        retried.push(queued.id);
      },
    });

    expect(retried).toEqual(["second"]);
    expect(secondAttempt).toEqual(new Map());
  });

  it("does not migrate acknowledged server mirrors on reconnect", async () => {
    const enqueued: string[] = [];

    const unacknowledged = await migrateQueuedComposerMessages({
      local: new Map([["agent-a", [message("server-owned")]]]),
      revisions: new Map([["agent-a", 3]]),
      unacknowledged: new Map(),
      enqueue: async (_agentId, queued) => {
        enqueued.push(queued.id);
      },
    });

    expect(enqueued).toEqual([]);
    expect(unacknowledged).toEqual(new Map());
  });

  it("keeps successful migration idempotent by message id across reconnects", async () => {
    const local = new Map([["agent-a", [message("stable-message-id")]]]);
    const durableQueue = new Map<string, QueuedComposerMessageMirror>();
    const enqueue = async (_agentId: string, queued: QueuedComposerMessageMirror) => {
      durableQueue.set(queued.id, queued);
    };

    await migrateQueuedComposerMessages({
      local,
      revisions: new Map(),
      unacknowledged: new Map(),
      enqueue,
    });
    await migrateQueuedComposerMessages({
      local,
      revisions: new Map(),
      unacknowledged: new Map(),
      enqueue,
    });

    expect(Array.from(durableQueue.values())).toEqual([message("stable-message-id")]);
  });
});

describe("pruneQueuedComposerQueueMirrorsToAgentIds", () => {
  it("retains pending local queues for agents temporarily missing from the active directory", () => {
    const previous = new Map([
      ["agent-active", [message("keep")]],
      ["agent-archived-while-disconnected", [message("drop")]],
    ]);
    const revisions = new Map([
      ["agent-active", 2],
      ["agent-archived-while-disconnected", 4],
      ["agent-deleted-while-disconnected", 3],
    ]);
    const unacknowledged = new Map([
      ["agent-active", [message("keep-pending")]],
      ["agent-archived-while-disconnected", [message("drop-pending")]],
      ["agent-deleted-while-disconnected", [message("drop-pending-too")]],
    ]);

    const result = pruneQueuedComposerQueueMirrorsToAgentIds({
      previous,
      revisions,
      unacknowledged,
      agentIds: ["agent-active"],
    });

    expect(result.get("agent-active")).toEqual([message("keep")]);
    expect(result.get("agent-archived-while-disconnected")).toEqual([message("drop")]);
    expect(revisions).toEqual(
      new Map([
        ["agent-active", 2],
        ["agent-archived-while-disconnected", 4],
        ["agent-deleted-while-disconnected", 3],
      ]),
    );
    expect(unacknowledged).toEqual(
      new Map([
        ["agent-active", [message("keep-pending")]],
        ["agent-archived-while-disconnected", [message("drop-pending")]],
        ["agent-deleted-while-disconnected", [message("drop-pending-too")]],
      ]),
    );
  });

  it("preserves identity when every queued mirror still belongs to an active agent", () => {
    const previous = new Map([["agent-active", [message("keep")]]]);
    const revisions = new Map([["agent-active", 2]]);
    const unacknowledged = new Map([["agent-active", [message("keep-pending")]]]);

    const result = pruneQueuedComposerQueueMirrorsToAgentIds({
      previous,
      revisions,
      unacknowledged,
      agentIds: ["agent-active"],
    });

    expect(result).toBe(previous);
    expect(revisions).toEqual(new Map([["agent-active", 2]]));
    expect(unacknowledged).toEqual(new Map([["agent-active", [message("keep-pending")]]]));
  });
});

describe("removeQueuedComposerQueueMirrorForAgent", () => {
  it("clears every queue state for an archived or deleted agent", () => {
    const previous = new Map([
      ["agent-remove", [message("remove")]],
      ["agent-keep", [message("keep")]],
    ]);
    const revisions = new Map([
      ["agent-remove", 2],
      ["agent-keep", 3],
    ]);
    const unacknowledged = new Map([
      ["agent-remove", [message("pending-remove")]],
      ["agent-keep", [message("pending-keep")]],
    ]);

    const result = removeQueuedComposerQueueMirrorForAgent({
      previous,
      revisions,
      unacknowledged,
      agentId: "agent-remove",
    });

    expect(result).toEqual(new Map([["agent-keep", [message("keep")]]]));
    expect(revisions).toEqual(new Map([["agent-keep", 3]]));
    expect(unacknowledged).toEqual(new Map([["agent-keep", [message("pending-keep")]]]));
  });
});

describe("queued unacknowledged helpers", () => {
  it("replaces a stable message id in place when it is re-registered", () => {
    const unacknowledged = new Map<string, readonly QueuedComposerMessageMirror[]>();

    registerQueuedComposerUnacknowledgedMessage({
      unacknowledged,
      agentId: "agent-a",
      message: message("stable-id"),
    });
    registerQueuedComposerUnacknowledgedMessage({
      unacknowledged,
      agentId: "agent-a",
      message: message("stable-id", "updated text"),
    });

    expect(unacknowledged).toEqual(new Map([["agent-a", [message("stable-id", "updated text")]]]));
  });

  it("removes only the terminal stable message id", () => {
    const unacknowledged = new Map([["agent-a", [message("first"), message("second")]]]);

    removeQueuedComposerUnacknowledgedMessage({
      unacknowledged,
      agentId: "agent-a",
      messageId: "first",
    });

    expect(unacknowledged).toEqual(new Map([["agent-a", [message("second")]]]));
  });
});
