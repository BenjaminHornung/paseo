import type { PaseoApi, PaseoAgentHandle } from "@getpaseo/client";
import path from "node:path";
import { z } from "zod";
import { canonicalPath, contractSchema, hash, type Config, type Contract } from "./contracts.ts";
import { Decisions } from "./decisions.ts";
import {
  effectiveImplementation,
  intakeFactsSchema,
  intakeResultSchema,
  preservesExistingWork,
  type Assessment,
  type Classifier,
  type IntakeFacts,
  type IntakeResult,
  intakeIdentity,
} from "./assessments.ts";
import {
  mainInputInterpretationSchema,
  type MainInputInterpretation,
} from "../paseo-plugin/shared/main-interpretation.ts";
import {
  awaitsMainInterpretation,
  mainInputInterpretation,
  mainInputResult,
  mainIntakeAuthority,
  persistMainInputInterpretation,
  readIntakeAssessment,
  readPackageAssessment,
} from "./main-interpretation.ts";
import { Git } from "./git.ts";
import { Store } from "./store.ts";
import { observedTimeline, timelineReadbackHash, type TimelineObservation } from "./timeline.ts";
import { verifiedProviderSessionId } from "./completion.ts";
import type { IntakeConfirmation } from "../paseo-plugin/shared/intake-confirmation.ts";
import {
  intakeIdentities,
  rememberIntakeIdentity,
  resolveIntakeIdentities,
  isOperatorAdvisorReceipt,
  needsCompleteInternalHistory,
  recordInternalMessageOrigins,
  isProvenInternalIntake,
  provenInternalMessages,
  relevantCaptureIdentities,
  validateOperatorWakeOrigin,
  assertOperatorMainIdle,
  assertOperatorMainSnapshot,
} from "./intake-identity.ts";
import type { OperatorWakeBinding } from "./verification-recovery.ts";

const taskApprovalLinkSchema = z.strictObject({
  agentId: z.string().min(1),
  taskKey: z.string().min(1),
  contractHash: z.string().regex(/^[a-f0-9]{64}$/),
  originalIntakeId: z.string().regex(/^[a-f0-9]{64}$/),
  packageAssessmentId: z.string().regex(/^[a-f0-9]{64}$/),
  packageId: z.string().min(1),
  approvalAssessmentId: z.string().regex(/^[a-f0-9]{64}$/),
  approvalMessageId: z.string().min(1),
  approvalHash: z.string().regex(/^[a-f0-9]{64}$/),
  messageHash: z.string().regex(/^[a-f0-9]{64}$/),
});
type TaskApprovalLink = z.infer<typeof taskApprovalLinkSchema>;
const approvalLinkPrefix = "TASK_APPROVAL_LINK:";

interface ModelAnswerApproval {
  agentId: string;
  assessmentId: string;
  messageId: string;
  assessmentHash: string;
  effectiveResult: IntakeResult;
  confirmation?: IntakeConfirmation;
  supersededPendingSequences?: number[];
}
function modelAnswerApprovals(store: Store): ModelAnswerApproval[] {
  const rows = store.db
    .prepare(
      "SELECT kind FROM events WHERE kind LIKE 'OPERATOR_INTAKE_APPROVED:%' ORDER BY sequence DESC",
    )
    .all() as { kind: string }[];
  return rows.map((row) => JSON.parse(row.kind.slice("OPERATOR_INTAKE_APPROVED:".length)));
}

function approvedOriginal(
  store: Store,
  approval: ModelAnswerApproval,
): Assessment<IntakeResult> | undefined {
  const row = store.db
    .prepare("SELECT result_json FROM assessments WHERE id=? AND owner_id=? AND kind='intake'")
    .get(approval.assessmentId, approval.agentId) as { result_json: string | null } | undefined;
  if (!row?.result_json) return;
  const original = JSON.parse(row.result_json) as Assessment<IntakeResult>;
  return hash(original) === approval.assessmentHash ? original : undefined;
}

