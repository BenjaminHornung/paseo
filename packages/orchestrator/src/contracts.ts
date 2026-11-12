import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  workCategorySchema,
  workKindSchema,
  type WorkCategory,
} from "../paseo-plugin/shared/work-categories.ts";
import {
  claudeSubscriptionAccess,
  isClaudeProvider,
  isClaudeSubscription,
} from "../paseo-plugin/shared/providers.ts";
import { reviewFindingsSchema } from "../paseo-plugin/shared/continuation.ts";
export {
  reviewFindingsSchema,
  continuationRepairSchema,
} from "../paseo-plugin/shared/continuation.ts";

export const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const bucket = z.enum(["decisions", "implementation", "premium-api", "emergency"]);
export const microUsd = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const contractSchema = z
  .strictObject({
    schemaVersion: z.literal(1).default(1),
    workflowId: identifier,
    taskId: identifier,
    intakeId: digest.optional(),
    packageAssessmentId: digest.optional(),
    packageRevision: z.number().int().positive().optional(),
    amendsTaskKey: z.string().min(1).max(240).optional(),
    amendsContractHash: digest.optional(),
    amendsDiffHash: digest.optional(),
    references: z.array(z.string().max(1000)).max(30).optional(),
    dependencies: z.array(z.string().max(160)).max(30).optional(),
    interfaces: z.array(z.string().max(300)).max(30).optional(),
    unknowns: z.array(z.string().max(500)).max(20).optional(),
    repository: z.string().min(1),
    worktree: z.string().min(1),
    workspace: z
      .strictObject({
        id: z.string().min(1),
        directory: z.string().min(1),
        mainAgentId: z.string().min(1),
      })
      .optional(),
    baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    // Ignored legacy input: retain pinned contract bytes and hashes.
    dataScope: z.string().optional(),
    role: z.enum([
      "planner",
      "advisor",
      "implement-simple",
      "implement-normal",
      "implement-complex",
      "reviewer",
    ]),
    prompt: z.string().min(1).max(24000),
    acceptance: z.array(z.string().min(1)).min(1).max(30),
    allowedPaths: z
      .array(
        z
          .string()
          .min(1)
          .refine(
            (p) =>
              !path.isAbsolute(p) &&
              !p.includes("\\") &&
              !p.includes(":") &&
              !p
                .replace(/\/$/, "")
                .split("/")
                .some((s) => s === ".." || s === ".git" || s === ""),
            "repository-relative path required",
          ),
      )
      .min(1),
    requiredCapabilities: z.array(z.enum(["code", "text"])).min(1),
    minTier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    mutation: z.boolean(),
    highRisk: z.boolean(),
    uiChanged: z.boolean(),
    workKind: workKindSchema.optional(),
    ownerApproved: z.boolean().default(false),
    estimatedMicroUsd: microUsd.default(0),
    implementationAgentId: z.string().min(1).optional(),
    reviewDiffHash: digest.optional(),
    checks: z.strictObject({
      build: z.array(z.string().min(1)).min(1),
      test: z.array(z.string().min(1)).min(1),
    }),
  })
  .superRefine((c, ctx) => {
    const amendmentFields = [c.amendsTaskKey, c.amendsContractHash, c.amendsDiffHash];
    if (
      amendmentFields.some((value) => value !== undefined) &&
      amendmentFields.some((value) => value === undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "amendment lineage requires predecessor task, contract and diff hashes",
      });
    if (c.amendsTaskKey && (!c.mutation || !c.role.startsWith("implement-")))
      ctx.addIssue({
        code: "custom",
        message: "amendment lineage requires a mutating implementation task",
      });
    if (c.role === "reviewer" && (c.mutation || !c.implementationAgentId || !c.reviewDiffHash))
      ctx.addIssue({
        code: "custom",
        message: "reviewer requires read-only contract, implementation identity and diff hash",
      });
    if (c.highRisk && c.minTier !== 3)
      ctx.addIssue({ code: "custom", message: "high-risk work requires tier 3" });
  });
export type Contract = z.infer<typeof contractSchema>;

