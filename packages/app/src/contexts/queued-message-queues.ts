import equal from "fast-deep-equal";
import type { ComposerAttachment } from "@/attachments/types";

export type QueuedComposerQueueRevision = number | null;

export interface QueuedComposerMessageMirror {
  id: string;
  text: string;
  attachments: ComposerAttachment[];
}

export interface QueuedComposerQueueMirror {
  agentId: string;
  revision?: number;
  messages: QueuedComposerMessageMirror[];
  authoritativeMessages?: QueuedComposerMessageMirror[];
}

export interface QueuedComposerMessageEnqueuer {
  enqueue(agentId: string, message: QueuedComposerMessageMirror): Promise<void>;
}

export function registerQueuedComposerUnacknowledgedMessage(input: {
  unacknowledged: Map<string, readonly QueuedComposerMessageMirror[]>;
  agentId: string;
  message: QueuedComposerMessageMirror;
}): void {
  const current = input.unacknowledged.get(input.agentId) ?? [];
  const existingIndex = current.findIndex((queued) => queued.id === input.message.id);
  if (existingIndex >= 0) {
    const replacement = [...current];
    replacement.splice(existingIndex, 1, input.message);
    input.unacknowledged.set(input.agentId, replacement);
    return;
  }
  input.unacknowledged.set(input.agentId, [...current, input.message]);
}

export function removeQueuedComposerUnacknowledgedMessage(input: {
  unacknowledged: Map<string, readonly QueuedComposerMessageMirror[]>;
  agentId: string;
  messageId: string;
}): void {
  const current = input.unacknowledged.get(input.agentId);
  if (!current) {
    return;
  }
  const next = current.filter((queued) => queued.id !== input.messageId);
  if (next.length === 0) {
    input.unacknowledged.delete(input.agentId);
    return;
  }
  if (next.length !== current.length) {
    input.unacknowledged.set(input.agentId, next);
  }
}

export function collectQueuedComposerMigrationCandidates(input: {
  local: ReadonlyMap<string, readonly QueuedComposerMessageMirror[]>;
  revisions: ReadonlyMap<string, QueuedComposerQueueRevision>;
  unacknowledged: ReadonlyMap<string, readonly QueuedComposerMessageMirror[]>;
}): Map<string, readonly QueuedComposerMessageMirror[]> {
  const candidates = new Map(input.unacknowledged);
  for (const [agentId, messages] of input.local) {
    const revision = getQueuedComposerRevision(input.revisions, agentId);
    if ((revision === undefined || revision === null) && !candidates.has(agentId)) {
      candidates.set(agentId, messages);
    }
  }
  return candidates;
}

export async function migrateQueuedComposerMessages(input: {
  local: ReadonlyMap<string, readonly QueuedComposerMessageMirror[]>;
  revisions: ReadonlyMap<string, QueuedComposerQueueRevision>;
  unacknowledged: ReadonlyMap<string, readonly QueuedComposerMessageMirror[]>;
  enqueue: QueuedComposerMessageEnqueuer["enqueue"];
  isCancelled?: () => boolean;
}): Promise<Map<string, QueuedComposerMessageMirror[]>> {
  const candidates = collectQueuedComposerMigrationCandidates(input);

  const remaining = new Map(
    Array.from(candidates, ([agentId, messages]) => [agentId, [...messages]]),
  );
  for (const [agentId, messages] of candidates) {
    for (const message of messages) {
      if (input.isCancelled?.()) {
        return remaining;
      }
      try {
        await input.enqueue(agentId, message);
      } catch {
        continue;
      }
      const agentRemaining = remaining.get(agentId) ?? [];
      const nextAgentRemaining = agentRemaining.filter((queued) => queued.id !== message.id);
      if (nextAgentRemaining.length === 0) {
        remaining.delete(agentId);
      } else {
        remaining.set(agentId, nextAgentRemaining);
      }
    }
  }
  return remaining;
}

export function applyQueuedComposerQueueMirrors(input: {
  previous: Map<string, QueuedComposerMessageMirror[]>;
  revisions: Map<string, QueuedComposerQueueRevision>;
  queues: readonly QueuedComposerQueueMirror[];
  replaceAll?: boolean;
  unacknowledged?: Map<string, readonly QueuedComposerMessageMirror[]>;
  seenAgentIds?: Iterable<string>;
  onRejectedQueue?: (queue: QueuedComposerQueueMirror) => void;
}): Map<string, QueuedComposerMessageMirror[]> {
  const next = new Map(input.previous);
  const seenAgentIds = new Set(input.seenAgentIds ?? []);
  let changed = false;

  for (const queue of input.queues) {
    seenAgentIds.add(queue.agentId);
    const current = next.get(queue.agentId);
    const candidate = resolveQueuedComposerQueueCandidate({
      queue,
      current,
      revisions: input.revisions,
      unacknowledged: input.unacknowledged,
    });
    if (!candidate) {
      input.onRejectedQueue?.(queue);
      continue;
    }
    writeRemainingUnacknowledged({
      unacknowledged: input.unacknowledged,
      agentId: queue.agentId,
      messages: candidate.remainingUnacknowledged,
    });
    input.revisions.set(queue.agentId, candidate.revision);
    if (candidate.messages.length === 0) {
      changed = next.delete(queue.agentId) || changed;
      continue;
    }
    if (!current || !equal(current, candidate.messages)) {
      next.set(queue.agentId, candidate.messages);
      changed = true;
    }
  }

  if (input.replaceAll) {
    for (const agentId of input.previous.keys()) {
      if (seenAgentIds.has(agentId)) {
        continue;
      }
      if (
        preserveReplaceAllUnacknowledgedAgent({
          next,
          current: next.get(agentId),
          agentId,
          unacknowledged: input.unacknowledged,
        })
      ) {
        changed = true;
        continue;
      }
      const lastRevision = getQueuedComposerRevision(input.revisions, agentId);
      if (lastRevision === undefined || lastRevision === null) {
        changed = next.delete(agentId) || changed;
      }
    }
  }

  return changed ? next : input.previous;
}

