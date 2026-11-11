import { hash } from "./contracts.ts";
import type { Store } from "./store.ts";
import { readAutomation, workflowStatus } from "./automation.ts";
import { appRoot } from "./settings-files.ts";
import type { Assessment, IntakeResult, PackageResult } from "./assessments.ts";
import { effectiveIntakeAssessment } from "./intake.ts";
import { intakeFactsSchema } from "./assessments.ts";

function displayAssessment(store: Store, result?: Assessment<IntakeResult | PackageResult>) {
  if (result?.kind !== "intake") return result;
  const effective = effectiveIntakeAssessment(store, result as Assessment<IntakeResult>);
  return effective.id === result.id ? effective : result;
}

function followingConfirmation(store: Store, agentId: string, assessmentId: string) {
  const latest = store.db
    .prepare(
      "SELECT id,facts_json,result_json FROM assessments WHERE owner_id=? AND kind='intake' ORDER BY rowid DESC LIMIT 1",
    )
    .get(agentId) as { id: string; facts_json: string; result_json: string | null } | undefined;
  if (!latest?.result_json || latest.id === assessmentId) return;
  const reply = JSON.parse(latest.result_json) as Assessment<IntakeResult>;
  const facts = intakeFactsSchema.parse(JSON.parse(latest.facts_json));
  if (reply.reason !== "INTAKE_HUMAN_ORIGIN_UNCONFIRMED" || facts.origin !== "unverified") return;
  return {
    assessmentId: latest.id,
    messageId: facts.messageId,
    assessmentHash: hash(reply),
    input: JSON.stringify(redacted(facts), null, 2),
  };
}

function intakeApprovalView(
  store: Store,
  agentId: string,
  result: Assessment<IntakeResult | PackageResult> | undefined,
  input: unknown,
) {
  if (
    result?.kind !== "intake" ||
    result.source !== "fallback" ||
    result.reason !== "DECISIONS_LOW_CONFIDENCE"
  )
    return;
  const facts = intakeFactsSchema.parse(input);
  if (
    facts.origin !== "human" ||
    !result.answers?.some((answer) => answer.name === "needImplementation" && answer.value === true)
  )
    return;
  return {
    messageId: facts.messageId,
    confirmation: followingConfirmation(store, agentId, result.id),
  };
}

// This detailed view is returned only on an explicit local GUI request. It must
// never be added to workflowStatus, model context or a published timeline row.
function redacted(value: unknown, key = ""): unknown {
  if (
    /(?:api[_-]?key|password|passwd|authorization|credential|secret|connection[_-]?string|access[_-]?token|refresh[_-]?token)/i.test(
      key,
    )
  )
    return "[AUSGEBLENDET]";
  if (typeof value === "string") {
    if (
      /\bsk-[A-Za-z0-9_-]{12,}|\b(?:ghp_|github_pat_|xox[bp]-)[A-Za-z0-9_-]+|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\bBearer\s+\S+|(?:api[_-]?key|password|passwd|secret|connection[_-]?string|ClearTextPassword)["'\s]*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY|https?:\/\/[^\s/@:]+:[^\s/@]+@|(?:Server|Data Source)=[^\r\n]+;(?:[^\r\n]*;)?\s*(?:Database|Initial Catalog)=|<add\s+[^>]*key=["'][^"']*(?:key|password|secret|token)[^"']*["']/i.test(
        value,
      )
    )
      return "[INHALT MIT MÖGLICHEN ZUGANGSDATEN AUSGEBLENDET]";
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redacted(item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, redacted(item, name)]),
    );
  return value;
}

export function decisionHistory(
  store: Store,
  directory: string,
  agentId?: string,
  assessmentId?: string,
  before?: number,
  root = appRoot,
) {
  const view = workflowStatus(store, directory, agentId, root);
  if (
    !view.mainAgentId ||
    !readAutomation(root).mains.some((main) => main.agentId === view.mainAgentId)
  )
    throw Error("DECISIONS_MAIN_REQUIRED");
  const rows = store.db
    .prepare(`SELECT rowid,id,kind,created_ms,result_json FROM assessments WHERE owner_id=?
    AND rowid<? ORDER BY rowid DESC LIMIT 20`)
    .all(view.mainAgentId, before ?? Number.MAX_SAFE_INTEGER) as {
    rowid: number;
    id: string;
    kind: string;
    created_ms: number;
    result_json: string | null;
  }[];
  const items = rows.map((row) => {
    const result = row.result_json
      ? (JSON.parse(row.result_json) as Assessment<IntakeResult | PackageResult>)
      : undefined;
    return {
      id: row.id,
      kind: row.kind,
      at: row.created_ms,
      source: result?.source ?? "pending",
      reason: result?.reason ?? "DECISIONS_OUTCOME_PENDING",
    };
  });
  let detail;
  if (assessmentId) {
    const row = store.db
      .prepare("SELECT kind,facts_json,result_json FROM assessments WHERE id=? AND owner_id=?")
      .get(assessmentId, view.mainAgentId) as
      | { kind: string; facts_json: string; result_json: string | null }
      | undefined;
    if (!row) throw Error("DECISION_NOT_IN_MAIN");
    const facts = JSON.parse(row.facts_json),
      stored = row.result_json
        ? (JSON.parse(row.result_json) as Assessment<IntakeResult | PackageResult>)
        : undefined;
    const result = displayAssessment(store, stored);
    const call = store.db
      .prepare("SELECT state,reserved,charged FROM decision_calls WHERE key=?")
      .get(hash({ id: assessmentId, version: result?.version ?? `${row.kind}-v3` })) as
      | { state: string; reserved: number; charged: number | null }
      | undefined;
    detail = {
      id: assessmentId,
      input: JSON.stringify(redacted(facts), null, 2),
      result: result ? JSON.stringify(redacted(result.result), null, 2) : null,
      response: result?.response ? JSON.stringify(redacted(result.response), null, 2) : null,
      diagnostics: result?.answers ? JSON.stringify(redacted(result.answers), null, 2) : null,
      request: result?.request ? JSON.stringify(redacted(result.request), null, 2) : null,
      confidence: result?.confidence,
      source: result?.source ?? "pending",
      reason: result?.reason ?? "DECISIONS_OUTCOME_PENDING",
      callState: call?.state ?? "NOT_RECORDED",
      reservedMicroUsd: call?.reserved ?? 0,
      chargedMicroUsd: call?.charged ?? null,
      inputHash: result?.factsHash ?? hash(facts),
      approval: intakeApprovalView(store, view.mainAgentId, result, facts),
      provenance: result?.request
        ? "REQUEST_ATTEMPT_RECORDED"
        : call
          ? "CALL_WITHOUT_REQUEST_AUDIT"
          : "NO_API_CALL",
    };
  }
  return {
    mainAgentId: view.mainAgentId,
    items,
    nextBefore: rows.length === 20 ? rows.at(-1)!.rowid : undefined,
    detail,
  };
}
