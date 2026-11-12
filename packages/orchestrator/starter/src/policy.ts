import type { Role, Route } from "./types.ts";
/** Offline defaults. Production must discover the exact CLI model IDs and account rights. */
const mk = (
  id: string,
  access: Route["access"],
  harness: Route["harness"],
  model: string,
  tier: Route["tier"],
  priority: number,
  dataScopes: Route["dataScopes"],
  reasoning: Route["reasoning"],
  budgetBucket?: Route["budgetBucket"],
  enabled = true,
  ownerApproved = true,
): Route => ({
  id,
  access,
  harness,
  model,
  tier,
  priority,
  dataScopes,
  reasoning,
  budgetBucket,
  enabled,
  ownerApproved,
  capabilities: ["code", "text"],
  verified: true,
  healthy: true,
  quotaAvailable: true,
});
export const catalog: readonly Route[] = [
  mk(
    "codex-sol",
    "codex-pro200",
    "paseo",
    "gpt-6.1-sol",
    3,
    30,
    ["public", "personal", "company", "restricted"],
    "high",
  ),
  mk(
    "codex-astra",
    "codex-pro200",
    "paseo",
    "gpt-6-astra",
    3,
    60,
    ["public", "personal", "company", "restricted"],
    "xhigh",
  ),
  mk(
    "codex-terra",
    "codex-pro200",
    "paseo",
    "gpt-6.1-terra",
    2,
    20,
    ["public", "personal", "company", "restricted"],
    "medium",
  ),
  mk(
    "pi-terra-api",
    "openai-api",
    "pi",
    "gpt-6.1-terra",
    2,
    45,
    ["public", "personal", "company"],
    "medium",
    "implementation",
  ),
  mk(
    "pi-sol-api",
    "openai-api",
    "pi",
    "gpt-6.1-sol",
    3,
    55,
    ["public", "personal", "company"],
    "high",
    "premium-api",
  ),
  mk(
    "pi-astra-api",
    "openai-api",
    "pi",
    "gpt-6-astra",
    3,
    95,
    ["public", "personal", "company"],
    "high",
    "premium-api",
  ),
  mk(
    "pi-luna-api",
    "openai-api",
    "pi",
    "gpt-6-luna",
    1,
    85,
    ["public", "personal", "company"],
    "low",
    "emergency",
  ),
  mk(
    "decisions-luna",
    "openai-api",
    "api",
    "gpt-6-luna",
    1,
    10,
    ["public", "personal", "company"],
    "low",
    "decisions",
  ),
  mk("deepseek-go", "opencode-go", "pi", "deepseek-v4.1-flash", 1, 5, ["public"], "medium"),
  // Company-owned identity: disabled by default, even if discovered. Only explicit authorization enables it.
  mk(
    "claude-company-review",
    "claude-company-pro",
    "paseo",
    "CLAUDE_MODEL_DISCOVER_FIRST",
    3,
    10,
    ["company"],
    "high",
    undefined,
    false,
    false,
  ),
  // No Anthropic API grant in Variant A. Requires explicit separately funded API access.
  mk(
    "haiku-api-opt-in",
    "anthropic-api",
    "pi",
    "claude-haiku-5-5",
    1,
    4,
    ["public", "personal"],
    "low",
    undefined,
    false,
    false,
  ),
];
export const routePreference: Record<Role, readonly string[]> = {
  triage: ["decisions-luna"],
  planner: ["codex-sol", "codex-astra", "pi-sol-api", "pi-astra-api"],
  advisor: ["claude-company-review", "codex-sol", "codex-astra"],
  "implement-simple": [
    "haiku-api-opt-in",
    "deepseek-go",
    "codex-terra",
    "pi-terra-api",
    "pi-luna-api",
  ],
  "implement-normal": ["codex-terra", "pi-terra-api", "codex-sol", "pi-sol-api"],
  "implement-complex": ["codex-sol", "codex-astra", "pi-sol-api", "pi-astra-api"],
  reviewer: ["claude-company-review", "codex-astra", "codex-sol", "pi-sol-api"],
};
export function validateCatalog(routes: readonly Route[]): void {
  for (const r of routes) {
    if (r.access === "opencode-go" && (r.id !== "deepseek-go" || r.model !== "deepseek-v4.1-flash"))
      throw new Error("OpenCode Go is reserved exclusively for DeepSeek V4.1 Flash");
    if (
      r.access === "claude-company-pro" &&
      r.enabled &&
      (!r.ownerApproved || r.dataScopes.some((x) => x !== "company"))
    )
      throw new Error("Company Claude Pro requires approval and company-only scope");
    if (r.access === "anthropic-api" && r.enabled && !r.ownerApproved)
      throw new Error("No Anthropic API credit is included in Variant A");
    if (r.dataScopes.length === 0 || !r.model || !r.id || r.priority < 0)
      throw new Error(`Invalid route ${r.id}`);
  }
}
