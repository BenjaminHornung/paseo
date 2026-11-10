import type { PaseoApi } from "@getpaseo/client";
import { canonicalPath, hash } from "./contracts.ts";
import type { Store } from "./store.ts";
import { observedTimeline } from "./timeline.ts";

interface Entry {
  timestamp?: string;
  item: { type: string; text?: string; messageId?: string; clientMessageId?: string };
}
export interface IntakeIdentity {
  agentId: string;
  sessionId: string;
  messageId: string;
  nativeMessageId?: string;
  timestamp: string;
  textHash: string;
}
const prefix = "INTAKE_MESSAGE_IDENTITY:";
const nativeId = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const operatorAdvisorPrefix = "operator-readonly-advisor:";
export function isOperatorAdvisorReceipt(
  store: Store,
  agentId: string,
  messageId: string,
  text: string,
): boolean {
  const receipt = store.db
    .prepare("SELECT kind FROM internal_messages WHERE agent_id=? AND message_id=?")
    .get(agentId, messageId) as { kind: string } | undefined;
  return receipt?.kind === `${operatorAdvisorPrefix}${hash(text)}`;
}

export function intakeIdentities(
  store: Store,
  agentId: string,
  sessionId: string,
): IntakeIdentity[] {
  const rows = store.db
    .prepare("SELECT kind FROM events WHERE kind LIKE 'INTAKE_MESSAGE_IDENTITY:%' ORDER BY rowid")
    .all() as { kind: string }[];
  const latest = new Map<string, IntakeIdentity>();
  for (const row of rows) {
    const identity = JSON.parse(row.kind.slice(prefix.length)) as IntakeIdentity;
    if (identity.agentId === agentId && identity.sessionId === sessionId)
      latest.set(identity.messageId, identity);
  }
  return [...latest.values()];
}

export function rememberIntakeIdentity(store: Store, identity: IntakeIdentity): boolean {
  if (!identity.sessionId || !Number.isFinite(Date.parse(identity.timestamp))) return false;
  if (identity.nativeMessageId && !nativeId.test(identity.nativeMessageId))
    identity = { ...identity, nativeMessageId: undefined };
  const receipt = store.db
    .prepare("SELECT kind FROM internal_messages WHERE agent_id=? AND message_id=?")
    .get(identity.agentId, identity.messageId) as { kind: string } | undefined;
  if (
    !receipt ||
    (receipt.kind.startsWith("human:") && receipt.kind !== `human:${identity.textHash}`)
  )
    return false;
  if (
    receipt.kind.startsWith(operatorAdvisorPrefix) &&
    receipt.kind !== `${operatorAdvisorPrefix}${identity.textHash}`
  )
    return false;
  const previous = intakeIdentities(store, identity.agentId, identity.sessionId).find(
    (item) => item.messageId === identity.messageId,
  );
  if (previous?.nativeMessageId && !identity.nativeMessageId)
    identity = { ...identity, nativeMessageId: previous.nativeMessageId };
  if (previous?.nativeMessageId && identity.nativeMessageId !== previous.nativeMessageId)
    return false;
  const kind = `${prefix}${JSON.stringify(identity)}`;
  if (!store.db.prepare("SELECT 1 FROM events WHERE kind=?").get(kind)) store.event(kind);
  return true;
}

// Cursor epochs are transport state, not durable message identities. Operator
// recovery may move back to a proven processed prefix, never past unseen input.
export async function rebaseLegacyIntakeCursor(
  store: Store,
  paseo: PaseoApi,
  request: {
    agentId: string;
    directory: string;
    sessionId: string;
    expectedCheckpoint: string;
  },
): Promise<string> {
  const handle = paseo.agents.ref(request.agentId),
    snapshot = (await handle.refresh())?.agent;
  if (
    !snapshot ||
    snapshot.status !== "idle" ||
    snapshot.activeTurn ||
    snapshot.pendingPermissions?.length ||
    snapshot.runtimeInfo?.sessionId !== request.sessionId ||
    canonicalPath(snapshot.cwd) !== canonicalPath(request.directory)
  )
    throw Error("INTAKE_MIGRATION_MAIN_MISMATCH");
  if (!request.expectedCheckpoint.startsWith("cursor:")) throw Error("INTAKE_CURSOR_REQUIRED");
  const timeline = await observedTimeline(handle, "canonical");
  if (timeline.hasOlder) throw Error("INTAKE_MIGRATION_HISTORY_INCOMPLETE");
  const entries = resolveIntakeIdentities(
    timeline.entries,
    intakeIdentities(store, request.agentId, request.sessionId),
    true,
  );
  return store.transaction(() => {
    const checkpoint = store.db
      .prepare("SELECT message_id FROM main_checkpoints WHERE agent_id=?")
      .get(request.agentId) as { message_id: string } | undefined;
    if (checkpoint?.message_id !== request.expectedCheckpoint)
      throw Error("INTAKE_CHECKPOINT_CHANGED");
    const rows = store.db
      .prepare(
        "SELECT facts_json FROM assessments WHERE owner_id=? AND kind='intake' AND result_json IS NOT NULL",
      )
      .all(request.agentId) as { facts_json: string }[];
    const facts = rows.map(
      (row) => JSON.parse(row.facts_json) as { messageId: string; text: string; directory: string },
    );
    const messages = entries.filter((entry) => entry.item.type === "user_message");
    let anchor: string | undefined;
    for (const entry of messages) {
      if (entry.item.type !== "user_message") continue;
      const text = entry.item.text;
      const id = entry.item.clientMessageId ?? entry.item.messageId;
      if (!id) break;
      const receipt = store.db
        .prepare("SELECT kind FROM internal_messages WHERE agent_id=? AND message_id=?")
        .get(request.agentId, id) as { kind: string } | undefined;
      const internal =
        receipt &&
        !receipt.kind.startsWith("human:") &&
        !receipt.kind.startsWith(operatorAdvisorPrefix);
      const exact = facts.some((value) => value.messageId === id && value.text === text);
      // Legacy unverified transport IDs can establish a processed boundary,
      // never a human receipt. Ambiguous duplicate text stops the prefix.
      const legacy =
        !receipt &&
        messages.filter((other) => other.item.type === "user_message" && other.item.text === text)
          .length === 1 &&
        facts.some(
          (value) =>
            value.text === text &&
            canonicalPath(value.directory) === canonicalPath(request.directory),
        );
      if (!internal && !exact && !legacy) break;
      anchor = id;
    }
    if (!anchor) throw Error("INTAKE_PROCESSED_PREFIX_REQUIRED");
    store.db
      .prepare("UPDATE main_checkpoints SET message_id=? WHERE agent_id=?")
      .run(anchor, request.agentId);
    store.event(
      `OPERATOR_INTAKE_CURSOR_REBASE:${JSON.stringify({ ...request, messageId: anchor })}`,
    );
    return anchor;
  });
}