export function recordInternalMessage(
  store: Store,
  agentId: string,
  messageId: string,
  kind: string,
): void {
  store.db
    .prepare("INSERT OR IGNORE INTO internal_messages VALUES(?,?,?)")
    .run(agentId, messageId, kind);
}
export function markIntakeClassificationPending(
  store: Store,
  agentId: string,
  messageId: string,
): void {
  const kind = `INTAKE_CLASSIFICATION_PENDING:${agentId}:${hash(messageId)}`;
  if (!store.db.prepare("SELECT 1 FROM events WHERE kind=?").get(kind)) store.event(kind);
}
function settleIntakeClassification(store: Store, agentId: string, messageId: string): void {
  const pending = `INTAKE_CLASSIFICATION_PENDING:${agentId}:${hash(messageId)}`;
  const settled = `INTAKE_CLASSIFICATION_SETTLED:${agentId}:${hash(messageId)}`;
  const row = store.db
    .prepare("SELECT sequence FROM events WHERE kind=? ORDER BY sequence DESC LIMIT 1")
    .get(pending) as { sequence: number } | undefined;
  if (
    row &&
    !store.db.prepare("SELECT 1 FROM events WHERE kind=? AND sequence>?").get(settled, row.sequence)
  )
    store.event(settled);
}
export function timelineCheckpointIndex(
  entries: readonly {
    seqStart: number;
    seqEnd: number;
    item: { type: string; clientMessageId?: string; messageId?: string };
  }[],
  checkpoint: string | null,
): number {
  if (!checkpoint) return -1;
  const anchor = checkpoint.match(/^cursor:(.+):(\d+)$/);
  const matches = entries.filter((entry) =>
    anchor
      ? entry.seqStart <= Number(anchor[2]) && entry.seqEnd >= Number(anchor[2])
      : entry.item.type === "user_message" &&
        (entry.item.clientMessageId === checkpoint || entry.item.messageId === checkpoint),
  );
  if (matches.length > 1) throw Error("INTAKE_MESSAGE_IDENTITY_AMBIGUOUS");
  return matches.length ? entries.indexOf(matches[0]!) : -1;
}
export async function observeOperatorWake(
  store: Store,
  paseo: PaseoApi,
  binding: OperatorWakeBinding,
): Promise<void> {
  const origin = validateOperatorWakeOrigin(store, binding);
  const checkpoint = store.db
    .prepare("SELECT message_id,work_intake_id FROM main_checkpoints WHERE agent_id=?")
    .get(binding.mainAgentId);
  if (!checkpoint?.message_id || checkpoint.work_intake_id !== binding.workIntakeId)
    throw Error("OPERATOR_WAKE_WORK_CHANGED");
  const handle = paseo.agents.ref(binding.mainAgentId);
  await assertOperatorMainIdle(handle, binding);
  const history = await observedTimeline(handle, "projected");
  await assertOperatorMainIdle(handle, binding);
  // Keep the final history read after every metadata/process await. A changed
  // input window is a wait, never an implicit extension of operator authority.
  const fresh = await observedTimeline(handle, "projected");
  assertOperatorMainSnapshot(fresh.agent ? handle.current() : null, binding);
  if (timelineReadbackHash(fresh) !== timelineReadbackHash(history))
    throw Error("VERIFICATION_RECOVERY_UNCAPTURED_INPUT");
  const proven = provenInternalMessages(store, binding.mainAgentId).filter(
    (item) => item.identity.sessionId === binding.sessionId,
  );
  const origins = [...proven, origin];
  const identities = intakeIdentities(store, binding.mainAgentId, binding.sessionId).filter(
    (identity) => !origins.some((item) => item.identity.messageId === identity.messageId),
  );
  identities.push(...origins.map((item) => item.identity));
  const direct = resolveIntakeIdentities(fresh.entries, identities, false);
  const relevant = relevantCaptureIdentities(store, {
    identities,
    entries: direct,
    checkpointEntry: direct[timelineCheckpointIndex(direct, String(checkpoint.message_id))],
  });
  const entries = resolveIntakeIdentities(fresh.entries, relevant, !fresh.hasOlder);
  const matching = entries.filter(
    (entry) =>
      entry.item.type === "user_message" &&
      entry.item.messageId === binding.nativeMessageId &&
      hash(entry.item.text) === binding.textHash,
  );
  const wake = matching[0]?.item;
  if (fresh.hasOlder || matching.length !== 1 || wake?.type !== "user_message")
    throw Error("VERIFICATION_RECOVERY_ORIGIN_UNOBSERVED");
  if (wake.clientMessageId !== binding.receiptId) throw Error("INTAKE_MESSAGE_IDENTITY_AMBIGUOUS");
  const checkpointIndex = timelineCheckpointIndex(entries, String(checkpoint.message_id));
  if (checkpointIndex < 0) throw Error("INTAKE_HISTORY_GAP");
  const anchor = String(checkpoint.message_id).match(/^cursor:(.+):(\d+)$/);
  if (anchor && fresh.endCursor?.epoch !== anchor[1]) throw Error("INTAKE_HISTORY_EPOCH_CHANGED");
  for (const entry of entries.slice(checkpointIndex + 1)) {
    const item = entry.item;
    if (item.type !== "user_message") continue;
    const internal = origins.some(
      ({ identity, directory }) =>
        identity.messageId === item.clientMessageId &&
        identity.nativeMessageId === item.messageId &&
        identity.textHash === hash(item.text) &&
        directory === canonicalPath(binding.directory),
    );
    if (!internal) throw Error("VERIFICATION_RECOVERY_UNCAPTURED_INPUT");
  }
}
export function abandonHumanInput(store: Store, agentId: string, messageId: string): void {
  store.transaction(() => {
    store.db
      .prepare(
        "UPDATE internal_messages SET kind='abandoned:'||kind WHERE agent_id=? AND message_id=? AND kind LIKE 'human:%'",
      )
      .run(agentId, messageId);
    const pending = store.db
      .prepare(
        "SELECT id,facts_hash FROM assessments WHERE owner_id=? AND kind='intake' AND json_extract(facts_json,'$.messageId')=? AND result_json IS NULL",
      )
      .all(agentId, messageId) as { id: string; facts_hash: string }[];
    for (const row of pending) {
      const version = "intake-v3";
      const result: Assessment<IntakeResult> = {
        id: row.id,
        kind: "intake",
        factsHash: row.facts_hash,
        version,
        source: "fallback",
        reason: "INPUT_ABANDONED",
        result: {
          intent: "other",
          needExplorer: false,
          needPlanner: false,
          needAdvisor: false,
          needImplementation: false,
          extraReviewRecommended: false,
        },
      };
      store.db
        .prepare(
          "UPDATE assessments SET result_json=?,state='SETTLED' WHERE id=? AND result_json IS NULL",
        )
        .run(JSON.stringify(result), row.id);
      store.db
        .prepare(
          "UPDATE decision_calls SET state='UNKNOWN',error_kind='INPUT_ABANDONED' WHERE key=? AND state='PENDING'",
        )
        .run(hash({ id: row.id, version }));
    }
    store.db
      .prepare("UPDATE main_checkpoints SET work_intake_id=NULL WHERE agent_id=?")
      .run(agentId);
    settleIntakeClassification(store, agentId, messageId);
  });
}
export async function captureHumanIntake(
  store: Store,
  config: Config,
  paseo: PaseoApi,
  main: { agentId: string; directory: string; requestId?: string; wake?: { messageId: string } },
  classifier: Classifier = new Decisions(store),
) {
  const handle = paseo.agents.ref(main.agentId),
    snapshot = (await handle.refresh())?.agent;
  if (
    !snapshot ||
    canonicalPath(snapshot.cwd) !== canonicalPath(main.directory) ||
    snapshot.provider.split("/")[0] !== "codex"
  )
    throw Error("INTAKE_MAIN_IDENTITY_MISMATCH");
  if (main.requestId) recordInternalMessage(store, main.agentId, main.requestId, "activation");
  if (main.wake) recordInternalMessage(store, main.agentId, main.wake.messageId, "wake");
  const abandoned = store.db
    .prepare(
      "SELECT id,facts_json FROM assessments WHERE owner_id=? AND kind='intake' AND result_json IS NULL AND created_ms<?",
    )
    .all(main.agentId, Date.now() - (config.decisions?.timeoutMs ?? 10000) - 15000) as {
    id: string;
    facts_json: string;
  }[];
  const checkpoint = store.db
    .prepare("SELECT message_id,work_intake_id FROM main_checkpoints WHERE agent_id=?")
    .get(main.agentId) as { message_id: string | null; work_intake_id: string | null } | undefined;
  const sessionId = await verifiedProviderSessionId(handle);
  const emptyBaseline = checkpoint?.message_id?.startsWith("empty:");
  if (emptyBaseline && checkpoint?.message_id !== `empty:${sessionId}`)
    throw Error("INTAKE_HISTORY_SESSION_CHANGED");
  const operatorOrigins = provenInternalMessages(store, main.agentId).filter(
    (origin) => origin.provenance === "operator" && origin.identity.sessionId === sessionId,
  );
  const identities = intakeIdentities(store, main.agentId, sessionId).filter(
    (identity) =>
      !operatorOrigins.some((origin) => origin.identity.messageId === identity.messageId),
  );
  identities.push(...operatorOrigins.map((origin) => origin.identity));
  const anchor = checkpoint?.message_id?.match(/^cursor:(.+):(\d+)$/);
  const receiptEvents = store.db
    .prepare("SELECT at_ms,kind FROM events WHERE kind LIKE 'HUMAN_INPUT_RECEIPT:%' AND at_ms<?")
    .all(Date.now() - 120000) as { at_ms: number; kind: string }[];
  const staleReceipts = receiptEvents
    .map(
      (row) =>
        JSON.parse(row.kind.slice("HUMAN_INPUT_RECEIPT:".length)) as {
          agentId: string;
          messageId: string;
        },
    )
    .filter(
      (receipt) =>
        receipt.agentId === main.agentId &&
        store.db
          .prepare(
            "SELECT 1 FROM internal_messages WHERE agent_id=? AND message_id=? AND kind LIKE 'human:%'",
          )
          .get(main.agentId, receipt.messageId) &&
        !store.db
          .prepare(
            "SELECT 1 FROM assessments WHERE owner_id=? AND kind='intake' AND json_extract(facts_json,'$.messageId')=?",
          )
          .get(main.agentId, receipt.messageId),
    );
  const identitiesForCapture = (entries: TimelineObservation["entries"]) => {
    const directEntries = resolveIntakeIdentities(entries, identities, false);
    const index = timelineCheckpointIndex(directEntries, checkpoint?.message_id ?? null);
    return relevantCaptureIdentities(store, {
      identities,
      entries: directEntries,
      checkpointEntry: directEntries[index],
    });
  };
  let reached: ((entries: TimelineObservation["entries"]) => boolean) | undefined;
  if (!emptyBaseline && !staleReceipts.length) {
    if (checkpoint?.message_id) {
      const checkpointId = checkpoint.message_id;
      reached = (entries) => {
        const relevant = identitiesForCapture(entries);
        return (
          !needsCompleteInternalHistory(store, relevant, entries) &&
          timelineCheckpointIndex(
            resolveIntakeIdentities(entries, relevant, false),
            checkpointId,
          ) >= 0
        );
      };
    } else if (!checkpoint) {
      reached = (entries) =>
        !needsCompleteInternalHistory(store, identitiesForCapture(entries), entries);
    }
  }
  const timeline = await observedTimeline(handle, "projected", reached);
  const relevant = identitiesForCapture(timeline.entries);
  let entries = resolveIntakeIdentities(timeline.entries, relevant, !timeline.hasOlder);
  if (anchor && timeline.endCursor && timeline.endCursor.epoch !== anchor[1])
    throw Error("INTAKE_HISTORY_EPOCH_CHANGED");
  let checkpointEntry: (typeof entries)[number] | undefined;
  let checkpointIndex = -1;
  if (checkpoint?.message_id && !emptyBaseline) {
    checkpointIndex = timelineCheckpointIndex(entries, checkpoint.message_id);
    if (checkpointIndex < 0) throw Error("INTAKE_HISTORY_GAP");
    checkpointEntry = entries[checkpointIndex];
  }
  const newInternalAlias = entries.some(
    ({ item }) =>
      item.type === "user_message" &&
      item.clientMessageId &&
      item.messageId &&
      item.clientMessageId !== item.messageId &&
      store.db
        .prepare("SELECT 1 FROM internal_messages WHERE agent_id=? AND message_id=?")
        .get(main.agentId, item.clientMessageId) &&
      !identities.some(
        (identity) =>
          identity.messageId === item.clientMessageId &&
          identity.nativeMessageId === item.messageId,
      ),
  );
  if (newInternalAlias && (await verifiedProviderSessionId(handle)) !== sessionId)
    throw Error("INTAKE_HISTORY_SESSION_CHANGED");
  if (!timeline.hasOlder && snapshot.status === "idle" && !snapshot.activeTurn) {
    for (const receipt of staleReceipts) {
      if (
        !entries.some(
          (entry) =>
            entry.item.type === "user_message" &&
            (entry.item.clientMessageId ?? entry.item.messageId) === receipt.messageId,
        )
      ) {
        abandonHumanInput(store, main.agentId, receipt.messageId);
        store.event(`UNSENT_INPUT_ABANDONED:${main.agentId}:${receipt.messageId}`);
      }
    }
  }
  for (const entry of entries) {
    const item = entry.item;
    if (item.type !== "user_message") continue;
    const messageId = item.clientMessageId ?? item.messageId;
    if (operatorOrigins.some((origin) => origin.identity.messageId === messageId)) continue;
    if (
      !messageId ||
      !sessionId ||
      !entry.timestamp ||
      !store.db
        .prepare("SELECT 1 FROM internal_messages WHERE agent_id=? AND message_id=?")
        .get(main.agentId, messageId)
    )
      continue;
    rememberIntakeIdentity(store, {
      agentId: main.agentId,
      sessionId,
      messageId,
      timestamp: entry.timestamp,
      textHash: hash(item.text),
      ...(item.messageId && item.messageId !== messageId
        ? { nativeMessageId: item.messageId }
        : {}),
    });
  }
  recordInternalMessageOrigins(store, main, sessionId, entries);
  for (const row of abandoned)
    if (!isProvenInternalIntake(store, row.id))
      await classifier.classifyIntake(intakeFactsSchema.parse(JSON.parse(row.facts_json)), config);
  entries = entries.slice(checkpointIndex + 1);
  const humanEntries = entries.filter((entry) => {
    const item = entry.item;
    return (
      item.type === "user_message" &&
      !store.db
        .prepare(
          "SELECT 1 FROM internal_messages WHERE agent_id=? AND message_id=? AND kind NOT LIKE 'human:%' AND kind NOT LIKE 'operator-readonly-advisor:%'",
        )
        .get(main.agentId, item.clientMessageId ?? item.messageId ?? "")
    );
  });
  if (!humanEntries.length && checkpointEntry?.item.type === "user_message") {
    const prior = store.db
      .prepare(
        "SELECT facts_json,result_json FROM assessments WHERE owner_id=? AND kind='intake' ORDER BY rowid DESC LIMIT 1",
      )
      .get(main.agentId) as { facts_json: string; result_json: string | null } | undefined;
    if (prior?.result_json) {
      const cached = JSON.parse(prior.result_json) as Assessment<IntakeResult>;
      const frozenFacts = intakeFactsSchema.parse(JSON.parse(prior.facts_json));
      const localDenial =
        cached.source === "fallback" && cached.reason === "DECISIONS_SCOPE_BLOCKED";
      let unboundRecovery = false;
      if (
        cached.source === "decisions" &&
        cached.result.needImplementation &&
        ["new-task", "change-request"].includes(cached.result.intent) &&
        checkpoint?.work_intake_id !== cached.id
      ) {
        const audits = store.db
          .prepare(
            "SELECT kind FROM events WHERE kind LIKE 'DECISIONS_LOCAL_SCOPE_DENIAL_REOPENED:%'",
          )
          .all() as { kind: string }[];
        unboundRecovery = audits.some(({ kind }) => {
          const previous = JSON.parse(kind.slice(kind.indexOf(":") + 1)).previous;
          return (
            previous.id === cached.id &&
            previous.owner_id === main.agentId &&
            previous.facts_hash === cached.factsHash
          );
        });
      }
      if (
        (localDenial || unboundRecovery) &&
        frozenFacts.messageId === checkpoint?.message_id &&
        frozenFacts.text === checkpointEntry.item.text
      ) {
        assertIntakeSettled(store, main.agentId);
        humanEntries.push(checkpointEntry);
      }
    }
  }
  let start = checkpoint ? 0 : Math.max(0, humanEntries.length - 1);
  let latest: Assessment<IntakeResult> | undefined;
  for (const entry of humanEntries.slice(start)) {
    const item = entry.item;
    if (item.type !== "user_message") continue;
    const messageId = item.clientMessageId ?? item.messageId;
    if (!messageId) throw Error("INTAKE_STABLE_MESSAGE_ID_UNAVAILABLE");
    const receipt = store.db
      .prepare("SELECT kind FROM internal_messages WHERE agent_id=? AND message_id=?")
      .get(main.agentId, messageId) as { kind: string } | undefined;
    if (
      receipt &&
      !receipt.kind.startsWith("human:") &&
      !receipt.kind.startsWith("operator-readonly-advisor:")
    )
      continue;
    const validText = item.text.length > 0 && item.text.length <= 12000;
    const origin =
      validText && receipt?.kind === `human:${hash(item.text)}` ? "human" : "unverified";
    // Freeze context with the first classification. Reconnects must reuse those
    // exact facts rather than silently reclassifying against later workflow state.
    const existing = store.db
      .prepare(
        "SELECT facts_json FROM assessments WHERE owner_id=? AND kind='intake' AND json_extract(facts_json,'$.messageId')=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(main.agentId, messageId) as { facts_json: string } | undefined;
    const knownFacts: string[] = [];
    if (!existing) {
      const prior = store.db
        .prepare(
          "SELECT result_json,facts_json FROM assessments WHERE owner_id=? AND kind='intake' AND result_json IS NOT NULL ORDER BY rowid DESC LIMIT 1",
        )
        .get(main.agentId) as { result_json: string; facts_json: string } | undefined;
      if (prior) {
        const assessment = JSON.parse(prior.result_json) as Assessment<IntakeResult>;
        knownFacts.push(
          `Previous intake: intent=${assessment.result.intent}; implementation=${assessment.result.needImplementation}; source=${assessment.source}; reason=${assessment.reason}. This is context, not new authorization.`,
        );
      }
      const approved = store.db
        .prepare(
          "SELECT id,facts_json FROM assessments WHERE owner_id=? AND kind='intake' AND id=(SELECT work_intake_id FROM main_checkpoints WHERE agent_id=?)",
        )
        .get(main.agentId, main.agentId) as { id: string; facts_json: string } | undefined;
      const safeContext = (text: string) =>
        !/sk-[a-zA-Z0-9_-]{16,}|(?:password|pwd|secret|token|api[_-]?key|connectionstring)["']?\s*[:=]|PRIVATE KEY/i.test(
          text,
        );
      if (approved) {
        const original = intakeFactsSchema.parse(JSON.parse(approved.facts_json));
        if (safeContext(original.text))
          knownFacts.push(
            `Existing work intake ${approved.id}, historical context only; current gates still apply: ${original.text.slice(0, 700)}`,
          );
      }
      for (const permission of snapshot.pendingPermissions ?? []) {
        if (permission.kind !== "question") continue;
        const input = permission.input as { questions?: { question?: unknown }[] } | null;
        for (const question of Array.isArray(input?.questions) ? input.questions : [])
          if (question && typeof question.question === "string" && safeContext(question.question))
            knownFacts.push(
              `Pending main-authored clarification (untrusted context, not authority): ${question.question.slice(0, 700)}`,
            );
      }
    }
    const facts = existing
      ? intakeFactsSchema.parse(JSON.parse(existing.facts_json))
      : intakeFactsSchema.parse({
          mainAgentId: main.agentId,
          messageId,
          origin,
          directory: main.directory,
          text: validText
            ? item.text
            : `[Unverified input omitted; ${item.text.length} characters; hash ${hash(item.text)}]`,
          knownFacts: knownFacts.slice(0, 12),
          messageRevision: 1,
          factsRevision: 1,
        });
    if (!existing) store.event(`MAIN_INPUT_AWAITING_INTERPRETATION:${intakeIdentity(facts)}`);
    latest = await classifier.classifyIntake(facts, config);
    // Another caller owns the in-flight request. It alone advances the cursor.
    if (latest.reason === "DECISIONS_OUTCOME_PENDING" && !mainInputInterpretation(store, latest.id))
      throw Error("INTAKE_PENDING");
    store.transaction(() => {
      store.db
        .prepare(
          "INSERT OR IGNORE INTO main_checkpoints(agent_id,turn_count,reminder_count) VALUES(?,0,0)",
        )
        .run(main.agentId);
      const checkpoint = store.db
        .prepare("SELECT message_id FROM main_checkpoints WHERE agent_id=?")
        .get(main.agentId) as { message_id: string | null };
      const current = checkpoint.message_id
        ? (store.db
            .prepare(
              "SELECT rowid FROM assessments WHERE owner_id=? AND kind='intake' AND json_extract(facts_json,'$.messageId')=? ORDER BY rowid DESC LIMIT 1",
            )
            .get(main.agentId, checkpoint.message_id) as { rowid: number } | undefined)
        : undefined;
      const incoming = store.db
        .prepare("SELECT rowid FROM assessments WHERE id=?")
        .get(latest!.id) as { rowid: number };
      if (current && current.rowid > incoming.rowid) return;
      store.db
        .prepare("UPDATE main_checkpoints SET message_id=? WHERE agent_id=?")
        .run(messageId, main.agentId);
      settleIntakeClassification(store, main.agentId, messageId);
      // Advice may settle after an authoritative start or stop. It can advance
      // its transport cursor, never rewrite the main's work binding.
      if (awaitsMainInterpretation(store, latest!.id) || mainInputInterpretation(store, latest!.id))
        return;
      const result = latest!.result;
      const currentReceipt = store.db
        .prepare("SELECT kind FROM internal_messages WHERE agent_id=? AND message_id=?")
        .get(main.agentId, messageId) as { kind: string } | undefined;
      const confirmed = origin === "human" && currentReceipt?.kind === `human:${hash(item.text)}`;
      const awaitingOperatorClassification =
        latest!.source === "fallback" && latest!.reason === "DECISIONS_LOW_CONFIDENCE";
      if (
        (!awaitingOperatorClassification &&
          !preservesExistingWork(latest!) &&
          ["cancel", "other", "new-task", "change-request", "review-request"].includes(
            result.intent,
          )) ||
        isOperatorAdvisorReceipt(store, main.agentId, messageId, item.text)
      )
        store.db
          .prepare("UPDATE main_checkpoints SET work_intake_id=NULL WHERE agent_id=?")
          .run(main.agentId);
      if (
        confirmed &&
        result.needImplementation &&
        ["new-task", "change-request"].includes(result.intent)
      )
        store.db
          .prepare("UPDATE main_checkpoints SET work_intake_id=? WHERE agent_id=?")
          .run(latest!.id, main.agentId);
    });
  }
  if (!latest) {
    const prior = latestIntakeInput(store, main.agentId);
    if (prior) latest = readIntakeAssessment(store, prior.id);
  }
  return effectiveIntakeAssessment(store, latest);
}
export function currentIntake(
  store: Store,
  agentId: string,
  forMutation: boolean,
): Assessment<IntakeResult> {
  assertIntakeSettled(store, agentId);
  const checkpoint = store.db
    .prepare("SELECT message_id,work_intake_id FROM main_checkpoints WHERE agent_id=?")
    .get(agentId) as { message_id: string | null; work_intake_id: string | null } | undefined;
  const row =
    forMutation && checkpoint?.work_intake_id
      ? store.db
          .prepare("SELECT id FROM assessments WHERE id=? AND owner_id=?")
          .get(checkpoint.work_intake_id, agentId)
      : latestIntakeInput(store, agentId);
  const value = row as { id: string } | undefined;
  if (!value) throw Error("INTAKE_CLASSIFICATION_REQUIRED");
  const assessment = effectiveIntakeAssessment(store, readIntakeAssessment(store, value.id));
  const origin = store.db
    .prepare("SELECT facts_json FROM assessments WHERE id=?")
    .get(assessment.id) as { facts_json: string };
  const facts = intakeFactsSchema.parse(JSON.parse(origin.facts_json));
  assertHumanReceipt(store, facts, !forMutation);
  if (forMutation && checkpoint?.work_intake_id) {
    const following = store.db
      .prepare(
        "SELECT id FROM assessments WHERE owner_id=? AND kind='intake' AND rowid>(SELECT rowid FROM assessments WHERE id=?) ORDER BY rowid",
      )
      .all(agentId, assessment.id) as { id: string }[];
    for (const followingRow of following) {
      if (isProvenInternalIntake(store, followingRow.id)) continue;
      const latest = effectiveIntakeAssessment(store, readIntakeAssessment(store, followingRow.id));
      if (latest.id === assessment.id) continue;
      const latestFactsRow = store.db
        .prepare("SELECT facts_json FROM assessments WHERE id=?")
        .get(latest.id) as { facts_json: string };
      const latestFacts = intakeFactsSchema.parse(JSON.parse(latestFactsRow.facts_json));
      assertHumanReceipt(store, latestFacts);
      if (canonicalPath(latestFacts.directory) !== canonicalPath(facts.directory))
        throw Error("INTAKE_DIRECTORY_MISMATCH");
      const isInformational = preservesExistingWork(latest);
      // An accepted task approval does not replace or revoke the original
      // objective. Dispatch, continuation and verification check task-specific
      // owner approval separately.
      const isTaskApproval =
        latest.result.intent === "approval" &&
        latest.result.needImplementation &&
        ["decisions", "operator-confirmed", "main"].includes(latest.source);
      if (latest.id !== assessment.id && !isInformational && !isTaskApproval) {
        if (latest.result.intent === "approval" && latest.result.needImplementation)
          throw Error("APPROVAL_TARGET_REQUIRED");
        throw Error("INTAKE_SUPERSEDED");
      }
    }
  }
  if (
    forMutation &&
    (!checkpoint?.work_intake_id ||
      !assessment.result.needImplementation ||
      !["decisions", "operator-confirmed", "main"].includes(assessment.source))
  )
    throw Error("INTAKE_IMPLEMENTATION_NOT_AUTHORIZED");
  return assessment;
}

interface MainInputRow {
  id: string;
  facts_hash: string;
  facts_json: string;
  state: string;
}
function latestIntakeInput(store: Store, agentId: string): MainInputRow | undefined {
  const rows = store.db
    .prepare(
      "SELECT id,facts_hash,facts_json,state FROM assessments WHERE owner_id=? AND kind='intake' ORDER BY created_ms DESC,rowid DESC",
    )
    .all(agentId) as unknown as MainInputRow[];
  return rows.find((row) => !isProvenInternalIntake(store, row.id));
}
export function currentMainInput(store: Store, agentId: string) {
  const row = latestIntakeInput(store, agentId);
  if (!row) return undefined;
  const facts = intakeFactsSchema.parse(JSON.parse(row.facts_json));
  const checkpoint = store.db
    .prepare("SELECT work_intake_id FROM main_checkpoints WHERE agent_id=?")
    .get(agentId) as { work_intake_id: string | null } | undefined;
  return {
    intakeId: row.id,
    factsHash: row.facts_hash,
    messageId: facts.messageId,
    origin: facts.origin,
    previousWorkIntakeId: checkpoint?.work_intake_id ?? null,
    adviceState: row.state,
    interpretation: mainInputInterpretation(store, row.id),
  };
}

export async function observeMainInput(
  store: Store,
  config: Config,
  paseo: PaseoApi,
  main: { agentId: string; directory: string },
  classifier: Classifier,
) {
  try {
    await captureHumanIntake(store, config, paseo, main, classifier);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !["INTAKE_PENDING", "MAIN_INPUT_INTERPRETATION_REQUIRED"].includes(error.message)
    )
      throw error;
  }
  return currentMainInput(store, main.agentId);
}

