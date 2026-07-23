import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import {
  AgentAttachmentSchema,
  ImageAttachmentSchema,
  type AgentAttachment,
  type QueuedAgentMessagePayload,
  type QueuedAgentMessageQueuePayload,
} from "./messages.js";
import type { AgentPromptContentBlock, AgentPromptInput } from "./agent/agent-sdk-types.js";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import {
  dispatchPromptWithReplayAdmission,
  resolveReplayAdmissionForPrompt,
} from "./agent-dispatch-orchestration.js";
import { writeJsonFileAtomic } from "./atomic-file.js";

const DRAIN_RETRY_DELAYS_MS = [0, 25, 100, 250, 1000] as const;

const QueuedAgentMessageRecordSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  text: z.string(),
  images: z.array(ImageAttachmentSchema).default([]),
  attachments: z.array(AgentAttachmentSchema).default([]),
  createdAt: z.string(),
  createdByClientId: z.string().nullable().optional(),
});

const PersistedAgentMessageQueueSchema = z
  .object({
    version: z.literal(1).default(1),
    queues: z.record(z.string(), z.array(QueuedAgentMessageRecordSchema)).default({}),
    revisions: z.record(z.string(), z.number().int().nonnegative()).default({}),
  })
  .default({ version: 1, queues: {}, revisions: {} });

export type QueuedAgentMessageRecord = z.infer<typeof QueuedAgentMessageRecordSchema>;

type PersistedAgentMessageQueue = z.infer<typeof PersistedAgentMessageQueueSchema>;

export interface EnqueueAgentMessageInput {
  agentId: string;
  text: string;
  messageId?: string;
  images?: Array<{ data: string; mimeType: string }>;
  attachments?: AgentAttachment[];
  createdByClientId?: string | null;
}

export interface AgentMessageQueueStoreOptions {
  filePath: string;
  logger: Logger;
}