// Operator-only migration for receipts predating identity recording. It never
// changes a checkpoint, classification, work authorization or lease.
export async function bindLegacyIntakeIdentity(
  store: Store,
  paseo: PaseoApi,
  request: {
    agentId: string;
    directory: string;
    sessionId: string;
    messageId: string;
    nativeMessageId: string;
  },
): Promise<void> {
  const handle = paseo.agents.ref(request.agentId),
    snapshot = (await handle.refresh())?.agent;
  if (
    !snapshot ||
    snapshot.status !== "idle" ||
    snapshot.activeTurn ||
    snapshot.pendingPermissions?.length ||
    snapshot.provider.split("/")[0] !== "codex" ||
    snapshot.runtimeInfo?.sessionId !== request.sessionId ||
    canonicalPath(snapshot.cwd) !== canonicalPath(request.directory)
  )
    throw Error("INTAKE_MIGRATION_MAIN_MISMATCH");
  if (!nativeId.test(request.nativeMessageId)) throw Error("INTAKE_MIGRATION_NATIVE_ID_REQUIRED");
  const timeline = await observedTimeline(handle, "canonical");
  if (timeline.hasOlder) throw Error("INTAKE_MIGRATION_HISTORY_INCOMPLETE");
  store.transaction(() => {
    const receipt = store.db
      .prepare("SELECT kind FROM internal_messages WHERE agent_id=? AND message_id=?")
      .get(request.agentId, request.messageId) as { kind: string } | undefined;
    if (!receipt?.kind.startsWith("human:")) throw Error("INTAKE_MIGRATION_HUMAN_RECEIPT_REQUIRED");
    const textHash = receipt.kind.slice("human:".length);
    const matches = timeline.entries.filter(
      (entry) => entry.item.type === "user_message" && hash(entry.item.text) === textHash,
    );
    const entry = matches[0];
    if (
      matches.length !== 1 ||
      entry.item.type !== "user_message" ||
      entry.item.messageId !== request.nativeMessageId ||
      (entry.item.clientMessageId && entry.item.clientMessageId !== request.messageId)
    )
      throw Error("INTAKE_MIGRATION_MATCH_AMBIGUOUS");
    const identity = {
      agentId: request.agentId,
      sessionId: request.sessionId,
      messageId: request.messageId,
      nativeMessageId: request.nativeMessageId,
      timestamp: entry.timestamp,
      textHash,
    };
    if (!rememberIntakeIdentity(store, identity)) throw Error("INTAKE_MIGRATION_RECEIPT_MISMATCH");
    const audit = `OPERATOR_INTAKE_IDENTITY_BOUND:${hash(identity)}`;
    if (!store.db.prepare("SELECT 1 FROM events WHERE kind=?").get(audit)) store.event(audit);
  });
}

// Message IDs can change when Paseo rehydrates a Codex session. A native ID is
// preferred; a first rehydration also needs the saved timestamp AND content hash,
// the same native session and a complete, unambiguous history. Text alone never
// supplies either message identity or human authorization.
export function resolveIntakeIdentities<T extends Entry>(
  entries: readonly T[],
  identities: IntakeIdentity[],
  fullHistory: boolean,
): T[] {
  const resolved = new Map<T, string>();
  for (const identity of identities) {
    const candidates = entries.filter((entry) => {
      const item = entry.item;
      if (
        item.type !== "user_message" ||
        typeof item.text !== "string" ||
        hash(item.text) !== identity.textHash
      )
        return false;
      if ((item.clientMessageId ?? item.messageId) === identity.messageId) return true;
      if (item.clientMessageId) return false;
      if (identity.nativeMessageId && item.messageId === identity.nativeMessageId) return true;
      return (
        fullHistory &&
        !identity.nativeMessageId &&
        nativeId.test(item.messageId ?? "") &&
        Number.isFinite(Date.parse(entry.timestamp ?? "")) &&
        Math.abs(Date.parse(entry.timestamp!) - Date.parse(identity.timestamp)) <= 1000
      );
    });
    if (candidates.length > 1) throw Error("INTAKE_MESSAGE_IDENTITY_AMBIGUOUS");
    if (!candidates.length) continue;
    const previous = resolved.get(candidates[0]);
    if (previous && previous !== identity.messageId)
      throw Error("INTAKE_MESSAGE_IDENTITY_AMBIGUOUS");
    resolved.set(candidates[0], identity.messageId);
  }
  return entries.map((entry) =>
    resolved.has(entry)
      ? { ...entry, item: { ...entry.item, clientMessageId: resolved.get(entry) } }
      : entry,
  );
}