function validateMainTarget(
  store: Store,
  config: Config,
  main: { agentId: string; taskKeys: readonly string[] },
  interpretation: MainInputInterpretation,
): void {
  const target = interpretation.target;
  if (!target) {
    if (
      interpretation.action === "change" &&
      main.taskKeys.some((key) => {
        const task = store.task(key);
        return (
          task && JSON.parse(task.contract_json).intakeId === interpretation.previousWorkIntakeId
        );
      })
    )
      throw Error("MAIN_TARGET_REQUIRED");
    return;
  }
  if (!main.taskKeys.includes(target.taskKey)) throw Error("MAIN_TARGET_NOT_OWNED");
  const task = store.task(target.taskKey);
  if (
    !task ||
    task.contract_hash !== target.contractHash ||
    hash(JSON.parse(task.contract_json)) !== target.contractHash
  )
    throw Error("MAIN_TARGET_CONTRACT_CHANGED");
  const contract = contractSchema.parse(JSON.parse(task.contract_json));
  if (
    contract.intakeId !== interpretation.previousWorkIntakeId ||
    contract.packageAssessmentId !== target.packageAssessmentId
  )
    throw Error("MAIN_TARGET_BINDING_CHANGED");
  if (
    target.diffHash &&
    new Git(config.gitExecutable).snapshot(contract).diffHash !== target.diffHash
  )
    throw Error("MAIN_TARGET_DIFF_CHANGED");
}