export class AgentMessageQueueStore {
  private cache: PersistedAgentMessageQueue | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: AgentMessageQueueStoreOptions) {}

  async list(agentId?: string): Promise<QueuedAgentMessageRecord[]> {
    await this.mutationQueue;
    const state = await this.load();
    if (agentId) {
      return cloneRecords(state.queues[agentId] ?? []);
    }
    return Object.values(state.queues).flatMap((queue) => cloneRecords(queue));
  }

  async listQueues(agentId?: string): Promise<QueuedAgentMessageQueuePayload[]> {
    await this.mutationQueue;
    const state = await this.load();
    const includeExplicitAgent = agentId !== undefined;
    const agentIds = agentId
      ? [agentId]
      : Array.from(new Set([...Object.keys(state.queues), ...Object.keys(state.revisions)])).sort(
          (left, right) => left.localeCompare(right),
        );
    return agentIds
      .map((id) => toQueuedAgentMessageQueuePayload(state, id))
      .filter(
        (queue) => includeExplicitAgent || queue.messages.length > 0 || (queue.revision ?? 0) > 0,
      );
  }

  async enqueue(
    input: EnqueueAgentMessageInput,
    options?: { ensureEligible?: () => Promise<void> },
  ): Promise<QueuedAgentMessageRecord> {
    const text = input.text.trim();
    if (!text && (input.images?.length ?? 0) === 0 && (input.attachments?.length ?? 0) === 0) {
      throw new Error("Queued message is empty");
    }

    return await this.mutate(async (state) => {
      // Runs inside the serialized mutation so an archive/delete cleanup that
      // was ordered ahead of this enqueue cannot be outrun by it.
      await options?.ensureEligible?.();
      if (input.messageId) {
        const existing = (state.queues[input.agentId] ?? []).find(
          (record) => record.id === input.messageId,
        );
        if (existing) {
          return cloneRecord(existing);
        }
      }
      const record: QueuedAgentMessageRecord = {
        id: input.messageId ?? randomUUID(),
        agentId: input.agentId,
        text,
        images: input.images ?? [],
        attachments: input.attachments ?? [],
        createdAt: new Date().toISOString(),
        createdByClientId: input.createdByClientId ?? null,
      };
      state.queues[input.agentId] = [...(state.queues[input.agentId] ?? []), record];
      bumpQueueRevision(state, input.agentId);
      return cloneRecord(record);
    });
  }

  async remove(agentId: string, queuedMessageId: string): Promise<QueuedAgentMessageRecord | null> {
    return await this.mutate(async (state) => {
      const queue = state.queues[agentId] ?? [];
      const index = queue.findIndex((record) => record.id === queuedMessageId);
      if (index === -1) {
        return null;
      }
      const [removed] = queue.splice(index, 1);
      setQueue(state, agentId, queue);
      bumpQueueRevision(state, agentId);
      return removed ? cloneRecord(removed) : null;
    });
  }

  async get(agentId: string, queuedMessageId: string): Promise<QueuedAgentMessageRecord | null> {
    await this.mutationQueue;
    const state = await this.load();
    const record = (state.queues[agentId] ?? []).find((item) => item.id === queuedMessageId);
    return record ? cloneRecord(record) : null;
  }

  async peek(agentId: string): Promise<QueuedAgentMessageRecord | null> {
    await this.mutationQueue;
    const state = await this.load();
    const record = state.queues[agentId]?.[0] ?? null;
    return record ? cloneRecord(record) : null;
  }

  async shift(agentId: string): Promise<QueuedAgentMessageRecord | null> {
    return await this.mutate(async (state) => {
      const queue = state.queues[agentId] ?? [];
      const removed = queue.shift() ?? null;
      setQueue(state, agentId, queue);
      if (removed) {
        bumpQueueRevision(state, agentId);
      }
      return removed ? cloneRecord(removed) : null;
    });
  }

  async unshift(record: QueuedAgentMessageRecord): Promise<void> {
    await this.mutate(async (state) => {
      state.queues[record.agentId] = [cloneRecord(record), ...(state.queues[record.agentId] ?? [])];
      bumpQueueRevision(state, record.agentId);
    });
  }

  async clearAgent(
    agentId: string,
    options?: { dropRevision?: boolean },
  ): Promise<QueuedAgentMessageQueuePayload | null> {
    return await this.mutate(async (state) => {
      const hadQueue = (state.queues[agentId]?.length ?? 0) > 0;
      const hadRevision = state.revisions[agentId] !== undefined;
      if (!hadQueue && (!options?.dropRevision || !hadRevision)) {
        return null;
      }
      const revision = getQueueRevision(state, agentId) + 1;
      delete state.queues[agentId];
      if (options?.dropRevision) {
        delete state.revisions[agentId];
      } else {
        state.revisions[agentId] = revision;
      }
      return { agentId, revision, messages: [] };
    });
  }

  private async mutate<T>(
    operation: (state: PersistedAgentMessageQueue) => Promise<T> | T,
  ): Promise<T> {
    const task = this.mutationQueue.then(async () => {
      // Mutate a draft and commit it to the cache only after the write
      // succeeds, so a failed persist cannot leave the in-memory state
      // claiming a change that was never durably stored.
      const draft = structuredClone(await this.load());
      const result = await operation(draft);
      await this.persist(draft);
      this.cache = draft;
      return result;
    });
    this.mutationQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return await task;
  }

  private async load(): Promise<PersistedAgentMessageQueue> {
    if (this.cache) {
      return this.cache;
    }
    try {
      const raw = await readFile(this.options.filePath, "utf8");
      this.cache = PersistedAgentMessageQueueSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = { version: 1, queues: {}, revisions: {} };
      } else {
        this.options.logger.error({ err: error }, "Failed to load agent message queue");
        throw error;
      }
    }
    return this.cache;
  }

  private async persist(state: PersistedAgentMessageQueue): Promise<void> {
    pruneEmptyQueues(state);
    await writeJsonFileAtomic(this.options.filePath, state);
  }
}

export interface AgentMessageQueueServiceOptions {
  store: AgentMessageQueueStore;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  onQueueUpdated: (queue: QueuedAgentMessageQueuePayload) => void;
}

export interface AgentMessageQueueController {
  enqueue(input: EnqueueAgentMessageInput): Promise<QueuedAgentMessagePayload>;
  list(agentId?: string): Promise<QueuedAgentMessageQueuePayload[]>;
  cancel(agentId: string, queuedMessageId: string): Promise<boolean>;
  dispatchNow(agentId: string, queuedMessageId: string): Promise<void>;
  clearAgent(agentId: string, options?: { dropRevision?: boolean }): Promise<void>;
}

export class AgentMessageQueueService implements AgentMessageQueueController {
  private unsubscribeAgentEvents: (() => void) | null = null;
  private unsubscribeAgentArchived: (() => void) | null = null;
  private readonly scheduledDrainTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly drainSendFailures = new Map<string, number>();
  private readonly queueOperationTails = new Map<string, Promise<void>>();

  constructor(private readonly options: AgentMessageQueueServiceOptions) {}