export function pathInScope(file: string, allowed: string): boolean {
  const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const root = normalize(allowed).replace(/\/$/, "");
  const target = normalize(file).replace(/\/$/, "");
  return target === root || target.startsWith(`${root}/`);
}

export const routeSchema = z
  .strictObject({
    id: identifier,
    name: z.string().trim().min(1).max(120).optional(),
    access: z.enum([
      "codex-pro200",
      "claude-company-pro",
      "claude-personal-pro",
      "opencode-go",
      "openai-api",
    ]),
    provider: z.enum(["codex", "claude", "claude-private", "pi"]),
    model: z.string().min(1),
    revision: z.string().min(1),
    reasoning: z.enum(["", "off", "low", "medium", "high", "xhigh", "max", "ultracode"]),
    tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    modeId: z.string().min(1).optional(),
    profileId: z.string().min(1).optional(),
    profileName: z.string().min(1).optional(),
    featureValues: z
      .record(z.string(), z.union([z.string(), z.boolean(), z.number(), z.null()]))
      .optional(),
    enabled: z.boolean(),
    maxConcurrent: z.number().int().min(1).max(10),
    // Ignored legacy configuration; routing no longer classifies data privacy.
    dataScopes: z.array(z.string()).optional(),
    capabilities: z.array(z.enum(["code", "text"])).min(1),
    bucket: bucket.optional(),
    repositoryRoots: z
      .array(
        z
          .string()
          .min(1)
          .refine((root) => path.isAbsolute(root), "absolute repository root required"),
      )
      .optional(),
    maxTaskMicroUsd: microUsd.min(10000).optional(),
  })
  .superRefine((r, ctx) => {
    const expectedAccess = isClaudeProvider(r.provider)
      ? claudeSubscriptionAccess[r.provider]
      : undefined;
    if (
      (expectedAccess !== undefined && r.access !== expectedAccess) ||
      (expectedAccess === undefined && isClaudeSubscription(r.access))
    )
      ctx.addIssue({
        code: "custom",
        message: "Claude provider requires its matching separate subscription route",
      });
    if (isClaudeSubscription(r.access) && (r.bucket || (r.enabled && !r.repositoryRoots?.length)))
      ctx.addIssue({
        code: "custom",
        message: "Claude requires explicit repository roots without an API bucket",
      });
    if (r.access === "openai-api" && r.enabled && !r.repositoryRoots?.length)
      ctx.addIssue({ code: "custom", message: "API routes require explicit repository roots" });
    if (!isClaudeProvider(r.provider) && ["", "off", "ultracode"].includes(r.reasoning))
      ctx.addIssue({
        code: "custom",
        message: "Reasoning option requires a matching Claude catalog model",
      });
    if (r.access === "codex-pro200" && (r.provider !== "codex" || r.bucket))
      ctx.addIssue({ code: "custom", message: "subscription requires codex without API bucket" });
    if (
      r.access === "opencode-go" &&
      (r.provider !== "pi" || r.model !== "opencode-go/deepseek-v4.1-flash" || r.bucket)
    )
      ctx.addIssue({
        code: "custom",
        message: "Go requires DeepSeek via Pi without an API bucket",
      });
    if (
      r.access === "openai-api" &&
      (r.provider !== "pi" ||
        !r.model.startsWith("openai/") ||
        !r.bucket ||
        r.bucket === "decisions")
    )
      ctx.addIssue({
        code: "custom",
        message: "API coding requires separate Pi OpenAI route and coding bucket",
      });
  });
