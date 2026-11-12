export interface Verification {
  buildExit: number;
  testExit: number;
  diffHash: string;
  reviewedDiffHash?: string;
  uiChanged: boolean;
  visualAcceptance: boolean;
  highRisk: boolean;
  ownerApproved: boolean;
  reviewPass: boolean;
  scopeViolations: number;
  unresolvedIssues: number;
}
export function mayComplete(v: Verification): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (v.buildExit !== 0) reasons.push("build-failed");
  if (v.testExit !== 0) reasons.push("tests-failed");
  if (!v.diffHash || v.diffHash !== v.reviewedDiffHash) reasons.push("review-stale-or-missing");
  if (v.uiChanged && !v.visualAcceptance) reasons.push("visual-check-missing");
  if (v.highRisk && !v.ownerApproved) reasons.push("approval-required");
  if (!v.reviewPass) reasons.push("review-failed");
  if (v.scopeViolations > 0) reasons.push("scope-violations");
  if (v.unresolvedIssues > 0) reasons.push("open-review-findings");
  return { ok: reasons.length === 0, reasons };
}