  start(): void {
    if (this.unsubscribeAgentEvents) {
      return;
    }
    this.unsubscribeAgentEvents = this.options.agentManager.subscribe(
      (event) => {
        if (event.type !== "agent_state") {
          return;
        }
        if (event.agent.lifecycle !== "closed") {
          this.scheduleDrainAgentQueue(event.agent.id);
        }
      },
      { replayState: false },
    );
    this.unsubscribeAgentArchived = this.options.agentManager.addAgentArchivedCallback(
      async (agentId) => {
        await this.clearAgent(agentId);
      },
    );
    void this.schedulePersistedQueuesForDrain().catch((error) => {
      this.options.logger.error(
        { err: error },
        "Failed to schedule persisted agent message queues",
      );
    });
  }

  stop(): void {
    this.unsubscribeAgentEvents?.();
    this.unsubscribeAgentEvents = null;
    this.unsubscribeAgentArchived?.();
    this.unsubscribeAgentArchived = null;
    for (const timeout of this.scheduledDrainTimers.values()) {
      clearTimeout(timeout);
    }
    this.scheduledDrainTimers.clear();
    this.drainSendFailures.clear();
  }

  async enqueue(input: EnqueueAgentMessageInput): Promise<QueuedAgentMessagePayload> {
    const record = await this.options.store.enqueue(input, {
      ensureEligible: async () => {
        const reason = await this.getQueueUnavailableReason(input.agentId);
        if (reason) {
          throw new Error(reason);
        }
      },
    });
    this.drainSendFailures.delete(input.agentId);
    await this.emitQueueUpdated(input.agentId);
    this.scheduleDrainAgentQueue(input.agentId);
    return toQueuedAgentMessagePayload(record);
  }

  async getQueueUnavailableReason(agentId: string): Promise<string | null> {
    const live = this.options.agentManager.getAgent(agentId);
    if (live?.internal) {
      return `Cannot queue message for internal agent: ${agentId}`;
    }
    if (live?.lifecycle === "closed") {
      return `Cannot queue message for closed agent: ${agentId}`;
    }

    const stored = await this.options.agentStorage.get(agentId);
    if (!live && !stored) {
      return `Agent not found: ${agentId}`;
    }
    if (stored?.internal) {
      return `Cannot queue message for internal agent: ${agentId}`;
    }
    if (stored?.archivedAt) {
      return `Cannot queue message for archived agent: ${agentId}`;
    }

    return null;
  }

  async list(agentId?: string): Promise<QueuedAgentMessageQueuePayload[]> {
    return await this.options.store.listQueues(agentId);
  }

  async cancel(agentId: string, queuedMessageId: string): Promise<boolean> {
    return await this.runWithQueueOwnership(agentId, async () => {
      const removed = await this.options.store.remove(agentId, queuedMessageId);
      if (removed) {
        await this.emitQueueUpdated(agentId);
      }
      return Boolean(removed);
    });
  }

  async dispatchNow(agentId: string, queuedMessageId: string): Promise<void> {
    await this.runWithQueueOwnership(agentId, async () => {
      const record = await this.options.store.get(agentId, queuedMessageId);
      if (!record) {
        throw new Error(`Queued message not found: ${queuedMessageId}`);
      }
      const outcome = await this.dispatchQueuedRecord(record, { replaceRunning: true });
      switch (outcome.kind) {
        case "started":
        case "duplicate":
          return;
        case "definitive_failure":
          if (!(await this.canAgentEverReplay(agentId))) {
            await this.finalizeDequeuedMessage(agentId, record.id);
          }
          throw new Error(outcome.error);
        case "unknown":
          throw new Error(outcome.error);
      }
    });
  }

  async clearAgent(agentId: string, options?: { dropRevision?: boolean }): Promise<void> {
    await this.runWithQueueOwnership(agentId, async () => {
      const scheduled = this.scheduledDrainTimers.get(agentId);
      if (scheduled) {
        clearTimeout(scheduled);
        this.scheduledDrainTimers.delete(agentId);
      }
      this.drainSendFailures.delete(agentId);
      const clearedQueue = await this.options.store.clearAgent(agentId, options);
      if (clearedQueue) {
        this.options.onQueueUpdated(clearedQueue);
      }
    });
  }