export type RuntimeRoute = z.infer<typeof routeSchema>;
export function apiTaskReservation(
  contract: Contract,
  route: RuntimeRoute,
  available?: number,
): number {
  const limit = Math.min(
    route.maxTaskMicroUsd ?? available ?? 0,
    available ?? Number.MAX_SAFE_INTEGER,
  );
  if (!Number.isSafeInteger(limit) || limit <= 0) throw Error("API monthly budget exhausted");
  const amount = contract.estimatedMicroUsd || limit;
  if (amount > limit) throw Error("Task estimate exceeds API route limit");
  return amount;
}
export function routeAllowsPath(route: RuntimeRoute, cwd: string): boolean {
  if (
    !route.repositoryRoots?.length &&
    !isClaudeSubscription(route.access) &&
    route.access !== "openai-api"
  )
    return true;
  try {
    const target = canonicalPath(cwd);
    return !!route.repositoryRoots?.some((root) => {
      const relative = path.relative(canonicalPath(root), target);
      return (
        relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      );
    });
  } catch {
    return false;
  }
}
export const decisionSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  model: z.literal("gpt-6-luna"),
  roles: z.array(
    z.enum([
      "planner",
      "advisor",
      "implement-simple",
      "implement-normal",
      "implement-complex",
      "reviewer",
    ]),
  ),
  // Ignored legacy configuration; no privacy policy is enforced.
  dataScopes: z.array(z.string()).optional(),
  minConfidence: z.number().min(0.5).max(1),
  timeoutMs: z.number().int().min(1000).max(30000),
  monthlyBudgetMicroUsd: microUsd.max(5000000),
  maxCallMicroUsd: microUsd.min(1000).max(50000),
  fundsConfirmed: z.boolean(),
  validUntil: z.string().max(40),
  projectId: z
    .string()
    .max(120)
    .regex(/^(?:proj_[a-zA-Z0-9_-]+)?$/),
});
export type DecisionSettings = z.infer<typeof decisionSettingsSchema>;
export const defaultDecisionSettings = (): DecisionSettings => ({
  enabled: false,
  model: "gpt-6-luna",
  roles: [],
  minConfidence: 0.75,
  timeoutMs: 10000,
  monthlyBudgetMicroUsd: 5000000,
  maxCallMicroUsd: 50000,
  fundsConfirmed: false,
  validUntil: "",
  projectId: "",
});
function validateWorkCategories(
  categories: WorkCategory[] | undefined,
  routes: { id: string }[],
  context: z.RefinementCtx,
): void {
  const ids = new Set<string>();
  const routeIds = new Set(routes.map((route) => route.id));
  for (const category of categories ?? []) {
    if (ids.has(category.id))
      context.addIssue({ code: "custom", message: "duplicate work category IDs" });
    ids.add(category.id);
    if (category.routeIds.some((id) => !routeIds.has(id)))
      context.addIssue({ code: "custom", message: "workCategories references an unknown route" });
  }
}
export const configSchema = z
  .strictObject({
    orchestrationVersion: z.union([z.literal(2), z.literal(3)]).optional(),
    reminderInterval: z.number().int().min(5).max(10).optional(),
    schemaVersion: z.literal(1),
    daemonUrl: z
      .string()
      .url()
      .refine((s) => {
        const u = new URL(s);
        return (
          u.protocol === "ws:" &&
          u.hostname === "127.0.0.1" &&
          !u.username &&
          !u.password &&
          u.pathname === "/ws" &&
          !u.search
        );
      }, "loopback daemon only"),
    gitExecutable: z.string().min(1),
    maxWorkflows: z.number().int().min(1).max(2),
    maxRework: z.number().int().min(0).max(2),
    apiEnabled: z.boolean(),
    apiFunding: z
      .strictObject({
        confirmed: z.boolean(),
        cycle: z.string().regex(/^\d{4}-\d{2}$/),
        availableMicroUsd: microUsd,
        validUntil: z.string().min(1),
      })
      .optional(),
    liveDispatchApproved: z.boolean(),
    decisions: decisionSettingsSchema.optional(),
    workCategories: z.array(workCategorySchema).optional(),
    roleRoutes: z
      .strictObject({
        planner: z.array(identifier).min(1),
        advisor: z.array(identifier).min(1),
        "implement-simple": z.array(identifier).min(1),
        "implement-normal": z.array(identifier).min(1),
        "implement-complex": z.array(identifier).min(1),
        ui: z.array(identifier).min(1).optional(),
        reviewer: z.array(identifier).min(1),
      })
      .optional(),
    budgets: z.strictObject({
      decisions: microUsd,
      implementation: microUsd,
      "premium-api": microUsd,
      emergency: microUsd,
    }),
    routes: z.array(routeSchema).min(1),
  })
  .superRefine((c, ctx) => {
    if (new Set(c.routes.map((r) => r.id)).size !== c.routes.length)
      ctx.addIssue({ code: "custom", message: "duplicate route IDs" });
    validateWorkCategories(c.workCategories, c.routes, ctx);
    if (c.routes.some((r) => r.access === "openai-api" && r.enabled) && !c.apiEnabled)
      ctx.addIssue({
        code: "custom",
        message: "API routes require explicit API dispatch approval",
      });
    if (
      c.apiEnabled &&
      (!c.apiFunding?.confirmed ||
        !Number.isFinite(Date.parse(c.apiFunding.validUntil)) ||
        Object.values(c.budgets).reduce((sum, value) => sum + value, 0) >
          c.apiFunding.availableMicroUsd)
    )
      ctx.addIssue({
        code: "custom",
        message: "API dispatch requires confirmed credits covering every budget bucket",
      });
    if (
      c.roleRoutes &&
      Object.values(c.roleRoutes).some((ids) =>
        ids?.some((id) => !c.routes.some((r) => r.id === id)),
      )
    )
      ctx.addIssue({ code: "custom", message: "roleRoutes references an unknown route" });
    if (c.decisions && c.decisions.monthlyBudgetMicroUsd > c.budgets.decisions)
      ctx.addIssue({
        code: "custom",
        message: "Decisions cannot spend the protected reserve twice",
      });
    if (
      c.decisions?.enabled &&
      (!c.decisions.fundsConfirmed || !Number.isFinite(Date.parse(c.decisions.validUntil)))
    )
      ctx.addIssue({
        code: "custom",
        message: "Decisions requires an explicit funded validity period",
      });
  });
