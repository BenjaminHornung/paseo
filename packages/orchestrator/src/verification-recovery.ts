import { z } from "zod";
import { createHash } from "node:crypto";
import {
  canonicalPath,
  configSchema,
  contractSchema,
  digest,
  hash,
  reviewResultSchema,
} from "./contracts.ts";
import type { Store, Attempt, TaskRow } from "./store.ts";
import type { Contract } from "./contracts.ts";

export const operatorWakeBindingSchema = z.strictObject({
  mainAgentId: z.string().min(1),
  sessionId: z.string().min(1),
  receiptId: z.string().min(1),
  nativeMessageId: z.string().uuid(),
  assessmentId: digest,
  factsHash: digest,
  textHash: digest,
  directory: z.string().min(1),
  workIntakeId: digest,
});
export const verificationRecoveryRequestSchema = z.strictObject({
  attemptId: z.string().min(1),
  fence: z.number().int().positive(),
  rework: z.number().int().positive(),
  agentId: z.string().min(1),
  nativeSessionId: z.string().min(1),
  reviewerId: z.string().min(1),
  reviewerNativeSessionId: z.string().min(1),
  contractHash: digest,
  configHash: digest,
  diffHash: digest,
  checkEvidenceSha256: digest,
  reviewRunSha256: digest,
  finalEvidenceSha256: digest,
  scopeRevision: digest,
  checkRevision: digest,
  checkBindingHash: digest,
  origin: operatorWakeBindingSchema,
});
export type OperatorWakeBinding = z.infer<typeof operatorWakeBindingSchema>;
export type VerificationRecoveryRequest = z.infer<typeof verificationRecoveryRequestSchema>;
export interface VerificationRecoveryResult {
  recoveryId: string;
  attemptId: string;
  replayed: boolean;
}
export interface VerificationRecoveryMarker {
  request: VerificationRecoveryRequest;
  reason: string;
  taskKey: string;
  peersHash: string;
  leaseResource: string;
}
const markerPrefix = "OPERATOR_VERIFICATION_RECOVERY:";
export const rawEvidenceHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export function verificationRecovery(
  store: Store,
  id: string,
): VerificationRecoveryMarker | undefined {
  const row = store.db
    .prepare("SELECT kind FROM events WHERE attempt_id=? AND substr(kind,1,?)=?")
    .get(id, markerPrefix.length, markerPrefix) as { kind: string } | undefined;
  return row ? JSON.parse(row.kind.slice(markerPrefix.length)) : undefined;
}
export function recordVerificationRecovery(store: Store, marker: VerificationRecoveryMarker): void {
  store.event(`${markerPrefix}${JSON.stringify(marker)}`, marker.request.attemptId);
}
export function assertNoVerificationWork(store: Store, id: string | undefined): void {
  if (id && verificationRecovery(store, id)) throw Error("VERIFICATION_RECOVERY_NO_NEW_WORK");
}
export function assertRecoveryFinalization(
  store: Store,
  id: string,
  qualityPass: boolean,
  authorized: boolean,
): void {
  if (verificationRecovery(store, id) && (!qualityPass || !authorized))
    throw Error("VERIFICATION_RECOVERY_WAIT");
}
export function verificationPeersHash(store: Store, key: string): string {
  const own = contractSchema.parse(JSON.parse(store.task(key)!.contract_json));
  const peers = store.db
    .prepare(
      "SELECT key,state,rework,contract_hash,config_hash,contract_json FROM tasks WHERE key!=? ORDER BY key",
    )
    .all(key)
    .filter(
      (row) =>
        canonicalPath(JSON.parse(String(row.contract_json)).worktree) ===
        canonicalPath(own.worktree),
    );
  const states = [];
  for (const row of peers) states.push({ ...row, attempt: store.latest(String(row.key)) ?? null });
  return hash(states);
}
interface RecoveryRows {
  attempt: Attempt;
  task: TaskRow;
  contract: Contract;
}
function recoveryRows(store: Store, marker: VerificationRecoveryMarker): RecoveryRows {
  const r = marker.request,
    a = store.attempt(r.attemptId),
    t = store.task(marker.taskKey);
  if (
    !t ||
    store.latest(marker.taskKey)?.id !== a.id ||
    a.task_key !== marker.taskKey ||
    a.agent_id !== r.agentId ||
    a.fence !== r.fence ||
    a.run_accepted !== 1 ||
    t.rework !== r.rework ||
    t.contract_hash !== r.contractHash ||
    t.config_hash !== r.configHash ||
    verificationPeersHash(store, marker.taskKey) !== marker.peersHash
  )
    throw Error("VERIFICATION_RECOVERY_BINDING_CHANGED");
  if (
    verificationRecovery(store, a.id) &&
    (!["VERIFY", "NEEDS_CONFIRMATION", "COMPLETE"].includes(a.status) ||
      !["VERIFY", "NEEDS_CONFIRMATION", "COMPLETE"].includes(t.state))
  )
    throw Error("VERIFICATION_RECOVERY_STATE_CHANGED");
  if (verificationRecovery(store, a.id)) assertRecoveryArchive(store, marker);
  const c = contractSchema.parse(JSON.parse(t.contract_json));
  return { attempt: a, task: t, contract: c };
}
function assertRecoveryArchive(store: Store, marker: VerificationRecoveryMarker): void {
  const row = store.db
    .prepare(
      "SELECT kind FROM events WHERE attempt_id=? AND kind LIKE 'VERIFICATION_RECOVERY_ARCHIVE:%'",
    )
    .get(marker.request.attemptId) as { kind: string } | undefined;
  if (!row) throw Error("VERIFICATION_RECOVERY_ARCHIVE_CHANGED");
  const archive = JSON.parse(row.kind.slice("VERIFICATION_RECOVERY_ARCHIVE:".length));
  if (
    typeof archive.evidenceJson !== "string" ||
    archive.sha256 !== marker.request.finalEvidenceSha256 ||
    rawEvidenceHash(archive.evidenceJson) !== marker.request.finalEvidenceSha256
  )
    throw Error("VERIFICATION_RECOVERY_ARCHIVE_CHANGED");
}
function assertRecoveryConfiguration(
  store: Store,
  marker: VerificationRecoveryMarker,
  rows: RecoveryRows,
): void {
  const r = marker.request,
    { task: t, contract: c } = rows;
  if (
    hash(c) !== r.contractHash ||
    hash(configSchema.parse(JSON.parse(t.config_json))) !== r.configHash ||
    store.scopeRevision(c) !== r.scopeRevision ||
    store.checkRevision(c) !== r.checkRevision ||
    hash(store.checkCommandBinding(c)) !== r.checkBindingHash ||
    store.db.prepare("SELECT 1 FROM check_locks WHERE worktree=?").get(c.worktree)
  )
    throw Error("VERIFICATION_RECOVERY_EVIDENCE_CHANGED");
}
function assertRecoveryChecks(store: Store, r: VerificationRecoveryRequest): void {
  const checks = store.db.prepare("SELECT * FROM turn_checks WHERE attempt_id=?").get(r.attemptId);
  if (
    !checks ||
    checks.diff_hash !== r.diffHash ||
    rawEvidenceHash(String(checks.result_json)) !== r.checkEvidenceSha256
  )
    throw Error("VERIFICATION_RECOVERY_EVIDENCE_CHANGED");
  const checked = JSON.parse(String(checks.result_json));
  if (
    checked.build.exit !== 0 ||
    checked.test.exit !== 0 ||
    checked.build.quiescent !== true ||
    checked.test.quiescent !== true ||
    checked.changed !== false ||
    checked.scopeViolations !== 0 ||
    checked.diffCheckExit !== 0 ||
    checked.diffHash !== r.diffHash
  )
    throw Error("VERIFICATION_RECOVERY_PASS_REQUIRED");
}
function assertRecoveryReview(store: Store, r: VerificationRecoveryRequest): void {
  const review = store.db.prepare("SELECT * FROM review_runs WHERE attempt_id=?").get(r.attemptId);
  if (
    !review ||
    review.diff_hash !== r.diffHash ||
    rawEvidenceHash(JSON.stringify(review)) !== r.reviewRunSha256 ||
    review.state !== "DONE" ||
    review.agent_id !== r.reviewerId
  )
    throw Error("VERIFICATION_RECOVERY_EVIDENCE_CHANGED");
  const result = reviewResultSchema.parse(JSON.parse(String(review.result_json)));
  if (!result.pass || result.unresolvedIssues !== 0 || result.diffHash !== r.diffHash)
    throw Error("VERIFICATION_RECOVERY_PASS_REQUIRED");
}
export function assertVerificationRecoveryEvidence(
  store: Store,
  marker: VerificationRecoveryMarker,
): void {
  const rows = recoveryRows(store, marker),
    a = rows.attempt;
  assertRecoveryConfiguration(store, marker, rows);
  assertRecoveryChecks(store, marker.request);
  assertRecoveryReview(store, marker.request);
  const lease = store.db
    .prepare("SELECT * FROM leases WHERE worktree=? AND attempt_id=? AND fence=?")
    .get(marker.leaseResource, a.id, a.fence);
  if (!lease || !["RELEASED", "HELD", "SUSPECT"].includes(String(lease.state)))
    throw Error("VERIFICATION_RECOVERY_LEASE_CHANGED");
}