  private scheduleDrainAgentQueue(agentId: string, attempt = 0): void {
    if (this.scheduledDrainTimers.has(agentId)) {
      return;
    }

    const delayMs = DRAIN_RETRY_DELAYS_MS[Math.min(attempt, DRAIN_RETRY_DELAYS_MS.length - 1)] ?? 0;
    const timeout = setTimeout(() => {
      this.scheduledDrainTimers.delete(agentId);
      void this.runScheduledDrain(agentId, attempt).catch((error) => {
        this.options.logger.error({ err: error, agentId }, "Failed to drain queued agent messages");
      });
    }, delayMs);
    this.scheduledDrainTimers.set(agentId, timeout);
  }

  private async runScheduledDrain(agentId: string, attempt: number): Promise<void> {
    if (await this.isAgentAvailableForAutoReplay(agentId)) {
      if (await this.hasQueuedMessages(agentId)) {
        await this.drainAgentQueue(agentId);
      }
      return;
    }
    if (attempt + 1 < DRAIN_RETRY_DELAYS_MS.length && (await this.canAgentEverReplay(agentId))) {
      this.scheduleDrainAgentQueue(agentId, attempt + 1);
    }
  }

  private async schedulePersistedQueuesForDrain(): Promise<void> {
    const queues = await this.options.store.listQueues();
    for (const queue of queues) {
      if (queue.messages.length > 0) {
        this.scheduleDrainAgentQueue(queue.agentId);
      }
    }
  }

  private async hasQueuedMessages(agentId: string): Promise<boolean> {
    return (await this.options.store.list(agentId)).length > 0;
  }

  private async drainAgentQueue(agentId: string): Promise<void> {
    let retryAfterFailure = false;
    await this.runWithQueueOwnership(agentId, async () => {
      while (await this.isAgentAvailableForAutoReplay(agentId)) {
        const record = await this.options.store.peek(agentId);
        if (!record) {
          return;
        }
        const outcome = await this.dispatchQueuedRecord(record, { replaceRunning: false });
        if (outcome.kind === "started" || outcome.kind === "duplicate") {
          continue;
        }
        if (outcome.kind === "definitive_failure" && !(await this.canAgentEverReplay(agentId))) {
          await this.finalizeDequeuedMessage(agentId, record.id);
        } else {
          retryAfterFailure = true;
        }
        this.options.logger.warn(
          { agentId, queuedMessageId: record.id, error: outcome.error },
          "Failed to dispatch queued agent message",
        );
        return;
      }
    });
    if (retryAfterFailure) {
      const attempt = (this.drainSendFailures.get(agentId) ?? 0) + 1;
      this.drainSendFailures.set(agentId, attempt);
      if (attempt < DRAIN_RETRY_DELAYS_MS.length) {
        this.scheduleDrainAgentQueue(agentId, attempt);
      } else {
        this.options.logger.warn(
          { agentId },
          "Suspending queued message replay until the next agent event",
        );
      }
    }
  }

  private async isAgentAvailableForAutoReplay(agentId: string): Promise<boolean> {
    if (!(await this.canAgentEverReplay(agentId))) {
      return false;
    }
    return !this.options.agentManager.hasInFlightRun(agentId);
  }

  private async canAgentEverReplay(agentId: string): Promise<boolean> {
    return (await this.getQueueUnavailableReason(agentId)) === null;
  }

  private async dispatchQueuedRecord(
    record: QueuedAgentMessageRecord,
    options?: { replaceRunning?: boolean },
  ) {
    const prompt = buildQueuedAgentPrompt(record.text, record.images, record.attachments);
    const replayResolution = await resolveReplayAdmissionForPrompt({
      agentManager: this.options.agentManager,
      agentStorage: this.options.agentStorage,
      agentId: record.agentId,
      prompt,
      messageId: record.id,
      logger: this.options.logger,
    });
    if (!replayResolution.admission) {
      if (
        replayResolution.kind === "duplicate" ||
        (replayResolution.kind === "in_flight" && replayResolution.accepted)
      ) {
        await this.finalizeDequeuedMessage(record.agentId, record.id);
        this.drainSendFailures.delete(record.agentId);
        return { kind: "duplicate" as const };
      }
      return {
        kind: "unknown" as const,
        error: replayResolution.error ?? "Queued message delivery outcome is unknown",
      };
    }
    const dispatchResult = await dispatchPromptWithReplayAdmission({
      agentManager: this.options.agentManager,
      agentStorage: this.options.agentStorage,
      agentId: record.agentId,
      prompt,
      replayAdmission: replayResolution.admission,
      logger: this.options.logger,
      replaceRunning: options?.replaceRunning,
      unarchive: false,
    });
    if (dispatchResult.kind === "started") {
      await this.finalizeDequeuedMessage(record.agentId, record.id);
      this.drainSendFailures.delete(record.agentId);
    }
    return dispatchResult;
  }