export function interpretMainInput(
  store: Store,
  config: Config,
  main: { agentId: string; directory: string; taskKeys: readonly string[] },
  input: MainInputInterpretation,
) {
  const interpretation = mainInputInterpretationSchema.parse(input);
  return store.transaction(() => {
    const current = currentMainInput(store, main.agentId);
    if (
      !current ||
      current.intakeId !== interpretation.intakeId ||
      current.factsHash !== interpretation.factsHash
    )
      throw Error("MAIN_INPUT_FACTS_CHANGED");
    const row = store.db
      .prepare("SELECT facts_json FROM assessments WHERE id=? AND owner_id=? AND kind='intake'")
      .get(interpretation.intakeId, main.agentId) as { facts_json: string };
    const facts = intakeFactsSchema.parse(JSON.parse(row.facts_json));
    if (facts.mainAgentId !== main.agentId) throw Error("MAIN_INPUT_OWNER_MISMATCH");
    if (hash(facts) !== interpretation.factsHash) throw Error("MAIN_INPUT_FACTS_CHANGED");
    assertHumanReceipt(store, facts);
    if (canonicalPath(facts.directory) !== canonicalPath(main.directory))
      throw Error("INTAKE_DIRECTORY_MISMATCH");
    const receipts = store.db
      .prepare(
        "SELECT kind FROM events WHERE kind LIKE 'HUMAN_INPUT_RECEIPT:%' ORDER BY sequence DESC",
      )
      .all() as { kind: string }[];
    const newest = receipts
      .map(({ kind }) => JSON.parse(kind.slice("HUMAN_INPUT_RECEIPT:".length)))
      .find((receipt) => receipt.agentId === main.agentId);
    if (newest && newest.messageId !== facts.messageId) throw Error("MAIN_INPUT_SUPERSEDED");
    if (current.interpretation) {
      if (hash(current.interpretation) !== hash(interpretation))
        throw Error("MAIN_INPUT_INTERPRETATION_CONFLICT");
      return current.interpretation;
    }
    if (current.previousWorkIntakeId !== interpretation.previousWorkIntakeId)
      throw Error("MAIN_WORK_BINDING_CHANGED");
    assertOperatorIntakeCompatibility(store, interpretation);
    validateMainTarget(store, config, main, interpretation);
    persistMainInputInterpretation(store, interpretation);
    if (["question", "status", "continue", "approve"].includes(interpretation.action)) {
      if (interpretation.previousWorkIntakeId) currentIntake(store, main.agentId, true);
      else if (["continue", "approve"].includes(interpretation.action))
        throw Error("CONTINUATION_AUTHORIZATION_MISSING");
    }
    let workIntakeId = interpretation.previousWorkIntakeId;
    if (["start", "change"].includes(interpretation.action)) workIntakeId = interpretation.intakeId;
    if (["plan", "review", "stop"].includes(interpretation.action)) workIntakeId = null;
    store.db
      .prepare("INSERT OR IGNORE INTO main_checkpoints(agent_id) VALUES(?)")
      .run(main.agentId);
    store.db
      .prepare("UPDATE main_checkpoints SET work_intake_id=? WHERE agent_id=?")
      .run(workIntakeId, main.agentId);
    return interpretation;
  });
}