export function prepareVerificationRecovery(
  store: Store,
  key: string,
  request: VerificationRecoveryRequest,
  reason: string,
): VerificationRecoveryMarker {
  if (reason.length < 10) throw Error("VERIFICATION_RECOVERY_REASON_REQUIRED");
  const a = store.attempt(request.attemptId),
    t = store.task(key);
  if (!t || a.task_key !== key || a.status !== "FAILED" || t.state !== "BLOCKED")
    throw Error("VERIFICATION_RECOVERY_TERMINAL_REQUIRED");
  const c = contractSchema.parse(JSON.parse(t.contract_json));
  assertRecoveryEligibility({ attempt: a, task: t, contract: c }, request);
  assertRecoveryGrant(store, key, a, request);
  const lease = store.db
    .prepare("SELECT * FROM leases WHERE attempt_id=? AND fence=?")
    .all(a.id, a.fence);
  if (lease.length !== 1 || lease[0].state !== "RELEASED" || a.result_hash !== request.diffHash)
    throw Error("VERIFICATION_RECOVERY_NOT_ELIGIBLE");
  assertRecoveryVerdict(store, { attempt: a, task: t, contract: c }, request);
  if (store.coordinationBlock(c)) throw Error("VERIFICATION_RECOVERY_PEERS_CHANGED");
  const peers = store.db.prepare("SELECT key,state,contract_json FROM tasks WHERE key!=?").all(key);
  for (const peer of peers) {
    if (
      canonicalPath(JSON.parse(String(peer.contract_json)).worktree) !== canonicalPath(c.worktree)
    )
      continue;
    if (peer.state !== "READY" || store.latest(String(peer.key)))
      throw Error("VERIFICATION_RECOVERY_PEERS_CHANGED");
  }
  const marker = {
    request,
    reason,
    taskKey: key,
    peersHash: verificationPeersHash(store, key),
    leaseResource: String(lease[0].worktree),
  };
  assertVerificationRecoveryEvidence(store, marker);
  return marker;
}

