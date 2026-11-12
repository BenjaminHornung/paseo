import { z } from "zod";
import { hash, type Contract } from "./contracts.ts";

const dataScope = z.enum(["public", "personal", "company", "restricted"]);
export const intentSchema = z.enum([
  "question",
  "status",
  "new-task",
  "change-request",
  "review-request",
  "approval",
  "cancel",
  "other",
]);
export const intakeFactsSchema = z.strictObject({
  mainAgentId: z.string().min(1),
  messageId: z.string().min(1),
  messageRevision: z.number().int().positive().default(1),
  factsRevision: z.number().int().positive().default(1),
  origin: z.enum(["human", "unverified"]),
  directory: z.string().min(1),
  text: z.string().min(1).max(12000),
  dataScope,
  knownFacts: z.array(z.string().max(1000)).max(12).default([]),
});
export type IntakeFacts = z.infer<typeof intakeFactsSchema>;
export const intakeResultSchema = z.strictObject({
  intent: intentSchema,
  needExplorer: z.boolean(),
  needPlanner: z.boolean(),
  needAdvisor: z.boolean(),
  needImplementation: z.boolean(),
  extraReviewRecommended: z.boolean(),
});
export const packageFactsSchema = z.strictObject({
  mainAgentId: z.string().min(1),
  intakeId: z.string().min(1),
  packageId: z.string().min(1),
  packageRevision: z.number().int().positive().default(1),
  dataScope,
  amendsTaskKey: z.string().min(1).max(240).optional(),
  amendsContractHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  amendsDiffHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  repository: z.string().min(1),
  baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  goal: z.string().min(1).max(12000),
  acceptance: z.array(z.string().min(1)).min(1).max(30),
  originalRequest: z.string().max(12000).optional(),
  checks: z.object({ build: z.array(z.string()), test: z.array(z.string()) }).optional(),
  mutation: z.boolean().optional(),
  uiChanged: z.boolean().optional(),
  files: z.array(z.string().min(1)).min(1).max(100),
  interfaces: z.array(z.string().max(300)).max(30).default([]),
  dependencies: z.array(z.string().max(160)).max(30).default([]),
  risks: z.array(z.string().max(300)).max(20).default([]),
  unknowns: z.array(z.string().max(500)).max(20).default([]),
  evidence: z
    .array(z.object({ id: z.string(), revision: z.string(), summary: z.string().max(500) }))
    .max(30)
    .default([]),
  priorFindings: z.array(z.string().max(500)).max(20).default([]),
});
export type PackageFacts = z.infer<typeof packageFactsSchema>;
export const packageResultSchema = z.strictObject({
  workKind: z.enum(["ui", "general"]).optional(),
  complexity: z.enum(["simple", "normal", "complex", "unknown"]),
  additionalPlanning: z.boolean(),
  advisorNeeded: z.boolean(),
  shouldSplit: z.boolean(),
  extraReviewRecommended: z.boolean(),
});
export type IntakeResult = z.infer<typeof intakeResultSchema>;
export type PackageResult = z.infer<typeof packageResultSchema>;
export interface DecisionRequestAudit {
  model: string;
  payloadHash: string;
  minConfidence: number;
  attemptedAt: number;
  questions: {
    type: "choice";
    name: string;
    instructions: string;
    choices: { value: string | boolean; description?: string }[];
  }[];
  requestId?: string;
  httpStatus?: number;
}
export interface DecisionResponseAudit {
  model: string;
  answers: (
    | { type: "refusal"; name: string | null }
    | {
        type: "choice";
        name: string;
        choice: string | boolean;
        confidence: number;
        probabilities: { value: string | boolean; probability: number }[];
      }
  )[];
  usage: {
    input_tokens: number;
    input_tokens_details: { cached_tokens: number; cache_write_tokens: number };
  };
}
export interface Assessment<T> {
  id: string;
  kind: "intake" | "package";
  factsHash: string;
  version: string;
  source: "decisions" | "fallback" | "operator-confirmed";
  reason: string;
  result: T;
  confidence?: number;
  answers?: {
    name: string;
    value: string | boolean;
    confidence: number;
    selectedProbability?: number;
  }[];
  request?: DecisionRequestAudit;
  response?: DecisionResponseAudit;
}
export interface Classifier {
  classifyIntake(
    facts: IntakeFacts,
    config: import("./contracts.ts").Config,
  ): Promise<Assessment<IntakeResult>>;
  classifyPackage(
    facts: PackageFacts,
    config: import("./contracts.ts").Config,
  ): Promise<Assessment<PackageResult>>;
}
export function intakeIdentity(facts: IntakeFacts): string {
  return hash({
    kind: "intake-v3",
    main: facts.mainAgentId,
    message: facts.messageId,
    messageRevision: facts.messageRevision,
    factsRevision: facts.factsRevision,
  });
}
export function packageIdentity(facts: PackageFacts): string {
  return hash({
    kind: "package-v3",
    main: facts.mainAgentId,
    package: facts.packageId,
    revision: facts.packageRevision,
  });
}
export function fallbackIntake(facts: IntakeFacts): IntakeResult {
  const text = facts.text.trim().toLowerCase();
  const base = {
    needExplorer: false,
    needPlanner: false,
    needAdvisor: false,
    needImplementation: false,
    extraReviewRecommended: false,
  };
  if (
    /^(?:status\s*\??|wie (?:weit|ist der stand)|was ist der stand|fortschritt\s*\??)/i.test(text)
  )
    return { ...base, intent: "status" };
  if (/^(?:abbruch|abbrechen|stop(?:p)?|pausieren|arbeit pausieren)[.!\s]*$/i.test(text))
    return { ...base, intent: "cancel" };
  if (/^(?:was|wie|warum|welch|kann|ist|sind|gibt)\b/i.test(text) && text.endsWith("?"))
    return { ...base, intent: "question" };
  // Failed semantic classification cannot authorize a new writing worker.
  return { ...base, intent: "other", needPlanner: true };
}
export function fallbackPackage(): PackageResult {
  return {
    complexity: "unknown",
    additionalPlanning: true,
    advisorNeeded: false,
    shouldSplit: false,
    extraReviewRecommended: true,
  };
}
export function effectiveImplementation(
  result: PackageResult,
  contract: Contract,
): { role: Contract["role"]; minTier: 1 | 2 | 3; highRisk: boolean; workKind?: "ui" | "general" } {
  if (result.complexity === "unknown") throw Error("PACKAGE_CLASSIFICATION_REQUIRED");
  if (result.additionalPlanning) throw Error("PACKAGE_ADDITIONAL_PLANNING_REQUIRED");
  const hardRisk =
    contract.highRisk ||
    contract.allowedPaths.some((file) =>
      /(?:^|\/)(?:migrations?|security|authentication|authorization|recovery|concurrency|budgets?)(?:\/|\.)/i.test(
        file,
      ),
    );
  const complexity = hardRisk ? "complex" : result.complexity;
  return {
    ...(result.workKind ? { workKind: result.workKind } : {}),
    role:
      complexity === "simple"
        ? "implement-simple"
        : complexity === "normal"
          ? "implement-normal"
          : "implement-complex",
    minTier: complexity === "simple" ? 1 : complexity === "normal" ? 2 : 3,
    highRisk: hardRisk || complexity === "complex",
  };
}