export type Config = z.infer<typeof configSchema>;

export const evidenceSchema = z.strictObject({
  diffHash: digest,
  reviewedDiffHash: digest,
  implementationAgentId: z.string().min(1),
  reviewerAgentId: z.string().min(1),
  buildExit: z.number().int(),
  testExit: z.number().int(),
  reviewPass: z.boolean(),
  visualAcceptance: z.boolean(),
  ownerApproved: z.boolean(),
  scopeViolations: z.number().int().nonnegative(),
  unresolvedIssues: z.number().int().nonnegative(),
  artifacts: z.array(z.string().min(1)).min(1),
});
export type Evidence = z.infer<typeof evidenceSchema>;
export const reviewResultSchema = z.strictObject({
  diffHash: digest,
  pass: z.boolean(),
  unresolvedIssues: z.number().int().nonnegative(),
  findings: reviewFindingsSchema.optional(),
});
export type ReviewResult = z.infer<typeof reviewResultSchema>;
export const workPackageSchema = z.strictObject({
  goal: z.string().min(1),
  files: z.array(z.string()).min(1),
  interfaces: z.array(z.string()),
  acceptance: z.array(z.string()).min(1),
  constraints: z.array(z.string()),
  allowedChanges: z.array(z.string()).min(1),
  checks: z.strictObject({ build: z.array(z.string()).min(1), test: z.array(z.string()).min(1) }),
  references: z.array(z.string()),
  dependencies: z.array(z.string()),
  risks: z.array(z.string()),
});
export const planResultSchema = z.strictObject({
  steps: z.array(z.string().min(1)).min(1).max(10),
  acceptance: z.array(z.string().min(1)).min(1).max(10),
  workPackages: z.array(workPackageSchema).min(1).max(4).optional(),
});
export type PlanResult = z.infer<typeof planResultSchema>;
export function parseAgentJson<T>(text: string, schema: z.ZodType<T>): T | undefined {
  const value = text
    .trim()
    .replace(/^---\s*\n/, "")
    .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
  try {
    const result = schema.safeParse(JSON.parse(value));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export function hash(value: unknown): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, stable(x)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}
export function canonicalPath(value: string): string {
  const p = realpathSync.native(path.resolve(value));
  return process.platform === "win32" ? p.toLowerCase() : p;
}
export function localPath(value: string): string {
  // Installed tools (including Playwright browsers) may reside outside the
  // source tree. Scope and provider approval are checked independently.
  return canonicalPath(value);
}