function assertRecoveryEligibility(rows: RecoveryRows, request: VerificationRecoveryRequest): void {
  const { task: t, contract: c, attempt: a } = rows;
  const config = configSchema.parse(JSON.parse(t.config_json)),
    route = JSON.parse(a.route_json);
  if (
    config.orchestrationVersion !== 3 ||
    !c.mutation ||
    !c.role.startsWith("implement-") ||
    c.intakeId !== request.origin.workIntakeId ||
    route.provider !== "codex" ||
    route.access !== "codex-pro200" ||
    t.rework <= config.maxRework ||
    a.result_hash !== request.diffHash
  )
    throw Error("VERIFICATION_RECOVERY_NOT_ELIGIBLE");
}
function assertRecoveryVerdict(
  store: Store,
  rows: RecoveryRows,
  request: VerificationRecoveryRequest,
): void {
  const { attempt: a, task: t } = rows;
  const final = store.db.prepare("SELECT * FROM reviews WHERE attempt_id=?").get(a.id);
  if (
    !final ||
    final.diff_hash !== request.diffHash ||
    rawEvidenceHash(String(final.evidence_json)) !== request.finalEvidenceSha256
  )
    throw Error("VERIFICATION_RECOVERY_VERDICT_CHANGED");
  const verdict = JSON.parse(String(final.evidence_json));
  if (
    JSON.stringify(verdict.reasons) !== JSON.stringify(["approval-required"]) ||
    (verdict.cohortFailure &&
      (verdict.cohortFailure.sourceAttemptId !== a.id || verdict.cohortFailure.round !== t.rework))
  )
    throw Error("VERIFICATION_RECOVERY_AUTHORITY_FAILURE_REQUIRED");
}
function assertRecoveryGrant(
  store: Store,
  key: string,
  a: Attempt,
  request: VerificationRecoveryRequest,
): void {
  const grant = store.terminalRepairForAttempt(a.id);
  if (
    !grant ||
    grant.agentId !== request.agentId ||
    grant.nativeSessionId !== request.nativeSessionId ||
    grant.contractHash !== request.contractHash ||
    grant.configHash !== request.configHash ||
    grant.approvedScopeRevision !== request.scopeRevision ||
    grant.approvedCheckRevision !== request.checkRevision ||
    hash(store.terminalRepairGrant(key) ?? null) !== hash(grant) ||
    a.sequence !== store.attempt(grant.predecessorAttemptId).sequence + 1 ||
    a.fence <= grant.predecessorFence ||
    !store.db
      .prepare("SELECT 1 FROM events WHERE kind=?")
      .get(`TERMINAL_REPAIR_CONSUMED:${hash(grant)}`)
  )
    throw Error("VERIFICATION_RECOVERY_NOT_ELIGIBLE");
}

export function verificationRecoveryClaimHash(
  store: Store,
  marker: VerificationRecoveryMarker,
): string {
  const r = marker.request;
  return hash({
    task: store.task(marker.taskKey),
    attempt: store.attempt(r.attemptId),
    verdict: store.db.prepare("SELECT * FROM reviews WHERE attempt_id=?").get(r.attemptId),
    lease: store.db.prepare("SELECT * FROM leases WHERE worktree=?").get(marker.leaseResource),
    checkpoint: store.db
      .prepare("SELECT * FROM main_checkpoints WHERE agent_id=?")
      .get(r.origin.mainAgentId),
    peers: verificationPeersHash(store, marker.taskKey),
  });
}