function assertOperatorIntakeCompatibility(
  store: Store,
  interpretation: MainInputInterpretation,
): void {
  const approvals = modelAnswerApprovals(store);
  if (
    approvals.some(
      (approval) =>
        approval.confirmation?.assessmentId === interpretation.intakeId &&
        approvedOriginal(store, approval),
    )
  )
    throw Error("MAIN_INPUT_ALREADY_OPERATOR_BOUND");
  const approval = approvals.find((value) => value.assessmentId === interpretation.intakeId);
  if (!approval || !approvedOriginal(store, approval)) return;
  const accepted = intakeResultSchema.parse(approval.effectiveResult);
  const result = mainInputResult(interpretation);
  if (
    accepted.intent !== result.intent ||
    accepted.needImplementation !== result.needImplementation
  )
    throw Error("MAIN_INPUT_CONTRADICTS_OPERATOR_CONFIRMATION");
}

export function effectiveIntakeAssessment(
  store: Store,
  assessment: Assessment<IntakeResult>,
): Assessment<IntakeResult>;
export function effectiveIntakeAssessment(
  store: Store,
  assessment: Assessment<IntakeResult> | undefined,
): Assessment<IntakeResult> | undefined;
export function effectiveIntakeAssessment(
  store: Store,
  assessment: Assessment<IntakeResult> | undefined,
): Assessment<IntakeResult> | undefined {
  if (!assessment) return;
  const approvals = modelAnswerApprovals(store);
  const confirmation = approvals.find(
    (row) =>
      row.confirmation?.assessmentId === assessment.id &&
      row.confirmation.assessmentHash === hash(assessment),
  );
  if (confirmation) {
    const original = approvedOriginal(store, confirmation);
    if (original) return effectiveIntakeAssessment(store, original);
  }
  const approval = approvals.find(
    (row) => row.assessmentId === assessment.id && row.assessmentHash === hash(assessment),
  );
  const effective: Assessment<IntakeResult> = approval
    ? {
        ...assessment,
        source: "operator-confirmed",
        reason: "OPERATOR_CONFIRMED_MODEL_ANSWER",
        result: intakeResultSchema.parse(approval.effectiveResult),
      }
    : mainIntakeAuthority(store, assessment);
  if (
    awaitsMainInterpretation(store, assessment.id) &&
    effective.source !== "main" &&
    effective.source !== "operator-confirmed"
  )
    throw Error("MAIN_INPUT_INTERPRETATION_REQUIRED");
  return effective;
}

function allApprovalLinks(store: Store): TaskApprovalLink[] {
  const rows = store.db
    .prepare("SELECT kind FROM events WHERE substr(kind,1,?)=? ORDER BY sequence")
    .all(approvalLinkPrefix.length, approvalLinkPrefix) as { kind: string }[];
  return rows.flatMap((row) => {
    try {
      const link = taskApprovalLinkSchema.parse(
        JSON.parse(row.kind.slice(approvalLinkPrefix.length)),
      );
      return [link];
    } catch {
      return [];
    }
  });
}

function approvalLinks(store: Store, approvalAssessmentId: string): TaskApprovalLink[] {
  return allApprovalLinks(store).filter(
    (link) => link.approvalAssessmentId === approvalAssessmentId,
  );
}

function hasTaskApprovalLink(
  store: Store,
  agentId: string,
  originalIntakeId: string,
  approval: Assessment<IntakeResult>,
): boolean {
  const factsRow = store.db
    .prepare("SELECT facts_json FROM assessments WHERE id=? AND owner_id=?")
    .get(approval.id, agentId) as { facts_json: string } | undefined;
  if (
    !factsRow ||
    !["decisions", "operator-confirmed", "main"].includes(approval.source) ||
    approval.result.intent !== "approval" ||
    !approval.result.needImplementation
  )
    return false;
  const facts = intakeFactsSchema.parse(JSON.parse(factsRow.facts_json));
  try {
    assertHumanReceipt(store, facts);
  } catch {
    return false;
  }
  const links = approvalLinks(store, approval.id);
  return (
    links.length === 1 &&
    links.some(
      (link) =>
        link.agentId === agentId &&
        link.originalIntakeId === originalIntakeId &&
        link.approvalMessageId === facts.messageId &&
        link.approvalHash === hash(approval) &&
        link.messageHash === hash(facts.text),
    )
  );
}

export function hasAuditedOwnerApproval(store: Store, contract: Contract): boolean {
  if (
    !contract.mutation ||
    !contract.highRisk ||
    !contract.intakeId ||
    !contract.packageAssessmentId
  )
    return false;
  const intake = store.db
    .prepare("SELECT owner_id FROM assessments WHERE id=? AND kind='intake'")
    .get(contract.intakeId) as { owner_id: string } | undefined;
  if (!intake) return false;
  let current: Assessment<IntakeResult>;
  try {
    current = currentIntake(store, intake.owner_id, true);
  } catch {
    return false;
  }
  if (current.id !== contract.intakeId) return false;
  const taskKey = `${contract.workflowId}/${contract.taskId}/${contract.role}`;
  return allApprovalLinks(store).some((link) => {
    if (
      link.agentId !== intake.owner_id ||
      link.taskKey !== taskKey ||
      link.contractHash !== hash(contract) ||
      link.originalIntakeId !== contract.intakeId ||
      link.packageAssessmentId !== contract.packageAssessmentId ||
      link.packageId !== `${contract.workflowId}/${contract.taskId}`
    )
      return false;
    const approvalRow = store.db
      .prepare("SELECT id FROM assessments WHERE id=? AND owner_id=? AND kind='intake'")
      .get(link.approvalAssessmentId, intake.owner_id) as { id: string } | undefined;
    if (!approvalRow) return false;
    try {
      return hasTaskApprovalLink(
        store,
        intake.owner_id,
        contract.intakeId!,
        effectiveIntakeAssessment(store, readIntakeAssessment(store, approvalRow.id)),
      );
    } catch {
      return false;
    }
  });
}

