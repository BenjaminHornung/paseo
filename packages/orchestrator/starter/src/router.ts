import type { Route, RoutingDecision, Session, Task, WorktreeLease } from "./types.ts";
import { routePreference } from "./policy.ts";
import type { Role } from "./types.ts";
/** This preflight is pure. Real dispatcher MUST reserve budget and obtain a fenced writer lease atomically. */
export function decideRoute(input: {
  task: Task;
  routes: readonly Route[];
  sessions: readonly Session[];
  leases: readonly WorktreeLease[];
  nowMs: number;
  budgetAllowed: (route: Route, estimateUsd: number) => boolean;
  verifiedProviderModel: (r: Route) => boolean;
  preferences?: Partial<Record<Role, readonly string[]>>;
}): RoutingDecision {
  const { task, routes, sessions, leases, nowMs, budgetAllowed, verifiedProviderModel } = input;
  if (!Number.isFinite(nowMs)) throw new Error("Invalid time");
  // A suspect lease is not a free worktree. A completed timeout does not imply cancellation.
  if (task.isMutation && leases.some((l) => l.worktree === task.worktree && l.state !== "released"))
    return { action: "reconcile", reason: "writer-lease-not-confirmed-released" };
  const possiblyLive = sessions.find(
    (s) => s.worktree === task.worktree && ["running", "unknown", "permission"].includes(s.status),
  );
  if (possiblyLive)
    return { action: "reconcile", sessionId: possiblyLive.id, reason: "agent-outcome-unknown" };
  const orderedIds = input.preferences?.[task.role] ?? routePreference[task.role];
  const candidates = routes
    .filter((r) => orderedIds.includes(r.id))
    .filter(
      (r) =>
        r.enabled &&
        r.ownerApproved &&
        r.verified &&
        r.healthy &&
        r.quotaAvailable &&
        verifiedProviderModel(r) &&
        r.tier >= task.minTier &&
        r.dataScopes.includes(task.dataScope) &&
        task.requiredCapabilities.every((c) => r.capabilities.includes(c)) &&
        (!task.highRisk || r.tier === 3) &&
        !(task.role === "reviewer" && task.reviewImplementationRouteId === r.id) &&
        (!r.budgetBucket || budgetAllowed(r, task.estimatedCostUsd)),
    )
    .sort((a, b) => orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id) || a.priority - b.priority);
  // Sticky, compatible idle agent beats a new model only after suitability and health filters.
  const previous = sessions
    .filter(
      (s) =>
        s.status === "idle" &&
        s.workflowId === task.workflowId &&
        s.taskId === task.taskId &&
        s.role === task.role &&
        s.worktree === task.worktree &&
        s.contractHash === task.contractHash &&
        s.configurationHash === task.configurationHash &&
        s.dataScope === task.dataScope,
    )
    .sort((a, b) => b.lastUsedMs - a.lastUsedMs);
  for (const s of previous) {
    const r = candidates.find(
      (r) =>
        r.id === s.routeId &&
        r.model === s.model &&
        r.access === s.access &&
        (r.modelRevision ?? "") === s.modelRevision,
    );
    if (!r) continue;
    if (s.lastReconciledMs > nowMs || nowMs - s.lastReconciledMs > 60_000)
      return {
        action: "reconcile",
        sessionId: s.id,
        route: r,
        reason: "stale-session-needs-refresh",
      };
    if (s.contextFraction >= 0.8 || s.contextFraction < 0)
      return {
        action: "compact",
        sessionId: s.id,
        route: r,
        reason: "context-capacity-checkpoint",
      };
    return {
      action: "reuse",
      sessionId: s.id,
      route: r,
      reason: "same-task-role-model-and-context",
    };
  }
  if (candidates[0])
    return { action: "start", route: candidates[0], reason: "quality-data-budget-then-priority" };
  return { action: "wait", reason: "no-safe-and-funded-candidate" };
}