function writeRemainingUnacknowledged(input: {
  unacknowledged: Map<string, readonly QueuedComposerMessageMirror[]> | undefined;
  agentId: string;
  messages: readonly QueuedComposerMessageMirror[];
}): void {
  if (!input.unacknowledged) {
    return;
  }
  if (input.messages.length === 0) {
    input.unacknowledged.delete(input.agentId);
    return;
  }
  input.unacknowledged.set(input.agentId, [...input.messages]);
}

function preserveReplaceAllUnacknowledgedAgent(input: {
  next: Map<string, QueuedComposerMessageMirror[]>;
  current: QueuedComposerMessageMirror[] | undefined;
  agentId: string;
  unacknowledged: Map<string, readonly QueuedComposerMessageMirror[]> | undefined;
}): boolean {
  const unacknowledged = input.unacknowledged?.get(input.agentId);
  if (!unacknowledged || unacknowledged.length === 0) {
    return false;
  }
  const replacement = [...unacknowledged];
  if (!input.current || !equal(input.current, replacement)) {
    input.next.set(input.agentId, replacement);
  }
  return true;
}

export function pruneQueuedComposerQueueMirrorsToAgentIds(input: {
  previous: Map<string, QueuedComposerMessageMirror[]>;
  revisions: Map<string, QueuedComposerQueueRevision>;
  unacknowledged: Map<string, readonly QueuedComposerMessageMirror[]>;
  agentIds: Iterable<string>;
}): Map<string, QueuedComposerMessageMirror[]> {
  const agentIds = new Set(input.agentIds);
  let next: Map<string, QueuedComposerMessageMirror[]> | null = null;

  for (const agentId of Array.from(input.revisions.keys())) {
    if (!agentIds.has(agentId) && (input.unacknowledged.get(agentId)?.length ?? 0) === 0) {
      input.revisions.delete(agentId);
    }
  }

  for (const agentId of Array.from(input.unacknowledged.keys())) {
    if (!agentIds.has(agentId) && input.unacknowledged.get(agentId)?.length === 0) {
      input.unacknowledged.delete(agentId);
    }
  }

  for (const agentId of input.previous.keys()) {
    if (agentIds.has(agentId) || (input.unacknowledged.get(agentId)?.length ?? 0) > 0) {
      continue;
    }
    next ??= new Map(input.previous);
    next.delete(agentId);
  }

  return next ?? input.previous;
}

export function removeQueuedComposerQueueMirrorForAgent(input: {
  previous: Map<string, QueuedComposerMessageMirror[]>;
  revisions: Map<string, QueuedComposerQueueRevision>;
  unacknowledged: Map<string, readonly QueuedComposerMessageMirror[]>;
  agentId: string;
}): Map<string, QueuedComposerMessageMirror[]> {
  input.revisions.delete(input.agentId);
  input.unacknowledged.delete(input.agentId);
  if (!input.previous.has(input.agentId)) {
    return input.previous;
  }
  const next = new Map(input.previous);
  next.delete(input.agentId);
  return next;
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

function normalizeQueuedComposerRevision(
  revision: number | undefined,
): QueuedComposerQueueRevision {
  return typeof revision === "number" ? revision : null;
}

export function resolveQueuedComposerQueueCandidate(input: {
  queue: QueuedComposerQueueMirror;
  current: QueuedComposerMessageMirror[] | undefined;
  revisions: ReadonlyMap<string, QueuedComposerQueueRevision>;
  unacknowledged?: Map<string, readonly QueuedComposerMessageMirror[]>;
}): {
  revision: QueuedComposerQueueRevision;
  messages: QueuedComposerMessageMirror[];
  remainingUnacknowledged: QueuedComposerMessageMirror[];
} | null {
  const lastRevision = getQueuedComposerRevision(input.revisions, input.queue.agentId);
  const incomingRevision = normalizeQueuedComposerRevision(input.queue.revision);
  if (typeof lastRevision === "number" && incomingRevision === null) {
    return null;
  }

  const unacknowledged = input.unacknowledged?.get(input.queue.agentId) ?? [];
  const serverMessageIds = new Set(input.queue.messages.map((message) => message.id));
  const localOnly = unacknowledged.filter((message) => !serverMessageIds.has(message.id));
  const messages = [...input.queue.messages, ...localOnly];
  const authoritativeMessages = input.queue.authoritativeMessages;
  const comparisonMessages = [...(authoritativeMessages ?? input.queue.messages), ...localOnly];
  const hasOverlappingRecoveredIds = localOnly.length !== unacknowledged.length;

  if (typeof lastRevision === "number" && typeof incomingRevision === "number") {
    if (incomingRevision < lastRevision) {
      return null;
    }
    if (incomingRevision === lastRevision) {
      if (!authoritativeMessages && hasOverlappingRecoveredIds) {
        return null;
      }
      if (input.current && equal(input.current, comparisonMessages)) {
        return {
          revision: incomingRevision,
          messages,
          remainingUnacknowledged: localOnly,
        };
      }
      return null;
    }
  }

  return {
    revision: incomingRevision,
    messages,
    remainingUnacknowledged: localOnly,
  };
}