export function linkApprovalToOutstandingTask(
  store: Store,
  agentId: string,
  taskKeys: readonly string[],
  approval: Assessment<IntakeResult>,
  requestedTarget: Pick<Contract, "workflowId" | "taskId" | "role">,
): string | undefined {
  return store.transaction(() => {
    const checkpoint = store.db
      .prepare("SELECT work_intake_id FROM main_checkpoints WHERE agent_id=?")
      .get(agentId) as { work_intake_id: string | null } | undefined;
    if (
      !checkpoint?.work_intake_id ||
      !["decisions", "operator-confirmed", "main"].includes(approval.source) ||
      approval.result.intent !== "approval" ||
      !approval.result.needImplementation
    )
      return undefined;
    const factsRow = store.db
      .prepare(
        "SELECT facts_json,created_ms,rowid FROM assessments WHERE id=? AND owner_id=? AND kind='intake'",
      )
      .get(approval.id, agentId) as
      | { facts_json: string; created_ms: number; rowid: number }
      | undefined;
    if (!factsRow) return undefined;
    if (
      currentIntake(store, agentId, true).id !== checkpoint.work_intake_id ||
      hash(currentIntake(store, agentId, false)) !== hash(approval)
    )
      return undefined;
    const approvalFacts = intakeFactsSchema.parse(JSON.parse(factsRow.facts_json));
    assertHumanReceipt(store, approvalFacts);
    const requestedKey = `${requestedTarget.workflowId}/${requestedTarget.taskId}/${requestedTarget.role}`;
    const existingLinks = approvalLinks(store, approval.id);
    if (existingLinks.some((link) => link.taskKey !== requestedKey)) return undefined;
    const candidates = taskKeys.flatMap((taskKey) => {
      if (taskKey !== requestedKey) return [];
      const task = store.task(taskKey);
      if (!task || task.contract_hash !== hash(JSON.parse(task.contract_json))) return [];
      const contract = contractSchema.parse(JSON.parse(task.contract_json)),
        attempt = store.latest(taskKey);
      const pausedWorker =
        task.state === "NEEDS_CONFIRMATION" &&
        attempt?.status === "NEEDS_CONFIRMATION" &&
        !!attempt.agent_id;
      const awaitingOwnerApproval = task.state === "READY" && contract.highRisk && !attempt;
      if (
        !contract.mutation ||
        !contract.role.startsWith("implement-") ||
        contract.intakeId !== checkpoint.work_intake_id ||
        !contract.packageAssessmentId ||
        (!existingLinks.length && !pausedWorker && !awaitingOwnerApproval)
      )
        return [];
      const binding = store.db
        .prepare(
          `SELECT binding.intake_id,binding.package_id,binding.effective_class
          FROM task_assessments AS binding JOIN assessments AS package ON package.id=binding.package_id
          WHERE binding.task_key=? AND binding.created_ms<?
          AND package.owner_id=? AND package.kind='package' AND package.rowid<?`,
        )
        .get(taskKey, factsRow.created_ms, agentId, factsRow.rowid) as
        | { intake_id: string; package_id: string; effective_class: string }
        | undefined;
      if (
        !binding ||
        binding.intake_id !== contract.intakeId ||
        binding.package_id !== contract.packageAssessmentId ||
        binding.effective_class !== contract.role
      )
        return [];
      return [{ taskKey, task, contract, attempt }];
    });
    if (candidates.length !== 1) return undefined;
    const target = candidates[0],
      link: TaskApprovalLink = taskApprovalLinkSchema.parse({
        agentId,
        taskKey: target.taskKey,
        contractHash: target.task.contract_hash,
        originalIntakeId: target.contract.intakeId,
        packageAssessmentId: target.contract.packageAssessmentId,
        packageId: `${target.contract.workflowId}/${target.contract.taskId}`,
        approvalAssessmentId: approval.id,
        approvalMessageId: approvalFacts.messageId,
        approvalHash: hash(approval),
        messageHash: hash(approvalFacts.text),
      });
    const kind = `${approvalLinkPrefix}${JSON.stringify(link)}`;
    if (existingLinks.length) {
      return existingLinks.length === 1 && hash(existingLinks[0]) === hash(link)
        ? target.taskKey
        : undefined;
    }
    store.event(kind, target.attempt?.id ?? null);
    return target.taskKey;
  });
}

// Operator-only confirmation of the model's own low-confidence answer. The
// immutable model response remains available alongside the effective approval.
type ApprovalMainSnapshot = NonNullable<Awaited<ReturnType<PaseoAgentHandle["refresh"]>>>["agent"];
function assertIdleApprovalMain(
  snapshot: ApprovalMainSnapshot | undefined,
  directory: string,
): void {
  if (
    !snapshot ||
    snapshot.status !== "idle" ||
    snapshot.activeTurn ||
    snapshot.pendingPermissions.length
  )
    throw Error("AUTOMATION_MAIN_MUST_BE_IDLE");
  if (
    canonicalPath(snapshot.cwd) !== canonicalPath(directory) ||
    snapshot.provider.split("/")[0] !== "codex"
  )
    throw Error("INTAKE_MAIN_IDENTITY_MISMATCH");
}
export async function approveIntakeModelAnswer(
  store: Store,
  paseo: PaseoApi,
  main: { agentId: string; directory: string },
  request: {
    assessmentId: string;
    messageId: string;
    reason: string;
    confirmation?: IntakeConfirmation;
  },
): Promise<void> {
  const handle = paseo.agents.ref(main.agentId);
  const before = (await handle.refresh())?.agent;
  assertIdleApprovalMain(before, main.directory);
  const sessionId = await verifiedProviderSessionId(handle);
  // The daemon projects genuine agent reports to tool calls. Canonical provider
  // envelopes are transport text and must not be mistaken for new human input.
  const timeline = await observedTimeline(handle, "projected");
  const entries = resolveIntakeIdentities(
    timeline.entries,
    intakeIdentities(store, main.agentId, sessionId),
    !timeline.hasOlder,
  );
  const head = entries.findLast(
    (entry) =>
      entry.item.type === "user_message" &&
      !store.db
        .prepare(
          "SELECT 1 FROM internal_messages WHERE agent_id=? AND message_id=? AND kind NOT LIKE 'human:%' AND kind NOT LIKE 'operator-readonly-advisor:%'",
        )
        .get(main.agentId, entry.item.clientMessageId ?? entry.item.messageId ?? ""),
  );
  const expected = request.confirmation?.messageId ?? request.messageId;
  const row = store.db
    .prepare("SELECT facts_json FROM assessments WHERE id=? AND owner_id=? AND kind='intake'")
    .get(request.confirmation?.assessmentId ?? request.assessmentId, main.agentId) as
    | { facts_json: string }
    | undefined;
  const facts = row ? intakeFactsSchema.parse(JSON.parse(row.facts_json)) : undefined;
  if (
    !head ||
    head.item.type !== "user_message" ||
    (head.item.clientMessageId ?? head.item.messageId) !== expected ||
    !facts ||
    hash(head.item.text) !== hash(facts.text)
  )
    throw Error("INTAKE_APPROVAL_SUPERSEDED");
  const after = (await handle.refresh())?.agent;
  assertIdleApprovalMain(after, main.directory);
  if ((await verifiedProviderSessionId(handle)) !== sessionId)
    throw Error("INTAKE_HISTORY_SESSION_CHANGED");
  approveLowConfidenceIntake(
    store,
    main.agentId,
    request.assessmentId,
    request.messageId,
    request.reason,
    request.confirmation,
  );
}

interface IntakeAssessmentRecord {
  rowid: number;
  id: string;
  facts_json: string;
  result_json: string;
}

function assertApprovalReply(
  store: Store,
  agentId: string,
  original: IntakeAssessmentRecord,
  latest: IntakeAssessmentRecord,
  facts: IntakeFacts,
  confirmation: IntakeConfirmation,
): void {
  const replyFacts = intakeFactsSchema.parse(JSON.parse(latest.facts_json));
  const reply = JSON.parse(latest.result_json) as Assessment<IntakeResult>;
  const intervening = store.db
    .prepare(
      "SELECT 1 FROM assessments WHERE owner_id=? AND kind='intake' AND rowid>? AND rowid<? LIMIT 1",
    )
    .get(agentId, original.rowid, latest.rowid);
  if (
    latest.rowid <= original.rowid ||
    intervening ||
    replyFacts.messageId !== confirmation.messageId ||
    hash(reply) !== confirmation.assessmentHash ||
    reply.reason !== "INTAKE_HUMAN_ORIGIN_UNCONFIRMED" ||
    reply.source !== "fallback" ||
    replyFacts.origin !== "unverified" ||
    replyFacts.directory !== facts.directory
  )
    throw Error("INTAKE_CONFIRMATION_IDENTITY_MISMATCH");
}

