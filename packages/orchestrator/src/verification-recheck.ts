import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalPath, configSchema, contractSchema, digest, hash } from "./contracts.ts";
import type { Store, Attempt, TaskRow } from "./store.ts";
import type { Contract } from "./contracts.ts";
import { verificationPeersHash } from "./verification-recovery.ts";

export const verificationRecheckRequestSchema = z.strictObject({
  attemptId: z.string().min(1),
  fence: z.number().int().positive(),
  rework: z.number().int().positive(),
  agentId: z.string().min(1),
  nativeSessionId: z.string().min(1),
  contractHash: digest,
  configHash: digest,
  diffHash: digest,
  checkEvidenceSha256: digest,
  failureEvidenceSha256: digest,
  scopeRevision: digest,
  checkRevision: digest,
  peersHash: digest,
  crlfProofSha256: digest,
});
export type VerificationRecheckRequest = z.infer<typeof verificationRecheckRequestSchema>;
export interface VerificationRecheckResult {
  recheckId: string;
  attemptId: string;
  replayed: boolean;
}
export interface VerificationRecheckMarker {
  request: VerificationRecheckRequest;
  taskKey: string;
  reason: string;
  leaseResource: string;
}
const markerPrefix = "OPERATOR_VERIFICATION_RECHECK:";
export const recheckRawHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export function verificationRecheck(
  store: Store,
  id: string,
): VerificationRecheckMarker | undefined {
  const rows = store.db
    .prepare("SELECT kind FROM events WHERE attempt_id=? AND substr(kind,1,?)=?")
    .all(id, markerPrefix.length, markerPrefix) as { kind: string }[];
  if (rows.length > 1) throw Error("VERIFICATION_RECHECK_MARKER_CONFLICT");
  return rows[0] ? JSON.parse(rows[0].kind.slice(markerPrefix.length)) : undefined;
}

export function assertRecheckBindings(store: Store, marker: VerificationRecheckMarker): void {
  const r = marker.request,
    t = store.task(marker.taskKey),
    a = store.attempt(r.attemptId);
  if (
    !t ||
    store.latest(marker.taskKey)?.id !== a.id ||
    a.task_key !== marker.taskKey ||
    a.agent_id !== r.agentId ||
    a.fence !== r.fence ||
    a.run_accepted !== 1 ||
    t.contract_hash !== r.contractHash ||
    t.config_hash !== r.configHash
  )
    throw Error("VERIFICATION_RECHECK_BINDING_CHANGED");
  assertRecheckContract(store, marker, t, a);
  assertRecheckGrant(store, marker, a);
}

function assertRecheckContract(
  store: Store,
  marker: VerificationRecheckMarker,
  t: TaskRow,
  a: Attempt,
): void {
  const r = marker.request;
  const c = contractSchema.parse(JSON.parse(t.contract_json));
  const config = configSchema.parse(JSON.parse(t.config_json));
  const route = JSON.parse(a.route_json);
  if (
    hash(c) !== r.contractHash ||
    hash(config) !== r.configHash ||
    !c.mutation ||
    !c.role.startsWith("implement-") ||
    route.provider !== "codex" ||
    route.access !== "codex-pro200" ||
    store.scopeRevision(c) !== r.scopeRevision ||
    store.checkRevision(c) !== r.checkRevision
  )
    throw Error("VERIFICATION_RECHECK_REVISION_CHANGED");
}

function assertRecheckGrant(store: Store, marker: VerificationRecheckMarker, a: Attempt): void {
  const r = marker.request;
  const grant = store.terminalRepairForAttempt(a.id);
  if (
    !grant ||
    grant.agentId !== r.agentId ||
    grant.nativeSessionId !== r.nativeSessionId ||
    grant.contractHash !== r.contractHash ||
    grant.configHash !== r.configHash ||
    grant.approvedScopeRevision !== r.scopeRevision ||
    grant.approvedCheckRevision !== r.checkRevision ||
    hash(store.terminalRepairGrant(marker.taskKey) ?? null) !== hash(grant) ||
    !store.db
      .prepare("SELECT 1 FROM events WHERE kind=?")
      .get(`TERMINAL_REPAIR_CONSUMED:${hash(grant)}`)
  )
    throw Error("VERIFICATION_RECHECK_NATIVE_BINDING_CHANGED");
}

export function prepareVerificationRecheck(store: Store, marker: VerificationRecheckMarker) {
  assertRecheckBindings(store, marker);
  const r = marker.request,
    task = store.task(marker.taskKey)!,
    attempt = store.attempt(r.attemptId);
  const c = contractSchema.parse(JSON.parse(task.contract_json));
  const cfg = configSchema.parse(JSON.parse(task.config_json));
  if (
    verificationPeersHash(store, marker.taskKey) !== r.peersHash ||
    verificationRecheck(store, attempt.id) ||
    task.state !== "BLOCKED" ||
    attempt.status !== "FAILED" ||
    task.rework !== r.rework ||
    task.rework <= cfg.maxRework ||
    attempt.result_hash !== r.diffHash
  )
    throw Error("VERIFICATION_RECHECK_TERMINAL_REQUIRED");
  const checks = store.db.prepare("SELECT * FROM turn_checks WHERE attempt_id=?").get(attempt.id);
  const failure = store.db.prepare("SELECT * FROM reviews WHERE attempt_id=?").get(attempt.id);
  if (
    !checks ||
    !failure ||
    checks.diff_hash !== r.diffHash ||
    failure.diff_hash !== r.diffHash ||
    recheckRawHash(String(checks.result_json)) !== r.checkEvidenceSha256 ||
    recheckRawHash(String(failure.evidence_json)) !== r.failureEvidenceSha256
  )
    throw Error("VERIFICATION_RECHECK_EVIDENCE_CHANGED");
  assertOriginalChecks(String(checks.result_json), r);
  assertOriginalFailure(String(failure.evidence_json), r);
  const checked = JSON.parse(String(checks.result_json));
  const verdict = JSON.parse(String(failure.evidence_json));
  if (hash(checked.build) !== hash(verdict.build) || hash(checked.test) !== hash(verdict.test))
    throw Error("VERIFICATION_RECHECK_EVIDENCE_CHANGED");
  const lease = recheckLease(store, marker, c);
  assertRecheckPeers(store, marker, c);
  return { task, attempt, checks, failure, lease, peersHash: r.peersHash };
}

