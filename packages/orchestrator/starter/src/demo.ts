import { catalog, validateCatalog } from "./policy.ts";
import { decideRoute } from "./router.ts";
import type { Task } from "./types.ts";
validateCatalog(catalog);
const task: Task = {
  workflowId: "demo",
  taskId: "fix-1",
  role: "implement-simple",
  dataScope: "public",
  worktree: "/demo/fix-1",
  contractHash: "abc",
  configurationHash: "v2",
  requiredCapabilities: ["code"],
  minTier: 1,
  highRisk: false,
  estimatedCostUsd: 0.1,
  isMutation: true,
};
const result = decideRoute({
  task,
  routes: catalog,
  sessions: [],
  leases: [],
  nowMs: Date.now(),
  budgetAllowed: () => true,
  verifiedProviderModel: () => true,
});
console.log(JSON.stringify(result, null, 2));