function approvedModelAnswer(
  assessment: Assessment<IntakeResult>,
  facts: IntakeFacts,
): IntakeResult {
  const intent = assessment.answers?.find((answer) => answer.name === "intent")?.value;
  if (
    assessment.source !== "fallback" ||
    assessment.reason !== "DECISIONS_LOW_CONFIDENCE" ||
    assessment.answers?.find((answer) => answer.name === "needImplementation")?.value !== true ||
    !["new-task", "change-request", "approval"].includes(String(intent))
  )
    throw Error("INTAKE_MODEL_ANSWER_NOT_APPROVABLE");
  return intakeResultSchema.parse({
    intent,
    needImplementation: true,
    needPlanner: false,
    needAdvisor: false,
    extraReviewRecommended: false,
    needExplorer: /\b[^\s]+\.(?:md|zip|ts|tsx|js|cs|sql)\b|\b[A-Z][A-Z0-9]+-\d+\b/.test(facts.text),
  });
}

export function approveLowConfidenceIntake(
  store: Store,
  agentId: string,
  assessmentId: string,
  messageId: string,
  reason: string,
  confirmation?: IntakeConfirmation,
): void {
  store.transaction(() => {
    const row = store.db
      .prepare(
        "SELECT rowid,id,facts_json,result_json FROM assessments WHERE owner_id=? AND kind='intake' AND id=?",
      )
      .get(agentId, assessmentId) as IntakeAssessmentRecord | undefined;
    const latest = store.db
      .prepare(
        "SELECT rowid,id,facts_json,result_json FROM assessments WHERE owner_id=? AND kind='intake' ORDER BY rowid DESC LIMIT 1",
      )
      .get(agentId) as typeof row;
    const checkpoint = store.db
      .prepare("SELECT message_id,work_intake_id FROM main_checkpoints WHERE agent_id=?")
      .get(agentId) as { message_id: string | null; work_intake_id: string | null } | undefined;
    if (
      !row ||
      !latest ||
      latest.id !== (confirmation?.assessmentId ?? assessmentId) ||
      checkpoint?.message_id !== (confirmation?.messageId ?? messageId)
    )
      throw Error("INTAKE_APPROVAL_SUPERSEDED");
    const facts = intakeFactsSchema.parse(JSON.parse(row.facts_json));
    if (facts.messageId !== messageId || !reason.trim())
      throw Error("INTAKE_APPROVAL_IDENTITY_MISMATCH");
    assertHumanReceipt(store, facts);
    if (confirmation) assertApprovalReply(store, agentId, row, latest, facts, confirmation);
    const assessment = JSON.parse(row.result_json) as Assessment<IntakeResult>;
    const effectiveResult = approvedModelAnswer(assessment, facts);
    // An explicitly confirmed NEW task replaces older, unreceipted legacy
    // observations. A pending decision/receipt or any newer observation still
    // blocks. This records supersession, never a fabricated classification.
    const receiptKind = `HUMAN_INPUT_RECEIPT:${JSON.stringify({ agentId, messageId })}`;
    const receipt = store.db
      .prepare("SELECT sequence FROM events WHERE kind=? ORDER BY sequence LIMIT 1")
      .get(receiptKind) as { sequence: number } | undefined;
    const pendingPrefix = `INTAKE_CLASSIFICATION_PENDING:${agentId}:`;
    const priorPending =
      effectiveResult.intent === "new-task" && receipt
        ? (store.db
            .prepare("SELECT sequence FROM events WHERE substr(kind,1,?)=? AND sequence<?")
            .all(pendingPrefix.length, pendingPrefix, receipt.sequence) as { sequence: number }[])
        : [];
    const supersededPendingSequences = priorPending.map((pending) => pending.sequence);
    assertIntakeSettled(store, agentId, supersededPendingSequences);
    const event = `OPERATOR_INTAKE_APPROVED:${JSON.stringify({ agentId, assessmentId, messageId, assessmentHash: hash(assessment), effectiveResult, reasonHash: hash(reason), ...(confirmation ? { confirmation } : {}), ...(supersededPendingSequences.length ? { supersededPendingSequences } : {}) })}`;
    if (!store.db.prepare("SELECT 1 FROM events WHERE kind=?").get(event)) store.event(event);
    if (effectiveResult.intent !== "approval")
      store.db
        .prepare("UPDATE main_checkpoints SET work_intake_id=? WHERE agent_id=?")
        .run(assessmentId, agentId);
  });
}
function assertHumanReceipt(store: Store, facts: IntakeFacts, allowReadonlyAdvisor = false): void {
  if (
    allowReadonlyAdvisor &&
    facts.origin === "unverified" &&
    isOperatorAdvisorReceipt(store, facts.mainAgentId, facts.messageId, facts.text)
  )
    return;
  const receipt = store.db
    .prepare("SELECT kind FROM internal_messages WHERE agent_id=? AND message_id=?")
    .get(facts.mainAgentId, facts.messageId) as { kind: string } | undefined;
  if (facts.origin !== "human" || receipt?.kind !== `human:${hash(facts.text)}`)
    throw Error("INTAKE_HUMAN_ORIGIN_UNCONFIRMED_USE_PLUGIN_INPUT");
}
// Explicit operator action, deliberately absent from main-agent tools. This
// resumes an already authorized objective after a human clarification; it does
// not approve a new objective, a package, route, writer or failed check.
export function confirmExistingWork(
  store: Store,
  agentId: string,
  messageId: string,
  authorizedIntakeId: string,
  reviewedMessageIds: readonly string[] = [],
): void {
  store.transaction(() => {
    assertIntakeSettled(store, agentId);
    const checkpoint = store.db
      .prepare("SELECT message_id,work_intake_id FROM main_checkpoints WHERE agent_id=?")
      .get(agentId) as { message_id: string | null; work_intake_id: string | null } | undefined;
    if (checkpoint?.message_id !== messageId) throw Error("CONTINUATION_INPUT_SUPERSEDED");
    const current = store.db
      .prepare(
        "SELECT rowid,facts_json,result_json FROM assessments WHERE owner_id=? AND kind='intake' AND json_extract(facts_json,'$.messageId')=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(agentId, messageId) as
      | { rowid: number; facts_json: string; result_json: string }
      | undefined;
    const original = store.db
      .prepare(
        "SELECT rowid,owner_id,facts_json,result_json FROM assessments WHERE id=? AND kind='intake'",
      )
      .get(authorizedIntakeId) as
      | { rowid: number; owner_id: string; facts_json: string; result_json: string }
      | undefined;
    if (!current?.result_json || !original?.result_json || original.owner_id !== agentId)
      throw Error("CONTINUATION_AUTHORIZATION_MISSING");
    const facts = intakeFactsSchema.parse(JSON.parse(current.facts_json)),
      priorFacts = intakeFactsSchema.parse(JSON.parse(original.facts_json));
    assertHumanReceipt(store, facts);
    assertHumanReceipt(store, priorFacts);
    const result = JSON.parse(current.result_json) as Assessment<IntakeResult>,
      prior = JSON.parse(original.result_json) as Assessment<IntakeResult>;
    const existingWorkApproved =
      result.source === "decisions" &&
      result.result.intent === "approval" &&
      result.result.needImplementation;
    const uncertainContinuation =
      result.source === "fallback" && result.reason === "DECISIONS_LOW_CONFIDENCE";
    if (
      (!existingWorkApproved && !uncertainContinuation) ||
      prior.source !== "decisions" ||
      !prior.result.needImplementation ||
      !["new-task", "change-request", "approval"].includes(prior.result.intent) ||
      facts.directory !== priorFacts.directory ||
      original.rowid >= current.rowid
    )
      throw Error("CONTINUATION_NOT_AN_EXISTING_APPROVED_OBJECTIVE");
    const superseded = store.db
      .prepare(`SELECT 1 FROM assessments WHERE owner_id=? AND kind='intake'
      AND rowid>(SELECT rowid FROM assessments WHERE id=?) AND rowid<(SELECT rowid FROM assessments WHERE id=?)
      AND (json_extract(result_json,'$.result.intent')='cancel' OR
        json_extract(result_json,'$.source')='decisions' AND (json_extract(result_json,'$.result.needImplementation')=1 OR
          json_extract(result_json,'$.result.intent') IN ('new-task','change-request'))) LIMIT 1`)
      .get(agentId, authorizedIntakeId, result.id);
    if (superseded) throw Error("CONTINUATION_OBJECTIVE_CANCELLED_OR_REPLACED");
    const ambiguous = store.db
      .prepare(`SELECT json_extract(facts_json,'$.messageId') AS message_id FROM assessments
      WHERE owner_id=? AND kind='intake' AND rowid>? AND rowid<?
      AND json_extract(facts_json,'$.origin')='human' AND json_extract(result_json,'$.source')='fallback'`)
      .all(agentId, original.rowid, current.rowid) as { message_id: string }[];
    if (ambiguous.some((row) => !reviewedMessageIds.includes(row.message_id)))
      throw Error("CONTINUATION_INTERVENING_INPUT_REQUIRES_REVIEW");
    if (checkpoint?.work_intake_id !== authorizedIntakeId)
      throw Error("CONTINUATION_AUTHORIZATION_REVOKED");
    store.event(
      `OPERATOR_CONFIRMED_EXISTING_WORK:${agentId}:${messageId}:${authorizedIntakeId}:${hash(facts.text)}:${JSON.stringify(reviewedMessageIds)}`,
    );
  });
}
function assertIntakeSettled(
  store: Store,
  agentId: string,
  supersedingSequences: number[] = [],
): void {
  const pendingAdvice = store.db
    .prepare(
      "SELECT id FROM assessments WHERE owner_id=? AND kind='intake' AND result_json IS NULL",
    )
    .all(agentId) as { id: string }[];
  const latestInput = currentMainInput(store, agentId);
  const mainResolved = !!latestInput?.interpretation;
  if (
    (!mainResolved &&
      pendingAdvice.some(
        (row) => !isProvenInternalIntake(store, row.id) && !mainInputInterpretation(store, row.id),
      )) ||
    store.db
      .prepare(`SELECT 1 FROM internal_messages receipt WHERE receipt.agent_id=? AND (receipt.kind LIKE 'human:%' OR receipt.kind LIKE 'operator-readonly-advisor:%')
      AND NOT EXISTS(SELECT 1 FROM assessments assessment WHERE assessment.owner_id=receipt.agent_id AND assessment.kind='intake'
        AND json_extract(assessment.facts_json,'$.messageId')=receipt.message_id) LIMIT 1`)
      .get(agentId)
  )
    throw Error("INTAKE_PENDING");
  const pendingPrefix = `INTAKE_CLASSIFICATION_PENDING:${agentId}:`;
  const pending = store.db
    .prepare("SELECT sequence,kind FROM events WHERE substr(kind,1,?)=? ORDER BY sequence")
    .all(pendingPrefix.length, pendingPrefix) as { sequence: number; kind: string }[];
  const approvedSupersession = modelAnswerApprovals(store).filter(
    (approval) =>
      approval.agentId === agentId &&
      approval.effectiveResult.intent === "new-task" &&
      approvedOriginal(store, approval),
  );
  const internalMessages = provenInternalMessages(store, agentId);
  for (const row of pending) {
    if (
      internalMessages.some(
        ({ identity }) =>
          row.kind === `${pendingPrefix}${hash(identity.messageId)}` ||
          row.kind === `${pendingPrefix}${hash(identity.nativeMessageId)}`,
      )
    )
      continue;
    const interpreted = store.db
      .prepare(
        "SELECT id FROM assessments WHERE owner_id=? AND kind='intake' AND json_extract(facts_json,'$.messageId') IS NOT NULL",
      )
      .all(agentId) as { id: string }[];
    if (
      interpreted.some(({ id }) => {
        const value = mainInputInterpretation(store, id);
        if (!value) return false;
        const facts = store.db.prepare("SELECT facts_json FROM assessments WHERE id=?").get(id) as {
          facts_json: string;
        };
        return row.kind === `${pendingPrefix}${hash(JSON.parse(facts.facts_json).messageId)}`;
      })
    )
      continue;
    if (
      supersedingSequences.includes(row.sequence) ||
      approvedSupersession.some((approval) =>
        approval.supersededPendingSequences?.includes(row.sequence),
      )
    )
      continue;
    const settled = row.kind.replace(
      "INTAKE_CLASSIFICATION_PENDING:",
      "INTAKE_CLASSIFICATION_SETTLED:",
    );
    if (
      !store.db
        .prepare("SELECT 1 FROM events WHERE kind=? AND sequence>?")
        .get(settled, row.sequence)
    )
      throw Error("INTAKE_PENDING");
  }
}
export function assertTaskAssessment(store: Store, config: Config, contract: Contract): void {
  if (config.orchestrationVersion !== 3) return;
  if (!contract.intakeId || !contract.packageAssessmentId) throw Error("TASK_ASSESSMENT_REQUIRED");
  const intake = store.db
    .prepare("SELECT owner_id,facts_json,result_json FROM assessments WHERE id=? AND kind='intake'")
    .get(contract.intakeId) as
    | { owner_id: string; facts_json: string; result_json: string | null }
    | undefined;
  const pkg = store.db
    .prepare(
      "SELECT owner_id,facts_json,result_json FROM assessments WHERE id=? AND kind='package'",
    )
    .get(contract.packageAssessmentId) as
    | { owner_id: string; facts_json: string; result_json: string | null }
    | undefined;
  if (!intake || !pkg) throw Error("TASK_ASSESSMENT_REQUIRED");
  if (pkg.owner_id !== intake.owner_id) throw Error("ASSESSMENT_OWNER_MISMATCH");
  assertIntakeSettled(store, intake.owner_id);
  const intakeFacts = JSON.parse(intake.facts_json) as IntakeFacts;
  assertHumanReceipt(store, intakeFacts, !contract.mutation);
  const relative = path.relative(
    canonicalPath(intakeFacts.directory),
    canonicalPath(contract.repository),
  );
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw Error("INTAKE_REPOSITORY_SCOPE_MISMATCH");
  const intakeResult = effectiveIntakeAssessment(
    store,
    readIntakeAssessment(store, contract.intakeId),
  );
  const assessment = readPackageAssessment(store, contract.packageAssessmentId);
  if (!contract.mutation && !["planner", "advisor"].includes(contract.role))
    throw Error("INTAKE_ROLE_NOT_AUTHORIZED");
  if (contract.mutation && currentIntake(store, intake.owner_id, true).id !== contract.intakeId)
    throw Error("INTAKE_SUPERSEDED");
  if (
    !contract.mutation &&
    contract.role === "planner" &&
    !intakeResult.result.needPlanner &&
    !(
      intakeResult.result.needImplementation &&
      ["decisions", "main"].includes(assessment.source) &&
      assessment.result.additionalPlanning
    )
  )
    throw Error("PLANNER_NOT_REQUIRED");
  if (
    !contract.mutation &&
    contract.role === "advisor" &&
    !intakeResult.result.needAdvisor &&
    intakeResult.result.intent !== "review-request" &&
    !(
      intakeResult.result.needImplementation &&
      ["decisions", "main"].includes(assessment.source) &&
      assessment.result.advisorNeeded
    )
  )
    throw Error("ADVISOR_NOT_REQUIRED");
  const facts = JSON.parse(pkg.facts_json) as {
    intakeId: string;
    packageId: string;
    packageRevision?: number;
    amendsTaskKey?: string;
    amendsContractHash?: string;
    amendsDiffHash?: string;
    goal: string;
    files: string[];
    acceptance: string[];
    repository: string;
    baseCommit: string;
    dataScope?: string;
    risks?: string[];
    checks?: Contract["checks"];
    mutation?: boolean;
    uiChanged?: boolean;
  };
  if (
    facts.packageId !== `${contract.workflowId}/${contract.taskId}` ||
    !contract.workflowId.startsWith(`auto-${hash(intake.owner_id).slice(0, 12)}-`)
  )
    throw Error("PACKAGE_IDENTITY_MISMATCH");
  if (
    facts.intakeId !== contract.intakeId ||
    facts.packageRevision !== (contract.packageRevision ?? 1) ||
    facts.amendsTaskKey !== contract.amendsTaskKey ||
    facts.amendsContractHash !== contract.amendsContractHash ||
    facts.amendsDiffHash !== contract.amendsDiffHash ||
    hash(facts.acceptance) !== hash(contract.acceptance) ||
    hash(facts.files) !== hash(contract.allowedPaths) ||
    facts.goal !== contract.prompt ||
    facts.repository !== contract.repository ||
    facts.baseCommit !== contract.baseCommit
  )
    throw Error("PACKAGE_FACTS_MISMATCH");
  if (
    facts.checks &&
    (hash(facts.checks) !== hash(contract.checks) ||
      facts.mutation !== contract.mutation ||
      facts.uiChanged !== contract.uiChanged)
  )
    throw Error("PACKAGE_EXECUTION_FACTS_MISMATCH");
  if (contract.mutation) {
    if (contract.workKind !== assessment.result.workKind) throw Error("PACKAGE_WORK_KIND_MISMATCH");
    const effective = effectiveImplementation(assessment.result, {
      ...contract,
      highRisk: facts.risks?.includes("DECLARED_HIGH_RISK") ?? false,
    });
    if (
      contract.role !== effective.role ||
      contract.minTier !== effective.minTier ||
      contract.highRisk !== effective.highRisk
    )
      throw Error("PACKAGE_CLASS_AND_TIER_MISMATCH");
  }
}
