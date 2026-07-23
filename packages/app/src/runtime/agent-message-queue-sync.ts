import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { QueuedAgentMessageQueuePayload } from "@getpaseo/protocol/messages";
import equal from "fast-deep-equal";
import * as attachmentService from "@/attachments/service";
import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";
import {
  resolveComposerAttachmentSubmitFormat,
  splitComposerAttachmentsForSubmit,
} from "@/composer/attachments/submit";
import {
  applyQueuedComposerQueueMirrors,
  collectQueuedComposerMigrationCandidates,
  migrateQueuedComposerMessages,
  registerQueuedComposerUnacknowledgedMessage,
  removeQueuedComposerQueueMirrorForAgent,
  removeQueuedComposerUnacknowledgedMessage,
  resolveQueuedComposerQueueCandidate,
  type QueuedComposerMessageMirror,
  type QueuedComposerQueueMirror,
  type QueuedComposerQueueRevision,
} from "@/contexts/queued-message-queues";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { encodeImages } from "@/utils/encode-images";

const syncStateRegistry = new Map<string, AgentMessageQueueSyncState>();
const mountedQueueSyncRegistry = new Map<string, MountedQueueSyncRuntime>();
const createIntentToken = (): object => ({});

function createHydrationStateNonce(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getIntentKey(agentId: string, messageId: string): string {
  return `${agentId}\u0000${messageId}`;
}

function syncIntentVersionsWithUnacknowledged(state: AgentMessageQueueSyncState): void {
  const activeKeys = new Set<string>();
  for (const [agentId, messages] of state.unacknowledged) {
    for (const message of messages) {
      activeKeys.add(getIntentKey(agentId, message.id));
    }
  }
  for (const key of Array.from(state.intentVersions.keys())) {
    if (!activeKeys.has(key)) {
      state.intentVersions.delete(key);
    }
  }
  for (const key of Array.from(state.pendingEnqueueFollowUps.keys())) {
    if (!activeKeys.has(key)) {
      state.pendingEnqueueFollowUps.delete(key);
    }
  }
}

function recordQueuedIntentVersion(input: {
  state: AgentMessageQueueSyncState;
  agentId: string;
  messageId: string;
}): object {
  const token = createIntentToken();
  input.state.intentVersions.set(getIntentKey(input.agentId, input.messageId), token);
  return token;
}

function removeQueuedIntentVersion(input: {
  state: AgentMessageQueueSyncState;
  agentId: string;
  messageId: string;
}): void {
  const key = getIntentKey(input.agentId, input.messageId);
  input.state.intentVersions.delete(key);
  input.state.pendingEnqueueFollowUps.delete(key);
}

function clearPendingFollowUpsForAgent(state: AgentMessageQueueSyncState, agentId: string): void {
  for (const key of Array.from(state.pendingEnqueueFollowUps.keys())) {
    if (key.startsWith(`${agentId}\u0000`)) {
      state.pendingEnqueueFollowUps.delete(key);
    }
  }
}

function clearIntentVersionsForAgent(state: AgentMessageQueueSyncState, agentId: string): void {
  for (const key of Array.from(state.intentVersions.keys())) {
    if (key.startsWith(`${agentId}\u0000`)) {
      state.intentVersions.delete(key);
    }
  }
  clearPendingFollowUpsForAgent(state, agentId);
}

function buildQueuedImagePersistId(input: {
  serverId: string;
  agentId: string;
  messageId: string;
  stateNonce: string;
  revisionKey: string;
  attemptId: number;
  index: number;
}): string {
  return [
    "queued-staged",
    encodeURIComponent(input.stateNonce),
    encodeURIComponent(input.serverId),
    encodeURIComponent(input.agentId),
    encodeURIComponent(input.messageId),
    encodeURIComponent(input.revisionKey),
    String(input.attemptId),
    String(input.index),
  ].join(":");
}

interface MountedQueueSyncRuntime {
  serverId: string;
  client: DaemonClient;
  state: AgentMessageQueueSyncState;
  canEnqueue(agentId: string): boolean;
}

interface PendingQueuedEnqueueFollowUp {
  serverId: string;
  agentId: string;
  message: QueuedComposerMessageMirror;
  token: object;
}

interface HydratedAttachmentResult {
  attachments: ComposerAttachment[];
  stagedMetadata: AttachmentMetadata[];
}

function getQueuedMessageIntent(
  state: AgentMessageQueueSyncState,
  agentId: string,
  messageId: string,
): { token: object; message: QueuedComposerMessageMirror } | null {
  if (state.deletedAgentIds.has(agentId) || state.inactiveAgentIds.has(agentId)) {
    return null;
  }
  const token = state.intentVersions.get(getIntentKey(agentId, messageId));
  if (token === undefined) {
    return null;
  }
  const message = state.unacknowledged.get(agentId)?.find((queued) => queued.id === messageId);
  if (!message) {
    return null;
  }
  return { token, message };
}

function startQueuedIntentEnqueueAttempt(input: {
  serverId: string;
  state: AgentMessageQueueSyncState;
  agentId: string;
  message: QueuedComposerMessageMirror;
  token: object;
}): Promise<void> {
  const key = getIntentKey(input.agentId, input.message.id);
  const existing = input.state.inFlightEnqueues.get(key);
  if (existing) {
    input.state.pendingEnqueueFollowUps.set(key, {
      serverId: input.serverId,
      agentId: input.agentId,
      message: input.message,
      token: input.token,
    });
    return existing;
  }

  const attemptPromise = (async () => {
    const runtime = mountedQueueSyncRegistry.get(input.serverId);
    const currentIntent = getQueuedMessageIntent(input.state, input.agentId, input.message.id);
    if (
      !runtime ||
      runtime.state !== input.state ||
      input.state.deletedAgentIds.has(input.agentId) ||
      !runtime.canEnqueue(input.agentId) ||
      !currentIntent ||
      currentIntent.token !== input.token
    ) {
      return;
    }
    try {
      const supportsForgeAttachments =
        useSessionStore.getState().sessions[input.serverId]?.serverInfo?.features?.forgeSearch ===
        true;
      const payload = splitComposerAttachmentsForSubmit(currentIntent.message.attachments, {
        format: resolveComposerAttachmentSubmitFormat({ supportsForgeAttachments }),
      });
      const images = await encodeImages(payload.images);
      const latestRuntime = mountedQueueSyncRegistry.get(input.serverId);
      const latestIntent = getQueuedMessageIntent(input.state, input.agentId, input.message.id);
      if (
        !latestRuntime ||
        latestRuntime.state !== input.state ||
        input.state.deletedAgentIds.has(input.agentId) ||
        !latestRuntime.canEnqueue(input.agentId) ||
        !latestIntent ||
        latestIntent.token !== input.token
      ) {
        return;
      }
      await latestRuntime.client.queueAgentMessage(input.agentId, latestIntent.message.text, {
        messageId: latestIntent.message.id,
        ...(images && images.length > 0 ? { images } : {}),
        attachments: payload.attachments,
      });
    } catch (error) {
      console.error("[AgentMessageQueue] Failed to enqueue queued message:", error);
      throw error;
    }
  })().finally(() => {
    if (input.state.inFlightEnqueues.get(key) === attemptPromise) {
      input.state.inFlightEnqueues.delete(key);
    }
    const followUp = input.state.pendingEnqueueFollowUps.get(key);
    if (followUp) {
      input.state.pendingEnqueueFollowUps.delete(key);
      void startQueuedIntentEnqueueAttempt({
        serverId: followUp.serverId,
        state: input.state,
        agentId: followUp.agentId,
        message: followUp.message,
        token: followUp.token,
      }).catch(() => undefined);
    }
  });
  input.state.inFlightEnqueues.set(key, attemptPromise);
  return attemptPromise;
}

function snapshotIntentVersions(input: {
  state: AgentMessageQueueSyncState;
  messagesByAgent: ReadonlyMap<string, readonly QueuedComposerMessageMirror[]>;
}): Map<string, object> {
  const snapshot = new Map<string, object>();
  for (const [agentId, messages] of input.messagesByAgent) {
    for (const message of messages) {
      const key = getIntentKey(agentId, message.id);
      const version = input.state.intentVersions.get(key);
      if (version !== undefined) {
        snapshot.set(key, version);
      }
    }
  }
  return snapshot;
}

function ensureIntentVersionsForMessages(input: {
  state: AgentMessageQueueSyncState;
  messagesByAgent: ReadonlyMap<string, readonly QueuedComposerMessageMirror[]>;
}): void {
  for (const [agentId, messages] of input.messagesByAgent) {
    for (const message of messages) {
      const key = getIntentKey(agentId, message.id);
      if (input.state.intentVersions.has(key)) {
        continue;
      }
      recordQueuedIntentVersion({
        state: input.state,
        agentId,
        messageId: message.id,
      });
    }
  }
}

function reconcileMigrationCompletion(input: {
  state: AgentMessageQueueSyncState;
  snapshot: ReadonlyMap<string, readonly QueuedComposerMessageMirror[]>;
  remaining: ReadonlyMap<string, readonly QueuedComposerMessageMirror[]>;
  snapshotIntentVersions: ReadonlyMap<string, object>;
}): void {
  const next = new Map(input.state.unacknowledged);
  for (const [agentId, snapshotMessages] of input.snapshot) {
    const currentMessages = next.get(agentId) ?? [];
    const currentById = new Map(currentMessages.map((message) => [message.id, message]));
    const snapshotById = new Map(snapshotMessages.map((message) => [message.id, message]));
    const remainingById = new Map(
      (input.remaining.get(agentId) ?? []).map((message) => [message.id, message]),
    );
    const result: QueuedComposerMessageMirror[] = [];

    for (const currentMessage of currentMessages) {
      const snapshotMessage = snapshotById.get(currentMessage.id);
      if (!snapshotMessage) {
        result.push(currentMessage);
        continue;
      }
      const intentKey = getIntentKey(agentId, currentMessage.id);
      const snapshotVersion = input.snapshotIntentVersions.get(intentKey);
      const currentVersion = input.state.intentVersions.get(intentKey);
      if (snapshotVersion === undefined || currentVersion !== snapshotVersion) {
        result.push(currentMessage);
        continue;
      }
      const remainingMessage = remainingById.get(currentMessage.id);
      if (remainingMessage) {
        result.push(remainingMessage);
        continue;
      }
      result.push(currentMessage);
    }

    for (const remainingMessage of input.remaining.get(agentId) ?? []) {
      const intentKey = getIntentKey(agentId, remainingMessage.id);
      const snapshotVersion = input.snapshotIntentVersions.get(intentKey);
      const currentVersion = input.state.intentVersions.get(intentKey);
      if (snapshotVersion === undefined || currentVersion !== snapshotVersion) {
        continue;
      }
      const currentMessage = currentById.get(remainingMessage.id);
      if (!currentMessage) {
        result.push(remainingMessage);
        continue;
      }
      const snapshotMessage = snapshotById.get(remainingMessage.id);
      if (snapshotMessage && equal(currentMessage, snapshotMessage)) {
        continue;
      }
    }

    if (result.length === 0) {
      next.delete(agentId);
      continue;
    }
    next.set(agentId, result);
  }
  input.state.unacknowledged = next;
  syncIntentVersionsWithUnacknowledged(input.state);
}

async function buildComposerAttachments(
  stateNonce: string,
  serverId: string,
  message: QueuedAgentMessageQueuePayload["messages"][number],
  attemptId: number,
  revisionKey: string,
): Promise<HydratedAttachmentResult> {
  const stagedMetadata: AttachmentMetadata[] = [];
  const images: Array<{ kind: "image"; metadata: AttachmentMetadata }> = [];
  try {
    for (const [index, image] of message.images.entries()) {
      const metadata = await attachmentService.persistAttachmentFromDataUrl({
        id: buildQueuedImagePersistId({
          stateNonce,
          serverId,
          agentId: message.agentId,
          messageId: message.id,
          revisionKey,
          attemptId,
          index,
        }),
        dataUrl: `data:${image.mimeType};base64,${image.data}`,
        mimeType: image.mimeType,
      });
      stagedMetadata.push(metadata);
      images.push({
        kind: "image",
        metadata,
      });
    }
  } catch (error) {
    await cleanupStagedMetadata(stagedMetadata);
    throw error;
  }

  return {
    attachments: [
      ...images,
      ...message.attachments.map((attachment) => ({
        kind: "agent_attachment" as const,
        attachment,
      })),
    ],
    stagedMetadata,
  };
}

function isCompactAuthoritativePayload(
  message: QueuedAgentMessageQueuePayload["messages"][number],
): boolean {
  return (
    message.imageCount > message.images.length ||
    message.attachmentCount > message.attachments.length
  );
}

function getQueuedComposerRevision(
  revisions: ReadonlyMap<string, QueuedComposerQueueRevision>,
  agentId: string,
): QueuedComposerQueueRevision | undefined {
  if (!revisions.has(agentId)) {
    return undefined;
  }
  return revisions.get(agentId) ?? null;
}

function resolveHydrationRevisionKey(input: {
  queueRevision: number | undefined;
  message: QueuedAgentMessageQueuePayload["messages"][number];
}): string {
  if (typeof input.queueRevision === "number") {
    return `rev-${input.queueRevision}`;
  }
  if (input.message.createdAt) {
    return `legacy-${input.message.createdAt}`;
  }
  return "legacy";
}

function shouldRejectQueueBeforeHydration(input: {
  queue: QueuedAgentMessageQueuePayload;
  revisions: ReadonlyMap<string, QueuedComposerQueueRevision>;
  deletedAgentIds: ReadonlySet<string>;
}): boolean {
  if (input.deletedAgentIds.has(input.queue.agentId)) {
    return true;
  }
  const currentRevision = getQueuedComposerRevision(input.revisions, input.queue.agentId);
  if (typeof currentRevision === "number") {
    if (input.queue.revision === undefined) {
      return true;
    }
    if (typeof input.queue.revision === "number" && input.queue.revision < currentRevision) {
      return true;
    }
  }
  return false;
}

async function cleanupStagedMetadata(metadata: readonly AttachmentMetadata[]): Promise<void> {
  if (metadata.length === 0) {
    return;
  }
  await attachmentService.deleteAttachments(metadata);
}

function collectResolvedStagedMetadata(
  queues: ReadonlyArray<{ stagedMetadata: readonly AttachmentMetadata[] }>,
): AttachmentMetadata[] {
  return queues.flatMap((queue) => queue.stagedMetadata);
}

function collectQueuedMessageMetadata(
  messages: readonly QueuedComposerMessageMirror[],
): AttachmentMetadata[] {
  const metadata = new Map<string, AttachmentMetadata>();
  for (const message of messages) {
    for (const attachment of message.attachments) {
      let persisted: AttachmentMetadata | undefined;
      if (attachment.kind === "image") {
        persisted = attachment.metadata;
      } else if (attachment.kind === "browser_element") {
        persisted = attachment.attachment.screenshot;
      }
      if (persisted) {
        metadata.set(`${persisted.storageType}:${persisted.storageKey}`, persisted);
      }
    }
  }
  return Array.from(metadata.values());
}

function applyInactiveEmptyQueueTombstones(input: {
  previous: Map<string, QueuedComposerMessageMirror[]>;
  tombstones: ReadonlyArray<{ agentId: string; revision: number }>;
  state: AgentMessageQueueSyncState;
  metadata: Map<string, AttachmentMetadata>;
}): Map<string, QueuedComposerMessageMirror[]> {
  let next = input.previous;
  for (const tombstone of input.tombstones) {
    const currentRevision = getQueuedComposerRevision(input.state.revisions, tombstone.agentId);
    if (typeof currentRevision === "number" && tombstone.revision < currentRevision) {
      continue;
    }
    const queuedMessages = [
      ...(next.get(tombstone.agentId) ?? []),
      ...(input.state.unacknowledged.get(tombstone.agentId) ?? []),
    ];
    for (const metadata of collectQueuedMessageMetadata(queuedMessages)) {
      input.metadata.set(`${metadata.storageType}:${metadata.storageKey}`, metadata);
    }
    input.state.revisions.set(tombstone.agentId, tombstone.revision);
    input.state.unacknowledged.delete(tombstone.agentId);
    clearIntentVersionsForAgent(input.state, tombstone.agentId);
    if (next.has(tombstone.agentId)) {
      next = new Map(next);
      next.delete(tombstone.agentId);
    }
  }
  return next;
}

function shouldSkipInactiveQueue(input: {
  queue: QueuedAgentMessageQueuePayload;
  state: AgentMessageQueueSyncState;
  isActiveDirectoryAgent: boolean;
  tombstones: Array<{ agentId: string; revision: number }>;
}): boolean {
  if (input.state.deletedAgentIds.has(input.queue.agentId)) {
    return true;
  }
  if (input.isActiveDirectoryAgent && !input.state.inactiveAgentIds.has(input.queue.agentId)) {
    return false;
  }
  if (typeof input.queue.revision === "number" && input.queue.messages.length === 0) {
    input.tombstones.push({ agentId: input.queue.agentId, revision: input.queue.revision });
  }
  return true;
}

function getRepresentedMirrorCounts(message: QueuedComposerMessageMirror | undefined): {
  images: number;
  attachments: number;
} {
  if (!message) {
    return { images: 0, attachments: 0 };
  }
  let images = 0;
  let attachments = 0;
  for (const attachment of message.attachments) {
    if (attachment.kind === "image") {
      images += 1;
      continue;
    }
    attachments += 1;
  }
  return { images, attachments };
}

function hasSufficientRepresentedAttachments(
  message: QueuedAgentMessageQueuePayload["messages"][number],
  existing: QueuedComposerMessageMirror | undefined,
): boolean {
  const represented = getRepresentedMirrorCounts(existing);
  return (
    represented.images >= message.imageCount && represented.attachments >= message.attachmentCount
  );
}

function isStaleEventSerial(input: {
  state: AgentMessageQueueSyncState;
  agentId?: string;
  eventSerial?: number;
}): boolean {
  return Boolean(
    input.agentId &&
    input.eventSerial !== undefined &&
    (input.state.lastReceivedEventSerial.get(input.agentId) ?? 0) !== input.eventSerial,
  );
}

type ResolvedQueueResult =
  | {
      status: "resolved";
      queue: QueuedComposerQueueMirror;
      stagedMetadata: AttachmentMetadata[];
    }
  | { status: "rejected" }
  | { status: "unresolved"; agentId: string };

async function resolveMergedQueue(input: {
  stateNonce: string;
  serverId: string;
  queue: QueuedAgentMessageQueuePayload;
  previous: ReadonlyMap<string, readonly QueuedComposerMessageMirror[]>;
  revisions: ReadonlyMap<string, QueuedComposerQueueRevision>;
  deletedAgentIds: ReadonlySet<string>;
  hydrationAttemptId: number;
  unacknowledged: ReadonlyMap<string, readonly QueuedComposerMessageMirror[]>;
}): Promise<ResolvedQueueResult> {
  if (
    shouldRejectQueueBeforeHydration({
      queue: input.queue,
      revisions: input.revisions,
      deletedAgentIds: input.deletedAgentIds,
    })
  ) {
    return { status: "rejected" };
  }
  const stagedMetadata: AttachmentMetadata[] = [];
  try {
    const previousMessages = input.previous.get(input.queue.agentId);
    const previousById = new Map((previousMessages ?? []).map((message) => [message.id, message]));
    const messages: QueuedComposerMessageMirror[] = [];
    const authoritativeMessages: QueuedComposerMessageMirror[] = [];

    for (const message of input.queue.messages) {
      if (isCompactAuthoritativePayload(message)) {
        await cleanupStagedMetadata(stagedMetadata);
        return { status: "unresolved", agentId: input.queue.agentId };
      }
      const hydrated = await buildComposerAttachments(
        input.stateNonce,
        input.serverId,
        message,
        input.hydrationAttemptId,
        resolveHydrationRevisionKey({
          queueRevision: input.queue.revision,
          message,
        }),
      );
      stagedMetadata.push(...hydrated.stagedMetadata);
      const existing = previousById.get(message.id);
      const nextAttachments =
        isCompactAuthoritativePayload(message) &&
        hasSufficientRepresentedAttachments(message, existing)
          ? (existing?.attachments ?? [])
          : hydrated.attachments;
      messages.push({
        id: message.id,
        text: message.text,
        attachments: nextAttachments,
      });
      authoritativeMessages.push({
        id: message.id,
        text: message.text,
        attachments: hydrated.attachments,
      });
    }
    const queueMirror: QueuedComposerQueueMirror = {
      agentId: input.queue.agentId,
      revision: input.queue.revision,
      messages,
      authoritativeMessages,
    };
    if (
      !resolveQueuedComposerQueueCandidate({
        queue: queueMirror,
        current: input.previous.get(input.queue.agentId)
          ? [...input.previous.get(input.queue.agentId)!]
          : undefined,
        revisions: input.revisions,
        unacknowledged: new Map(input.unacknowledged),
      })
    ) {
      await cleanupStagedMetadata(stagedMetadata);
      return { status: "rejected" };
    }
    return {
      status: "resolved",
      queue: queueMirror,
      stagedMetadata,
    };
  } catch (error) {
    await cleanupStagedMetadata(stagedMetadata);
    console.error("[AgentMessageQueue] Failed to hydrate queued attachments:", error);
    return {
      status: "unresolved",
      agentId: input.queue.agentId,
    };
  }
}

function needsAttachmentHydration(
  payload: QueuedAgentMessageQueuePayload,
  mirrored: readonly QueuedComposerMessageMirror[] | undefined,
): boolean {
  const mirroredById = new Map((mirrored ?? []).map((message) => [message.id, message]));
  return payload.messages.some((message) => {
    const mirroredCounts = getRepresentedMirrorCounts(mirroredById.get(message.id));
    return (
      message.imageCount > message.images.length ||
      message.attachmentCount > message.attachments.length ||
      mirroredCounts.images < message.imageCount ||
      mirroredCounts.attachments < message.attachmentCount
    );
  });
}

export function mountAgentMessageQueueSync(input: {
  client: DaemonClient;
  serverId: string;
  state: AgentMessageQueueSyncState;
}): () => void {
  let disposed = false;
  registerAgentMessageQueueSyncState(input.serverId, input.state);

  function deleteAgent(agentId: string): void {
    input.state.deletedAgentIds.add(agentId);
    input.state.inactiveAgentIds.delete(agentId);
    useSessionStore.getState().setQueuedMessages(input.serverId, (previous) =>
      removeQueuedComposerQueueMirrorForAgent({
        previous,
        revisions: input.state.revisions,
        unacknowledged: input.state.unacknowledged,
        agentId,
      }),
    );
    clearIntentVersionsForAgent(input.state, agentId);
  }

  function markAgentInactive(agentId: string): void {
    if (!input.state.deletedAgentIds.has(agentId)) {
      input.state.inactiveAgentIds.add(agentId);
    }
  }

  function isActiveDirectoryAgent(agentId: string): boolean {
    const session = useSessionStore.getState().sessions[input.serverId];
    if (!session?.hasHydratedAgents) return true;
    const agent = session.agents.get(agentId);
    return Boolean(agent && !agent.archivedAt);
  }

  mountedQueueSyncRegistry.set(input.serverId, {
    serverId: input.serverId,
    client: input.client,
    state: input.state,
    canEnqueue: (agentId) =>
      !disposed &&
      !input.state.deletedAgentIds.has(agentId) &&
      !input.state.inactiveAgentIds.has(agentId) &&
      isActiveDirectoryAgent(agentId),
  });

  let lastAuthoritativeAgents: ReadonlyMap<string, Agent> | null = null;
  function pruneToAuthoritativeDirectory(): void {
    const session = useSessionStore.getState().sessions[input.serverId];
    if (!session?.hasHydratedAgents || session.agents === lastAuthoritativeAgents) return;
    lastAuthoritativeAgents = session.agents;
  }

  async function applyQueues(
    queues: QueuedAgentMessageQueuePayload[],
    options?: { replaceAll?: boolean; agentId?: string; eventSerial?: number },
  ): Promise<void> {
    if (isStaleEventSerial({ state: input.state, ...options })) {
      return;
    }
    const previous =
      useSessionStore.getState().sessions[input.serverId]?.queuedMessages ?? new Map();
    const resolvedQueues: Array<{
      queue: QueuedComposerQueueMirror;
      stagedMetadata: AttachmentMetadata[];
    }> = [];
    const inactiveEmptyTombstones: Array<{ agentId: string; revision: number }> = [];
    const seenAgentIds = new Set<string>();
    for (const queue of queues) {
      seenAgentIds.add(queue.agentId);
      if (
        shouldSkipInactiveQueue({
          queue,
          state: input.state,
          isActiveDirectoryAgent: isActiveDirectoryAgent(queue.agentId),
          tombstones: inactiveEmptyTombstones,
        })
      ) {
        continue;
      }
      const merged = await resolveMergedQueue({
        stateNonce: input.state.hydrationStateNonce,
        serverId: input.serverId,
        queue,
        previous,
        revisions: input.state.revisions,
        deletedAgentIds: input.state.deletedAgentIds,
        hydrationAttemptId: input.state.nextHydrationAttemptId++,
        unacknowledged: input.state.unacknowledged,
      });
      if (merged.status === "resolved") {
        resolvedQueues.push({
          queue: merged.queue,
          stagedMetadata: merged.stagedMetadata,
        });
      }
    }
    if (disposed) {
      await cleanupStagedMetadata(collectResolvedStagedMetadata(resolvedQueues));
      return;
    }
    if (isStaleEventSerial({ state: input.state, ...options })) {
      await cleanupStagedMetadata(collectResolvedStagedMetadata(resolvedQueues));
      return;
    }
    const stagedByQueue = new Map(
      resolvedQueues.map((resolved) => [resolved.queue, resolved.stagedMetadata] as const),
    );
    const rejectedStagedMetadata: AttachmentMetadata[] = [];
    const tombstoneMetadata = new Map<string, AttachmentMetadata>();
    const applicableQueues: QueuedComposerQueueMirror[] = [];
    for (const resolved of resolvedQueues) {
      if (
        input.state.deletedAgentIds.has(resolved.queue.agentId) ||
        input.state.inactiveAgentIds.has(resolved.queue.agentId) ||
        !isActiveDirectoryAgent(resolved.queue.agentId)
      ) {
        rejectedStagedMetadata.push(...resolved.stagedMetadata);
        continue;
      }
      applicableQueues.push(resolved.queue);
    }
    useSessionStore.getState().setQueuedMessages(input.serverId, (current) => {
      const next = applyQueuedComposerQueueMirrors({
        previous: current,
        revisions: input.state.revisions,
        queues: applicableQueues,
        replaceAll: options?.replaceAll,
        unacknowledged: input.state.unacknowledged,
        seenAgentIds,
        onRejectedQueue: (queue) => {
          rejectedStagedMetadata.push(...(stagedByQueue.get(queue) ?? []));
        },
      });
      return applyInactiveEmptyQueueTombstones({
        previous: next,
        tombstones: inactiveEmptyTombstones,
        state: input.state,
        metadata: tombstoneMetadata,
      });
    });
    if (rejectedStagedMetadata.length > 0) {
      void cleanupStagedMetadata(rejectedStagedMetadata);
    }
    if (tombstoneMetadata.size > 0) {
      void cleanupStagedMetadata(Array.from(tombstoneMetadata.values()));
    }
    syncIntentVersionsWithUnacknowledged(input.state);
    if (options?.agentId && options.eventSerial !== undefined) {
      input.state.lastAppliedEventSerial.set(options.agentId, options.eventSerial);
    }
  }

  const unsubscribeQueueUpdates = input.client.on("queue.agent_message.updated", (message) => {
    if (message.type !== "queue.agent_message.updated") return;
    const eventSerial = (input.state.nextEventSerial += 1);
    input.state.lastReceivedEventSerial.set(message.payload.agentId, eventSerial);
    void (async () => {
      const mirrored = useSessionStore
        .getState()
        .sessions[input.serverId]?.queuedMessages.get(message.payload.agentId);
      const queues = needsAttachmentHydration(message.payload, mirrored)
        ? await input.client.listQueuedAgentMessages(message.payload.agentId)
        : [message.payload];
      await applyQueues(queues, { agentId: message.payload.agentId, eventSerial });
    })().catch((error) => {
      console.error("[AgentMessageQueue] Failed to apply queue update:", error);
    });
  });
  const unsubscribeAgentDeleted = input.client.on("agent_deleted", (message) => {
    if (message.type === "agent_deleted") deleteAgent(message.payload.agentId);
  });
  const unsubscribeAgentArchived = input.client.on("agent_archived", (message) => {
    if (message.type === "agent_archived") markAgentInactive(message.payload.agentId);
  });
  const unsubscribeDirectory = useSessionStore.subscribe(pruneToAuthoritativeDirectory);
  pruneToAuthoritativeDirectory();

  void (async () => {
    const localQueues =
      useSessionStore.getState().sessions[input.serverId]?.queuedMessages ?? new Map();
    const activeAgentFilter = (agentId: string) =>
      !input.state.deletedAgentIds.has(agentId) &&
      !input.state.inactiveAgentIds.has(agentId) &&
      isActiveDirectoryAgent(agentId);
    const migratableLocalQueues = new Map(
      Array.from(localQueues).filter(([agentId]) => activeAgentFilter(agentId)),
    );
    const activeUnacknowledged = new Map(
      Array.from(input.state.unacknowledged).filter(([agentId]) => activeAgentFilter(agentId)),
    );
    const inactiveUnacknowledged = new Map(
      Array.from(input.state.unacknowledged).filter(([agentId]) => !activeAgentFilter(agentId)),
    );
    const migrationCandidates = collectQueuedComposerMigrationCandidates({
      local: migratableLocalQueues,
      revisions: input.state.revisions,
      unacknowledged: activeUnacknowledged,
    });
    input.state.unacknowledged = new Map([...inactiveUnacknowledged, ...migrationCandidates]);
    ensureIntentVersionsForMessages({
      state: input.state,
      messagesByAgent: migrationCandidates,
    });
    const migrationSnapshot = new Map(
      Array.from(migrationCandidates, ([agentId, messages]) => [agentId, [...messages]]),
    );
    const migrationSnapshotIntentVersions = snapshotIntentVersions({
      state: input.state,
      messagesByAgent: migrationSnapshot,
    });
    const activeRemaining = await migrateQueuedComposerMessages({
      local: migratableLocalQueues,
      revisions: input.state.revisions,
      unacknowledged: migrationCandidates,
      isCancelled: () => disposed,
      enqueue: async (agentId, message) => {
        const intent = getQueuedMessageIntent(input.state, agentId, message.id);
        try {
          await startQueuedIntentEnqueueAttempt({
            serverId: input.serverId,
            state: input.state,
            agentId,
            message,
            token: intent?.token ?? createIntentToken(),
          });
        } catch (error) {
          console.error("[AgentMessageQueue] Failed to migrate locally queued message:", error);
          throw error;
        }
      },
    });
    if (disposed) return;
    reconcileMigrationCompletion({
      state: input.state,
      snapshot: migrationSnapshot,
      remaining: activeRemaining,
      snapshotIntentVersions: migrationSnapshotIntentVersions,
    });
    const queues = await input.client.listQueuedAgentMessages();
    if (disposed) return;
    await applyQueues(queues, { replaceAll: true });
  })().catch((error) => {
    if (!disposed) {
      console.error("[AgentMessageQueue] Failed to sync queued messages:", error);
    }
  });

  return () => {
    disposed = true;
    if (mountedQueueSyncRegistry.get(input.serverId)?.state === input.state) {
      mountedQueueSyncRegistry.delete(input.serverId);
    }
    unsubscribeQueueUpdates();
    unsubscribeAgentDeleted();
    unsubscribeAgentArchived();
    unsubscribeDirectory();
  };
}

export interface AgentMessageQueueSyncState {
  revisions: Map<string, QueuedComposerQueueRevision>;
  unacknowledged: Map<string, readonly QueuedComposerMessageMirror[]>;
  intentVersions: Map<string, object>;
  inFlightEnqueues: Map<string, Promise<void>>;
  pendingEnqueueFollowUps: Map<string, PendingQueuedEnqueueFollowUp>;
  inactiveAgentIds: Set<string>;
  deletedAgentIds: Set<string>;
  hydrationStateNonce: string;
  lastReceivedEventSerial: Map<string, number>;
  lastAppliedEventSerial: Map<string, number>;
  nextEventSerial: number;
  nextHydrationAttemptId: number;
}

export function createAgentMessageQueueSyncState(): AgentMessageQueueSyncState {
  return {
    revisions: new Map(),
    unacknowledged: new Map(),
    intentVersions: new Map(),
    inFlightEnqueues: new Map(),
    pendingEnqueueFollowUps: new Map(),
    inactiveAgentIds: new Set(),
    deletedAgentIds: new Set(),
    hydrationStateNonce: createHydrationStateNonce(),
    lastReceivedEventSerial: new Map(),
    lastAppliedEventSerial: new Map(),
    nextEventSerial: 0,
    nextHydrationAttemptId: 1,
  };
}

export function registerQueuedAgentMessageIntent(input: {
  serverId: string;
  agentId: string;
  message: QueuedComposerMessageMirror;
}): object | null {
  const state = syncStateRegistry.get(input.serverId);
  if (
    !state ||
    state.deletedAgentIds.has(input.agentId) ||
    state.inactiveAgentIds.has(input.agentId)
  ) {
    return null;
  }
  registerQueuedComposerUnacknowledgedMessage({
    unacknowledged: state.unacknowledged,
    agentId: input.agentId,
    message: input.message,
  });
  return recordQueuedIntentVersion({
    state,
    agentId: input.agentId,
    messageId: input.message.id,
  });
}

export function enqueueRegisteredQueuedAgentMessageIntent(input: {
  serverId: string;
  agentId: string;
  messageId: string;
}): Promise<void> | null {
  const state = syncStateRegistry.get(input.serverId);
  if (
    !state ||
    state.deletedAgentIds.has(input.agentId) ||
    state.inactiveAgentIds.has(input.agentId)
  ) {
    return null;
  }
  const intent = getQueuedMessageIntent(state, input.agentId, input.messageId);
  if (!intent) {
    return null;
  }
  return startQueuedIntentEnqueueAttempt({
    serverId: input.serverId,
    state,
    agentId: input.agentId,
    message: intent.message,
    token: intent.token,
  }).catch(() => undefined);
}

export function clearQueuedAgentMessageIntent(input: {
  serverId: string;
  agentId: string;
  messageId: string;
}): void {
  const state = syncStateRegistry.get(input.serverId);
  if (!state) {
    return;
  }
  removeQueuedComposerUnacknowledgedMessage({
    unacknowledged: state.unacknowledged,
    agentId: input.agentId,
    messageId: input.messageId,
  });
  removeQueuedIntentVersion({
    state,
    agentId: input.agentId,
    messageId: input.messageId,
  });
}

export function clearQueuedAgentMessageIntentIfCurrent(input: {
  serverId: string;
  agentId: string;
  messageId: string;
  token: object | null;
}): boolean {
  const state = syncStateRegistry.get(input.serverId);
  if (!state || input.token === null) {
    return false;
  }
  const key = getIntentKey(input.agentId, input.messageId);
  if (state.intentVersions.get(key) !== input.token) {
    return false;
  }
  removeQueuedComposerUnacknowledgedMessage({
    unacknowledged: state.unacknowledged,
    agentId: input.agentId,
    messageId: input.messageId,
  });
  removeQueuedIntentVersion({
    state,
    agentId: input.agentId,
    messageId: input.messageId,
  });
  return true;
}

export function registerAgentMessageQueueSyncState(
  serverId: string,
  state: AgentMessageQueueSyncState,
): void {
  syncStateRegistry.set(serverId, state);
}

export function unregisterAgentMessageQueueSyncState(
  serverId: string,
  state: AgentMessageQueueSyncState,
): void {
  if (syncStateRegistry.get(serverId) === state) {
    syncStateRegistry.delete(serverId);
  }
}
