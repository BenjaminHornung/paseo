import type { BudgetBucket } from "./types.ts";
export interface Grant {
  claimedUsd: number | null;
  remainingUsd: number | null;
  verifiedAtMs: number | null;
  billingCycleEnd: string | null;
}
export const DEFAULT_ALLOCATIONS: Readonly<Record<BudgetBucket, number>> = {
  decisions: 5,
  implementation: 140,
  "premium-api": 40,
  emergency: 15,
};
export class ApiBudget {
  private readonly reserved = new Map<string, { bucket: BudgetBucket; usd: number }>();
  private readonly settled = new Map<BudgetBucket, number>();
  public grant: Grant;
  private readonly caps: Record<BudgetBucket, number>;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  constructor(
    grant: Grant,
    caps: Record<BudgetBucket, number>,
    now: () => number,
    maxAgeMs = 15 * 60_000,
  ) {
    this.grant = grant;
    this.caps = caps;
    this.now = now;
    this.maxAgeMs = maxAgeMs;
    const sum = Object.values(caps).reduce((a, b) => a + b, 0);
    if (sum > 200 || Object.values(caps).some((x) => !Number.isFinite(x) || x < 0))
      throw Error("Invalid budget caps");
  }
  get allocatedUsd(): number {
    return Object.values(this.caps).reduce((a, b) => a + b, 0);
  }
  isVerified(): boolean {
    return (
      this.grant.claimedUsd !== null &&
      this.grant.remainingUsd !== null &&
      this.grant.verifiedAtMs !== null &&
      this.now() - this.grant.verifiedAtMs <= this.maxAgeMs &&
      this.now() >= this.grant.verifiedAtMs &&
      this.grant.claimedUsd >= 0 &&
      this.grant.remainingUsd >= 0 &&
      this.grant.remainingUsd <= this.grant.claimedUsd &&
      !!this.grant.billingCycleEnd &&
      Date.parse(this.grant.billingCycleEnd) > this.now()
    );
  }
  used(bucket: BudgetBucket): number {
    return this.settled.get(bucket) ?? 0;
  }
  pending(bucket: BudgetBucket): number {
    return [...this.reserved.values()]
      .filter((x) => x.bucket === bucket)
      .reduce((s, x) => s + x.usd, 0);
  }
  canReserve(bucket: BudgetBucket, usd: number): boolean {
    if (!this.isVerified() || !Number.isFinite(usd) || usd <= 0) return false;
    if (this.grant.claimedUsd! < this.allocatedUsd) return false;
    if (this.used(bucket) + this.pending(bucket) + usd > this.caps[bucket] + 1e-8) return false;
    const allPending = [...this.reserved.values()].reduce((s, x) => s + x.usd, 0);
    return allPending + usd <= this.grant.remainingUsd! + 1e-8;
  }
  reserve(opId: string, bucket: BudgetBucket, usd: number): boolean {
    if (!opId || this.reserved.has(opId) || !this.canReserve(bucket, usd)) return false;
    this.reserved.set(opId, { bucket, usd });
    return true;
  }
  settle(opId: string, actualUsd: number): boolean {
    const res = this.reserved.get(opId);
    if (!res || !Number.isFinite(actualUsd) || actualUsd < 0) return false;
    // If actual exceeds provisional reservation, caller must reconcile provider balance / debt
    // and block future dispatch, rather than silently rewriting the reserve.
    this.reserved.delete(opId);
    this.settled.set(res.bucket, this.used(res.bucket) + actualUsd);
    if (this.grant.remainingUsd !== null)
      this.grant.remainingUsd = Math.max(0, this.grant.remainingUsd - actualUsd);
    if (actualUsd > res.usd) this.grant.verifiedAtMs = null;
    return true;
  }
  release(opId: string): boolean {
    return this.reserved.delete(opId);
  }
}
