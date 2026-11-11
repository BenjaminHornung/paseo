import type { PaseoApi, PaseoAgentHandle } from "@getpaseo/client";
import path from "node:path";
import { z } from "zod";
import { canonicalPath, contractSchema, hash, type Config, type Contract } from "./contracts.ts";
import { Decisions } from "./decisions.ts";
import {
  effectiveImplementation,
  intakeFactsSchema,
  intakeResultSchema,
  type Assessment,
  type Classifier,
  type IntakeFacts,
  type IntakeResult,
  type PackageResult,
} from "./assessments.ts";
import { Store } from "./store.ts";
import { observedTimeline } from "./timeline.ts";
import { verifiedProviderSessionId } from "./completion.ts";
import type { IntakeConfirmation } from "../paseo-plugin/shared/intake-confirmation.ts";
import {
  intakeIdentities,
  rememberIntakeIdentity,
  resolveIntakeIdentities,
  isOperatorAdvisorReceipt,
} from "./intake-identity.ts";

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
  return entries.findIndex((entry) =>
    anchor
      ? entry.seqStart <= Number(anchor[2]) && entry.seqEnd >= Number(anchor[2])
      : entry.item.type === "user_message" &&
        (entry.item.clientMessageId ?? entry.item.messageId) === checkpoint,
  );
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
      "SELECT facts_json FROM assessments WHERE owner_id=? AND kind='intake' AND result_json IS NULL AND created_ms<?",
    )
    .all(main.agentId, Date.now() - (config.decisions?.timeoutMs ?? 10000) - 15000) as {
    facts_json: string;
  }[];
  for (const row of abandoned)
    await classifier.classifyIntake(intakeFactsSchema.parse(JSON.parse(row.facts_json)), config);
  const checkpoint = store.db
    .prepare("SELECT message_id FROM main_checkpoints WHERE agent_id=?")
    .get(main.agentId) as { message_id: string | null } | undefined;
  const sessionId = await verifiedProviderSessionId(handle);
  const emptyBaseline = checkpoint?.message_id?.startsWith("empty:");
  if (emptyBaseline && checkpoint?.message_id !== `empty:${sessionId}`)
    throw Error("INTAKE_HISTORY_SESSION_CHANGED");
  const identities = intakeIdentities(store, main.agentId, sessionId);
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
  const timeline = await observedTimeline(
    handle,
    "projected",
    emptyBaseline || staleReceipts.length
      ? undefined
      : checkpoint?.message_id
        ? (entries) =>
            timelineCheckpointIndex(
              resolveIntakeIdentities(entries, identities, false),
              checkpoint.message_id,
            ) >= 0
        : checkpoint
          ? undefined
          : () => true,
  );
  let entries = resolveIntakeIdentities(timeline.entries, identities, !timeline.hasOlder);
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
  if (anchor && timeline.endCursor && timeline.endCursor.epoch !== anchor[1])
    throw Error("INTAKE_HISTORY_EPOCH_CHANGED");
  const requestedScope = snapshot.labels?.orchestratorScope;
  const dataScope = ["public", "personal", "company", "restricted"].includes(requestedScope ?? "")
    ? requestedScope!
    : "company";
  if (checkpoint?.message_id && !emptyBaseline) {
    const index = timelineCheckpointIndex(entries, checkpoint.message_id);
    if (index < 0) throw Error("INTAKE_HISTORY_GAP");
    entries = entries.slice(index + 1);
  }
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
          "SELECT facts_json FROM assessments WHERE owner_id=? AND kind='intake' AND json_extract(result_json,'$.source')='decisions' AND json_extract(result_json,'$.result.needImplementation')=1 ORDER BY rowid DESC LIMIT 1",
        )
        .get(main.agentId) as { facts_json: string } | undefined;
      const safeContext = (text: string) =>
        !/sk-[a-zA-Z0-9_-]{16,}|(?:password|pwd|secret|token|api[_-]?key|connectionstring)["']?\s*[:=]|PRIVATE KEY/i.test(
          text,
        );
      if (approved) {
        const original = intakeFactsSchema.parse(JSON.parse(approved.facts_json));
        if (original.dataScope === dataScope && safeContext(original.text))
          knownFacts.push(
            `Earlier implementation request, historical context only; current gates still apply: ${original.text.slice(0, 700)}`,
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
          dataScope,
          knownFacts: knownFacts.slice(0, 12),
          messageRevision: 1,
          factsRevision: 1,
        });
    latest = await classifier.classifyIntake(facts, config);
    // Another caller owns the in-flight request. It alone advances the cursor.
    if (latest.reason === "DECISIONS_OUTCOME_PENDING") throw Error("INTAKE_PENDING");
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
      const result = latest!.result;
      const currentReceipt = store.db
        .prepare("SELECT kind FROM internal_messages WHERE agent_id=? AND message_id=?")
        .get(main.agentId, messageId) as { kind: string } | undefined;
      const confirmed = origin === "human" && currentReceipt?.kind === `human:${hash(item.text)}`;
      const awaitingOperatorClassification =
        latest!.source === "fallback" && latest!.reason === "DECISIONS_LOW_CONFIDENCE";
      if (
        (!awaitingOperatorClassification &&
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
    const prior = store.db
      .prepare(
        "SELECT result_json FROM assessments WHERE owner_id=? AND kind='intake' ORDER BY created_ms DESC,rowid DESC LIMIT 1",
      )
      .get(main.agentId) as { result_json: string | null } | undefined;
    if (prior?.result_json) latest = JSON.parse(prior.result_json) as Assessment<IntakeResult>;
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
          .prepare("SELECT result_json FROM assessments WHERE id=? AND owner_id=?")
          .get(checkpoint.work_intake_id, agentId)
      : store.db
          .prepare(
            "SELECT result_json FROM assessments WHERE owner_id=? AND kind='intake' ORDER BY created_ms DESC,rowid DESC LIMIT 1",
          )
          .get(agentId);
  const value = row as { result_json: string | null } | undefined;
  if (!value?.result_json) throw Error("INTAKE_CLASSIFICATION_REQUIRED");
  const assessment = effectiveIntakeAssessment(
    store,
    JSON.parse(value.result_json) as Assessment<IntakeResult>,
  );
  const origin = store.db
    .prepare("SELECT facts_json FROM assessments WHERE id=?")
    .get(assessment.id) as { facts_json: string };
  const facts = intakeFactsSchema.parse(JSON.parse(origin.facts_json));
  assertHumanReceipt(store, facts, !forMutation);
  if (forMutation && checkpoint?.work_intake_id) {
    const latestRow = store.db
      .prepare(
        "SELECT id,facts_json,result_json FROM assessments WHERE owner_id=? AND kind='intake' ORDER BY rowid DESC LIMIT 1",
      )
      .get(agentId) as { id: string; facts_json: string; result_json: string | null } | undefined;
    if (latestRow?.id !== assessment.id) {
      if (!latestRow?.result_json) throw Error("INTAKE_PENDING");
      const latest = effectiveIntakeAssessment(
        store,
        JSON.parse(latestRow.result_json) as Assessment<IntakeResult>,
      );
      const latestFactsRow = store.db
        .prepare("SELECT facts_json FROM assessments WHERE id=?")
        .get(latest.id) as { facts_json: string };
      assertHumanReceipt(store, intakeFactsSchema.parse(JSON.parse(latestFactsRow.facts_json)));
      const isInformational = ["question", "status"].includes(latest.result.intent);
      const isApprovedContinuation =
        latest.result.intent === "approval" &&
        latest.result.needImplementation &&
        hasTaskApprovalLink(store, agentId, checkpoint.work_intake_id, latest);
      if (latest.id !== assessment.id && !isInformational && !isApprovedContinuation) {
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
      !["decisions", "operator-confirmed"].includes(assessment.source))
  )
    throw Error("INTAKE_IMPLEMENTATION_NOT_AUTHORIZED");
  return assessment;
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
  return approval
    ? {
        ...assessment,
        source: "operator-confirmed",
        reason: "OPERATOR_CONFIRMED_MODEL_ANSWER",
        result: intakeResultSchema.parse(approval.effectiveResult),
      }
    : assessment;
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
    !["decisions", "operator-confirmed"].includes(approval.source) ||
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
  return approvalLinks(store, approval.id).some(
    (link) =>
      link.agentId === agentId &&
      link.originalIntakeId === originalIntakeId &&
      link.approvalMessageId === facts.messageId &&
      link.approvalHash === hash(approval) &&
      link.messageHash === hash(facts.text),
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
      .prepare("SELECT result_json FROM assessments WHERE id=? AND owner_id=? AND kind='intake'")
      .get(link.approvalAssessmentId, intake.owner_id) as
      | { result_json: string | null }
      | undefined;
    if (!approvalRow?.result_json) return false;
    try {
      return hasTaskApprovalLink(
        store,
        intake.owner_id,
        contract.intakeId!,
        effectiveIntakeAssessment(
          store,
          JSON.parse(approvalRow.result_json) as Assessment<IntakeResult>,
        ),
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
): string | undefined {
  const checkpoint = store.db
    .prepare("SELECT work_intake_id FROM main_checkpoints WHERE agent_id=?")
    .get(agentId) as { work_intake_id: string | null } | undefined;
  if (
    !checkpoint?.work_intake_id ||
    !["decisions", "operator-confirmed"].includes(approval.source) ||
    approval.result.intent !== "approval" ||
    !approval.result.needImplementation
  )
    return undefined;
  const factsRow = store.db
    .prepare("SELECT facts_json FROM assessments WHERE id=? AND owner_id=?")
    .get(approval.id, agentId) as { facts_json: string } | undefined;
  if (!factsRow) return undefined;
  const approvalFacts = intakeFactsSchema.parse(JSON.parse(factsRow.facts_json));
  assertHumanReceipt(store, approvalFacts);
  const candidates = taskKeys.flatMap((taskKey) => {
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
      (!pausedWorker && !awaitingOwnerApproval)
    )
      return [];
    const binding = store.db
      .prepare("SELECT intake_id,package_id,effective_class FROM task_assessments WHERE task_key=?")
      .get(taskKey) as
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
  if (!store.db.prepare("SELECT 1 FROM events WHERE kind=?").get(kind))
    store.event(kind, target.attempt?.id ?? null);
  return target.taskKey;
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
    replyFacts.directory !== facts.directory ||
    replyFacts.dataScope !== facts.dataScope
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
      facts.dataScope !== priorFacts.dataScope ||
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
  if (
    store.db
      .prepare(
        "SELECT 1 FROM assessments WHERE owner_id=? AND kind='intake' AND result_json IS NULL LIMIT 1",
      )
      .get(agentId) ||
    store.db
      .prepare(`SELECT 1 FROM internal_messages receipt WHERE receipt.agent_id=? AND (receipt.kind LIKE 'human:%' OR receipt.kind LIKE 'operator-readonly-advisor:%')
      AND NOT EXISTS(SELECT 1 FROM assessments assessment WHERE assessment.owner_id=receipt.agent_id AND assessment.kind='intake'
        AND json_extract(assessment.facts_json,'$.messageId')=receipt.message_id AND assessment.result_json IS NOT NULL) LIMIT 1`)
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
  for (const row of pending) {
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
  if (!intake?.result_json || !pkg?.result_json) throw Error("TASK_ASSESSMENT_REQUIRED");
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
  if (contract.dataScope !== intakeFacts.dataScope && contract.dataScope !== "restricted")
    throw Error("INTAKE_DATA_SCOPE_MISMATCH");
  const intakeResult = JSON.parse(intake.result_json) as Assessment<IntakeResult>;
  const assessment = JSON.parse(pkg.result_json) as Assessment<PackageResult>;
  if (!contract.mutation && !["planner", "advisor"].includes(contract.role))
    throw Error("INTAKE_ROLE_NOT_AUTHORIZED");
  if (contract.mutation && currentIntake(store, intake.owner_id, true).id !== contract.intakeId)
    throw Error("INTAKE_SUPERSEDED");
  if (contract.mutation) {
    const latest = currentIntake(store, intake.owner_id, false);
    if (
      latest.id !== contract.intakeId &&
      latest.result.intent === "approval" &&
      latest.result.needImplementation &&
      !approvalLinks(store, latest.id).some(
        (link) =>
          link.agentId === intake.owner_id &&
          link.taskKey === `${contract.workflowId}/${contract.taskId}/${contract.role}` &&
          link.contractHash === hash(contract) &&
          link.originalIntakeId === contract.intakeId &&
          link.packageAssessmentId === contract.packageAssessmentId &&
          link.packageId === `${contract.workflowId}/${contract.taskId}` &&
          hasTaskApprovalLink(store, intake.owner_id, contract.intakeId!, latest),
      )
    )
      throw Error("APPROVAL_TARGET_REQUIRED");
  }
  if (
    !contract.mutation &&
    contract.role === "planner" &&
    !intakeResult.result.needPlanner &&
    !(
      intakeResult.result.needImplementation &&
      assessment.source === "decisions" &&
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
      assessment.source === "decisions" &&
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
    dataScope: string;
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
    facts.baseCommit !== contract.baseCommit ||
    facts.dataScope !== contract.dataScope
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
