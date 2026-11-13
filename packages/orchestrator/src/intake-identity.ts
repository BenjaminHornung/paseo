import type { PaseoApi, PaseoAgent, PaseoAgentHandle } from "@getpaseo/client";
import { canonicalPath, hash } from "./contracts.ts";
import type { Store } from "./store.ts";
import type { IntakeFacts } from "./assessments.ts";
import { observedTimeline } from "./timeline.ts";
import { operatorWakeBindingSchema, type OperatorWakeBinding } from "./verification-recovery.ts";

interface Entry {
  timestamp?: string;
  providerMessageId?: string;
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
const internalOriginPrefix = "INTAKE_INTERNAL_ORIGIN:";
type InternalMessageKind = "wake" | "reminder" | "activation";
const internalReceiptKinds: ReadonlySet<string> = new Set<InternalMessageKind>([
  "wake",
  "reminder",
  "activation",
]);
interface InternalMessageOrigin {
  identity: IntakeIdentity;
  directory: string;
  kind: InternalMessageKind;
  provenance?: "operator";
}
const operatorOriginPrefix = "OPERATOR_INTERNAL_ORIGIN:";
export async function assertOperatorMainIdle(
  handle: PaseoAgentHandle,
  binding: OperatorWakeBinding,
): Promise<void> {
  assertOperatorMainSnapshot((await handle.refresh())?.agent, binding);
}
export function assertOperatorMainSnapshot(
  agent: PaseoAgent | null | undefined,
  binding: OperatorWakeBinding,
): void {
  if (
    !agent ||
    agent.id !== binding.mainAgentId ||
    agent.status !== "idle" ||
    agent.activeTurn ||
    agent.pendingPermissions?.length ||
    agent.runtimeInfo?.sessionId !== binding.sessionId ||
    canonicalPath(agent.cwd) !== canonicalPath(binding.directory) ||
    agent.provider.split("/")[0] !== "codex"
  )
    throw Error("VERIFICATION_RECOVERY_MAIN_CHANGED");
}
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

// A first replay may expose only the native ID. The existing fallback can
// establish its uniqueness only after the complete history has been read.
export function unboundInternalIdentities(
  store: Store,
  identities: IntakeIdentity[],
): IntakeIdentity[] {
  return identities.filter((identity) => {
    if (identity.nativeMessageId) return false;
    const receipt = store.db
      .prepare("SELECT kind FROM internal_messages WHERE agent_id=? AND message_id=?")
      .get(identity.agentId, identity.messageId) as { kind: string } | undefined;
    return !!receipt && internalReceiptKinds.has(receipt.kind);
  });
}
interface IntakeIdentityCapture {
  identities: IntakeIdentity[];
  entries: readonly Entry[];
  checkpointEntry?: Entry;
}
// Relevance only limits which unresolved internal aliases need a first proof.
// Human identities and existing native aliases retain the normal strict checks.
export function relevantCaptureIdentities(
  store: Store,
  capture: IntakeIdentityCapture,
): IntakeIdentity[] {
  const { identities, entries, checkpointEntry } = capture;
  const checkpointTime = Date.parse(checkpointEntry?.timestamp ?? "");
  if (!identities.length || !Number.isFinite(checkpointTime)) return identities;
  const unbound = new Set(unboundInternalIdentities(store, identities));
  if (!unbound.size) return identities;
  const agentId = identities[0]!.agentId;
  const claims = store.db
    .prepare(
      "SELECT facts_json FROM assessments WHERE owner_id=? AND kind='intake' AND json_extract(facts_json,'$.origin')='unverified'",
    )
    .all(agentId) as { facts_json: string }[];
  const claimedIds = new Set<string>();
  const claimedHashes = new Set<string>();
  for (const row of claims) {
    const facts = JSON.parse(row.facts_json) as IntakeFacts;
    claimedIds.add(facts.messageId);
    claimedHashes.add(hash(facts.text));
  }
  const pendingPrefix = `INTAKE_CLASSIFICATION_PENDING:${agentId}:`;
  const pending = store.db
    .prepare(
      "SELECT pending.kind FROM events pending WHERE substr(pending.kind,1,?)=? AND NOT EXISTS(SELECT 1 FROM events settled WHERE settled.kind=replace(pending.kind,'INTAKE_CLASSIFICATION_PENDING:','INTAKE_CLASSIFICATION_SETTLED:') AND settled.sequence>pending.sequence)",
    )
    .all(pendingPrefix.length, pendingPrefix) as { kind: string }[];
  const pendingHashes = new Set(pending.map((row) => row.kind.slice(pendingPrefix.length)));
  return identities.filter((identity) => {
    if (!unbound.has(identity)) return true;
    const timestamp = Date.parse(identity.timestamp);
    const afterCheckpoint = !Number.isFinite(timestamp) || timestamp >= checkpointTime - 1000;
    const boundClaim = claimedIds.has(identity.messageId) || claimedHashes.has(identity.textHash);
    if (afterCheckpoint || boundClaim || pendingHashes.has(hash(identity.messageId))) return true;
    return entries.some((entry) => {
      const item = entry.item;
      if (item.type !== "user_message") return false;
      if (item.clientMessageId === identity.messageId || item.messageId === identity.messageId)
        return true;
      const messageId = item.clientMessageId ?? item.messageId;
      return (
        !!messageId && hash(item.text) === identity.textHash && pendingHashes.has(hash(messageId))
      );
    });
  });
}
export function needsCompleteInternalHistory(
  store: Store,
  identities: IntakeIdentity[],
  entries: readonly Entry[],
): boolean {
  return unboundInternalIdentities(store, identities).some(
    (identity) =>
      !entries.some(
        (entry) =>
          entry.item.type === "user_message" &&
          (entry.item.clientMessageId ?? entry.item.messageId) === identity.messageId,
      ),
  );
}

function assertInternalOrigin(store: Store, origin: InternalMessageOrigin): void {
  const { identity } = origin;
  if (
    !internalReceiptKinds.has(origin.kind) ||
    !identity.sessionId ||
    !nativeId.test(identity.nativeMessageId ?? "") ||
    !Number.isFinite(Date.parse(identity.timestamp))
  )
    throw Error("INTAKE_INTERNAL_ORIGIN_UNPROVEN");
  const receipt = store.db.prepare(
    "SELECT kind FROM internal_messages WHERE agent_id=? AND message_id=?",
  );
  const original = receipt.get(identity.agentId, identity.messageId) as
    | { kind: string }
    | undefined;
  const native = receipt.get(identity.agentId, identity.nativeMessageId!) as
    | { kind: string }
    | undefined;
  if (original?.kind !== origin.kind || (native && native.kind !== origin.kind))
    throw Error("INTAKE_INTERNAL_ORIGIN_CONFLICT");
  if (
    !store.db
      .prepare("SELECT 1 FROM events WHERE kind=?")
      .get(`${prefix}${JSON.stringify(identity)}`)
  )
    throw Error("INTAKE_INTERNAL_ORIGIN_UNPROVEN");
  assertNoHumanOriginClaim(store, origin);
}

function assertNoHumanOriginClaim(store: Store, origin: InternalMessageOrigin): void {
  const { identity } = origin;
  const rows = store.db
    .prepare(
      "SELECT id,facts_hash,facts_json FROM assessments WHERE owner_id=? AND kind='intake' AND json_extract(facts_json,'$.messageId') IN (?,?)",
    )
    .all(identity.agentId, identity.messageId, identity.nativeMessageId!) as {
    id: string;
    facts_hash: string;
    facts_json: string;
  }[];
  for (const row of rows) {
    const facts = JSON.parse(row.facts_json) as IntakeFacts;
    if (
      facts.origin !== "unverified" ||
      facts.mainAgentId !== identity.agentId ||
      hash(facts) !== row.facts_hash ||
      hash(facts.text) !== identity.textHash ||
      canonicalPath(facts.directory) !== origin.directory
    )
      throw Error("INTAKE_INTERNAL_ORIGIN_CONFLICT");
  }
  const claims = store.db
    .prepare(
      "SELECT kind FROM events WHERE kind LIKE 'MAIN_INPUT_INTERPRETATION:%' OR kind LIKE 'OPERATOR_INTAKE_APPROVED:%'",
    )
    .all() as { kind: string }[];
  for (const { kind } of claims) {
    const claim = JSON.parse(kind.slice(kind.indexOf(":") + 1));
    if (
      rows.some((row) =>
        [claim.intakeId, claim.assessmentId, claim.confirmation?.assessmentId].includes(row.id),
      )
    )
      throw Error("INTAKE_INTERNAL_ORIGIN_CONFLICT");
  }
  for (const messageId of [identity.messageId, identity.nativeMessageId!]) {
    const confirmed = `OPERATOR_CONFIRMED_EXISTING_WORK:${identity.agentId}:${messageId}:`;
    if (
      store.db
        .prepare("SELECT 1 FROM events WHERE substr(kind,1,?)=?")
        .get(confirmed.length, confirmed)
    )
      throw Error("INTAKE_INTERNAL_ORIGIN_CONFLICT");
  }
}

export function provenInternalMessages(store: Store, agentId: string): InternalMessageOrigin[] {
  const rows = store.db
    .prepare("SELECT kind FROM events WHERE substr(kind,1,?)=?")
    .all(internalOriginPrefix.length, internalOriginPrefix) as { kind: string }[];
  const native = rows.flatMap(({ kind }) => {
    const origin = JSON.parse(kind.slice(internalOriginPrefix.length)) as InternalMessageOrigin;
    if (origin.identity.agentId !== agentId) return [];
    assertInternalOrigin(store, origin);
    return [origin];
  });
  const operator = store.db
    .prepare("SELECT kind FROM events WHERE substr(kind,1,?)=?")
    .all(operatorOriginPrefix.length, operatorOriginPrefix) as { kind: string }[];
  for (const row of operator) {
    const { binding } = JSON.parse(row.kind.slice(operatorOriginPrefix.length));
    if (binding.mainAgentId !== agentId) continue;
    native.push(validateOperatorWakeOrigin(store, operatorWakeBindingSchema.parse(binding)));
  }
  const aliases = new Map<string, InternalMessageOrigin>();
  for (const origin of native) {
    const key = hash([origin.identity.sessionId, origin.identity.nativeMessageId]);
    const previous = aliases.get(key);
    if (
      previous &&
      (previous.identity.messageId !== origin.identity.messageId ||
        previous.identity.textHash !== origin.identity.textHash ||
        previous.directory !== origin.directory)
    )
      throw Error("INTAKE_INTERNAL_ORIGIN_CONFLICT");
    aliases.set(key, origin);
  }
  return native;
}

export function validateOperatorWakeOrigin(
  store: Store,
  binding: OperatorWakeBinding,
): InternalMessageOrigin {
  const identity = intakeIdentities(store, binding.mainAgentId, binding.sessionId).find(
    (item) => item.messageId === binding.receiptId,
  );
  const row = store.db
    .prepare("SELECT * FROM assessments WHERE id=? AND kind='intake'")
    .get(binding.assessmentId);
  if (
    !identity ||
    !row ||
    row.owner_id !== binding.mainAgentId ||
    row.facts_hash !== binding.factsHash ||
    identity.textHash !== binding.textHash ||
    (identity.nativeMessageId && identity.nativeMessageId !== binding.nativeMessageId)
  )
    throw Error("OPERATOR_WAKE_BINDING_CHANGED");
  const facts = JSON.parse(String(row.facts_json)) as IntakeFacts;
  if (
    facts.origin !== "unverified" ||
    facts.messageId !== binding.nativeMessageId ||
    facts.mainAgentId !== binding.mainAgentId ||
    hash(facts) !== binding.factsHash ||
    hash(facts.text) !== binding.textHash ||
    canonicalPath(facts.directory) !== canonicalPath(binding.directory) ||
    !nativeId.test(binding.nativeMessageId) ||
    store.db
      .prepare("SELECT kind FROM internal_messages WHERE agent_id=? AND message_id=?")
      .get(binding.mainAgentId, binding.receiptId)?.kind !== "wake"
  )
    throw Error("OPERATOR_WAKE_BINDING_CHANGED");
  const origin: InternalMessageOrigin = {
    identity: { ...identity, nativeMessageId: binding.nativeMessageId },
    directory: canonicalPath(binding.directory),
    kind: "wake",
    provenance: "operator",
  };
  const nativeReceipt = store.db
    .prepare("SELECT kind FROM internal_messages WHERE agent_id=? AND message_id=?")
    .get(binding.mainAgentId, binding.nativeMessageId);
  if (nativeReceipt && nativeReceipt.kind !== "wake")
    throw Error("INTAKE_INTERNAL_ORIGIN_CONFLICT");
  assertNoHumanOriginClaim(store, origin);
  return origin;
}

export function recordOperatorWakeOrigin(
  store: Store,
  binding: OperatorWakeBinding,
  reason: string,
): void {
  validateOperatorWakeOrigin(store, binding);
  const checkpoint = store.db
    .prepare("SELECT work_intake_id FROM main_checkpoints WHERE agent_id=?")
    .get(binding.mainAgentId);
  if (checkpoint?.work_intake_id !== binding.workIntakeId)
    throw Error("OPERATOR_WAKE_WORK_CHANGED");
  const existing = store.db
    .prepare("SELECT kind FROM events WHERE substr(kind,1,?)=?")
    .all(operatorOriginPrefix.length, operatorOriginPrefix) as { kind: string }[];
  for (const row of existing) {
    const old = JSON.parse(row.kind.slice(operatorOriginPrefix.length));
    if (
      old.binding.mainAgentId !== binding.mainAgentId ||
      ![old.binding.receiptId, old.binding.nativeMessageId].some((id: string) =>
        [binding.receiptId, binding.nativeMessageId].includes(id),
      )
    )
      continue;
    if (hash(old) !== hash({ binding, reason })) throw Error("OPERATOR_WAKE_BINDING_CONFLICT");
    return;
  }
  store.event(`${operatorOriginPrefix}${JSON.stringify({ binding, reason })}`);
}

export function isProvenInternalIntake(store: Store, assessmentId: string): boolean {
  const row = store.db
    .prepare("SELECT owner_id,facts_hash,facts_json FROM assessments WHERE id=? AND kind='intake'")
    .get(assessmentId) as { owner_id: string; facts_hash: string; facts_json: string } | undefined;
  if (!row) return false;
  const facts = JSON.parse(row.facts_json) as IntakeFacts;
  if (facts.origin !== "unverified" || hash(facts) !== row.facts_hash) return false;
  return provenInternalMessages(store, row.owner_id).some(
    ({ identity, directory }) =>
      facts.mainAgentId === identity.agentId &&
      canonicalPath(facts.directory) === directory &&
      [identity.messageId, identity.nativeMessageId].includes(facts.messageId) &&
      hash(facts.text) === identity.textHash,
  );
}

export function recordInternalMessageOrigins(
  store: Store,
  main: { agentId: string; directory: string },
  sessionId: string,
  entries: readonly Entry[],
): void {
  store.transaction(() => {
    for (const identity of intakeIdentities(store, main.agentId, sessionId)) {
      if (!identity.nativeMessageId) continue;
      const receipt = store.db
        .prepare("SELECT kind FROM internal_messages WHERE agent_id=? AND message_id=?")
        .get(main.agentId, identity.messageId) as { kind: string } | undefined;
      if (!receipt || !internalReceiptKinds.has(receipt.kind)) continue;
      const matches = entries.filter(
        (entry) =>
          entry.item.type === "user_message" &&
          entry.item.clientMessageId === identity.messageId &&
          entry.item.messageId === identity.nativeMessageId &&
          typeof entry.item.text === "string" &&
          hash(entry.item.text) === identity.textHash,
      );
      if (matches.length > 1) throw Error("INTAKE_INTERNAL_ORIGIN_AMBIGUOUS");
      if (!matches.length) continue;
      const origin: InternalMessageOrigin = {
        identity,
        directory: canonicalPath(main.directory),
        kind: receipt.kind as InternalMessageKind,
      };
      assertInternalOrigin(store, origin);
      const event = `${internalOriginPrefix}${JSON.stringify(origin)}`;
      if (!store.db.prepare("SELECT 1 FROM events WHERE kind=?").get(event)) store.event(event);
    }
  });
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

// Resolve an observed transport alias; receipts and session checks still prove origin.
function resolveObservedNativeEntry<T extends Entry>(entry: T, identities: IntakeIdentity[]): T {
  const item = entry.item;
  if (item.type !== "user_message" || entry.providerMessageId === undefined) return entry;
  if (!nativeId.test(entry.providerMessageId)) return entry;
  if (!item.clientMessageId && item.messageId === entry.providerMessageId) return entry;
  const clientMessageId = item.clientMessageId ?? item.messageId;
  if (
    !clientMessageId ||
    typeof item.text !== "string" ||
    (item.messageId !== clientMessageId && item.messageId !== entry.providerMessageId)
  )
    throw Error("INTAKE_MESSAGE_IDENTITY_AMBIGUOUS");
  const identity = identities.find((candidate) => candidate.messageId === clientMessageId);
  if (
    identity &&
    (identity.textHash !== hash(item.text) ||
      (identity.nativeMessageId && identity.nativeMessageId !== entry.providerMessageId))
  )
    throw Error("INTAKE_MESSAGE_IDENTITY_AMBIGUOUS");
  return { ...entry, item: { ...item, clientMessageId, messageId: entry.providerMessageId } };
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
  const observed = entries.map((entry) => resolveObservedNativeEntry(entry, identities));
  const nativeIds = new Set<string>();
  const clientIds = new Set<string>();
  for (const { item } of observed) {
    if (item.type !== "user_message" || !item.clientMessageId || !item.messageId) continue;
    if (nativeIds.has(item.messageId) || clientIds.has(item.clientMessageId))
      throw Error("INTAKE_MESSAGE_IDENTITY_AMBIGUOUS");
    nativeIds.add(item.messageId);
    clientIds.add(item.clientMessageId);
  }
  const resolved = new Map<T, string>();
  for (const identity of identities) {
    const candidates = observed.filter((entry) => {
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
  const result: T[] = [];
  for (const entry of observed) {
    const clientMessageId = resolved.get(entry);
    result.push(clientMessageId ? { ...entry, item: { ...entry.item, clientMessageId } } : entry);
  }
  return result;
}