function assertOriginalChecks(json: string, r: VerificationRecheckRequest): void {
  const result = JSON.parse(json);
  if (
    result.build.exit !== 0 ||
    result.test.exit !== 0 ||
    result.build.quiescent !== true ||
    result.test.quiescent !== true ||
    result.changed !== false ||
    result.scopeViolations !== 0 ||
    result.diffCheckExit !== 2 ||
    result.diffHash !== r.diffHash
  )
    throw Error("VERIFICATION_RECHECK_CAUSE_REQUIRED");
}

function assertOriginalFailure(json: string, r: VerificationRecheckRequest): void {
  const verdict = JSON.parse(json);
  if (
    verdict.phase !== "pre-review" ||
    verdict.build?.exit !== 0 ||
    verdict.test?.exit !== 0 ||
    verdict.changed !== false ||
    verdict.scopeViolations !== 0 ||
    verdict.reviewResult ||
    verdict.controllerFindings ||
    (verdict.cohortFailure &&
      (verdict.cohortFailure.sourceAttemptId !== r.attemptId ||
        verdict.cohortFailure.round !== r.rework))
  )
    throw Error("VERIFICATION_RECHECK_CAUSE_REQUIRED");
}

function recheckLease(store: Store, marker: VerificationRecheckMarker, c: Contract) {
  const r = marker.request;
  if (
    store.db.prepare("SELECT 1 FROM review_runs WHERE attempt_id=?").get(r.attemptId) ||
    store.db.prepare("SELECT 1 FROM check_locks WHERE worktree=?").get(c.worktree) ||
    store.active().some((a) => a.agent_id === r.agentId || a.task_key === marker.taskKey) ||
    store.coordinationBlock(c)
  )
    throw Error("VERIFICATION_RECHECK_WORK_IN_PROGRESS");
  const leases = store.db
    .prepare("SELECT * FROM leases WHERE attempt_id=? AND fence=?")
    .all(r.attemptId, r.fence);
  if (
    leases.length !== 1 ||
    leases[0].state !== "RELEASED" ||
    leases[0].worktree !== marker.leaseResource
  )
    throw Error("VERIFICATION_RECHECK_LEASE_CHANGED");
  return leases[0];
}

function assertRecheckPeers(store: Store, marker: VerificationRecheckMarker, c: Contract): void {
  const peers = store.db
    .prepare("SELECT key,state,contract_json FROM tasks WHERE key!=?")
    .all(marker.taskKey);
  for (const peer of peers) {
    if (
      canonicalPath(JSON.parse(String(peer.contract_json)).worktree) !== canonicalPath(c.worktree)
    )
      continue;
    const latest = store.latest(String(peer.key));
    if (
      !(
        (peer.state === "COMPLETE" && latest?.status === "COMPLETE") ||
        (peer.state === "READY" && !latest)
      )
    )
      throw Error("VERIFICATION_RECHECK_PEERS_CHANGED");
  }
}

export function assertRecheckArchive(store: Store, marker: VerificationRecheckMarker): void {
  const row = store.db
    .prepare(
      "SELECT kind FROM events WHERE attempt_id=? AND kind LIKE 'VERIFICATION_RECHECK_ARCHIVE:%'",
    )
    .get(marker.request.attemptId) as { kind: string } | undefined;
  if (!row) throw Error("VERIFICATION_RECHECK_ARCHIVE_CHANGED");
  const archive = JSON.parse(row.kind.slice("VERIFICATION_RECHECK_ARCHIVE:".length));
  if (
    archive.checks?.attempt_id !== marker.request.attemptId ||
    archive.failure?.attempt_id !== marker.request.attemptId ||
    archive.checks?.diff_hash !== marker.request.diffHash ||
    archive.failure?.diff_hash !== marker.request.diffHash ||
    typeof archive.checks?.result_json !== "string" ||
    typeof archive.failure?.evidence_json !== "string" ||
    recheckRawHash(archive.checks.result_json) !== marker.request.checkEvidenceSha256 ||
    recheckRawHash(archive.failure.evidence_json) !== marker.request.failureEvidenceSha256
  )
    throw Error("VERIFICATION_RECHECK_ARCHIVE_CHANGED");
}

export function recordVerificationRecheck(store: Store, marker: VerificationRecheckMarker): void {
  store.event(`${markerPrefix}${JSON.stringify(marker)}`, marker.request.attemptId);
}