  private async runWithQueueOwnership<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queueOperationTails.get(agentId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.catch(() => undefined).then(async () => await current);
    this.queueOperationTails.set(agentId, tail);
    try {
      await previous.catch(() => undefined);
      return await work();
    } finally {
      releaseCurrent();
      if (this.queueOperationTails.get(agentId) === tail) {
        this.queueOperationTails.delete(agentId);
      }
    }
  }

  private async finalizeDequeuedMessage(agentId: string, queuedMessageId: string): Promise<void> {
    const removed = await this.options.store.remove(agentId, queuedMessageId);
    if (removed) {
      await this.emitQueueUpdated(agentId);
    }
  }

  private async emitQueueUpdated(agentId: string): Promise<void> {
    const [queue] = await this.options.store.listQueues(agentId);
    const payload = queue ?? { agentId, revision: 0, messages: [] };
    // Updates fan out to every capable client on every queue change, so omit
    // image bytes from the broadcast. imageCount stays accurate; clients
    // hydrate unseen image messages via queue.agent_message.list. listQueues
    // returns cloned records, so mutating them here is safe.
    for (const message of payload.messages) {
      message.images = [];
    }
    this.options.onQueueUpdated(payload);
  }
}

export function createAgentMessageQueueService(input: {
  paseoHome: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  onQueueUpdated: (queue: QueuedAgentMessageQueuePayload) => void;
}): AgentMessageQueueService {
  return new AgentMessageQueueService({
    store: new AgentMessageQueueStore({
      filePath: join(input.paseoHome, "agent-message-queue.json"),
      logger: input.logger,
    }),
    agentManager: input.agentManager,
    agentStorage: input.agentStorage,
    logger: input.logger,
    onQueueUpdated: input.onQueueUpdated,
  });
}

export function toQueuedAgentMessagePayload(
  record: QueuedAgentMessageRecord,
): QueuedAgentMessagePayload {
  return {
    id: record.id,
    agentId: record.agentId,
    text: record.text,
    createdAt: record.createdAt,
    images: record.images.map((image) => ({ ...image })),
    attachments: record.attachments.map((attachment) => ({ ...attachment })),
    imageCount: record.images.length,
    attachmentCount: record.attachments.length,
  };
}

function toQueuedAgentMessageQueuePayload(
  state: PersistedAgentMessageQueue,
  agentId: string,
): QueuedAgentMessageQueuePayload {
  return {
    agentId,
    revision: getQueueRevision(state, agentId),
    messages: (state.queues[agentId] ?? []).map(toQueuedAgentMessagePayload),
  };
}

export function buildQueuedAgentPrompt(
  text: string,
  images: Array<{ data: string; mimeType: string }>,
  attachments: AgentAttachment[],
): AgentPromptInput {
  const normalized = text.trim();
  if (images.length === 0 && attachments.length === 0) {
    return normalized;
  }
  const blocks: AgentPromptContentBlock[] = [];
  if (normalized.length > 0) {
    blocks.push({ type: "text", text: normalized });
  }
  for (const image of images) {
    blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  for (const attachment of attachments) {
    blocks.push(attachment);
  }
  return blocks;
}

function setQueue(
  state: PersistedAgentMessageQueue,
  agentId: string,
  queue: QueuedAgentMessageRecord[],
): void {
  if (queue.length === 0) {
    delete state.queues[agentId];
    return;
  }
  state.queues[agentId] = queue;
}

function pruneEmptyQueues(state: PersistedAgentMessageQueue): void {
  for (const [agentId, queue] of Object.entries(state.queues)) {
    if (queue.length === 0) {
      delete state.queues[agentId];
    }
  }
}

function getQueueRevision(state: PersistedAgentMessageQueue, agentId: string): number {
  return state.revisions[agentId] ?? 0;
}

function bumpQueueRevision(state: PersistedAgentMessageQueue, agentId: string): void {
  state.revisions[agentId] = getQueueRevision(state, agentId) + 1;
}

function cloneRecords(records: readonly QueuedAgentMessageRecord[]): QueuedAgentMessageRecord[] {
  return records.map(cloneRecord);
}

function cloneRecord(record: QueuedAgentMessageRecord): QueuedAgentMessageRecord {
  return {
    ...record,
    images: record.images.map((image) => ({ ...image })),
    attachments: record.attachments.map((attachment) => ({ ...attachment })),
  };
}
