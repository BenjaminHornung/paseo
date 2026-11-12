export type Access =
  | "codex-pro200"
  | "claude-company-pro"
  | "claude-personal-pro"
  | "opencode-go"
  | "openai-api"
  | "anthropic-api";
export type Role =
  | "triage"
  | "planner"
  | "advisor"
  | "implement-simple"
  | "implement-normal"
  | "implement-complex"
  | "reviewer";
export type QualityTier = 1 | 2 | 3;
export type BudgetBucket = "decisions" | "implementation" | "premium-api" | "emergency";
export interface Route {
  id: string;
  access: Access;
  harness: "paseo" | "pi" | "api";
  model: string;
  tier: QualityTier;
  reasoning: "" | "off" | "low" | "medium" | "high" | "xhigh" | "max" | "ultracode";
  /** Ignored legacy configuration. */
  dataScopes?: readonly string[];
  capabilities: readonly string[];
  budgetBucket?: BudgetBucket;
  maxUsdPerTask?: number;
  verified: boolean;
  enabled: boolean;
  healthy: boolean;
  quotaAvailable: boolean;
  priority: number;
  ownerApproved: boolean;
  modelRevision?: string;
}
export interface Task {
  workflowId: string;
  taskId: string;
  role: Role;
  /** Ignored legacy task metadata. */
  dataScope?: string;
  worktree: string;
  contractHash: string;
  configurationHash: string;
  requiredCapabilities: readonly string[];
  minTier: QualityTier;
  highRisk: boolean;
  estimatedCostUsd: number;
  preferredRouteId?: string;
  reviewImplementationRouteId?: string;
  isMutation: boolean;
}
export interface Session {
  id: string;
  workflowId: string;
  taskId: string;
  role: Role;
  worktree: string;
  routeId: string;
  model: string;
  modelRevision: string;
  access: Access;
  contractHash: string;
  configurationHash: string;
  /** Ignored legacy session metadata. */
  dataScope?: string;
  status: "idle" | "running" | "permission" | "unknown" | "ended";
  lastReconciledMs: number;
  lastUsedMs: number;
  contextFraction: number;
}
export interface WorktreeLease {
  worktree: string;
  ownerWorkflowId: string;
  state: "held" | "suspect" | "released";
  fencingToken: number;
}
export interface RoutingDecision {
  action: "reuse" | "reconcile" | "start" | "wait" | "compact";
  route?: Route;
  sessionId?: string;
  reason: string;
}
export type ProviderFailure =
  | "quota-5h"
  | "quota-week"
  | "quota-month"
  | "rate-limited"
  | "transient"
  | "transport-unknown"
  | "auth"
  | "permission"
  | "model-missing"
  | "quality"
  | "invalid-data"
  | "flex-unavailable"
  | "task-budget";
