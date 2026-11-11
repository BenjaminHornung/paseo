import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const roles = [
  "planner",
  "advisor",
  "implement-simple",
  "implement-normal",
  "implement-complex",
  "reviewer",
] as const;
export type Role = (typeof roles)[number];
export const routingCategories = [...roles, "ui"] as const;
export type RoutingCategory = (typeof routingCategories)[number];
export interface DecisionSettings {
  enabled: boolean;
  model: "gpt-6-luna";
  roles: Role[];
  dataScopes: string[];
  minConfidence: number;
  timeoutMs: number;
  monthlyBudgetMicroUsd: number;
  maxCallMicroUsd: number;
  fundsConfirmed: boolean;
  validUntil: string;
  projectId: string;
}
export interface Route {
  id: string;
  name?: string;
  access: string;
  provider: "codex" | "claude" | "pi";
  model: string;
  revision: string;
  reasoning: string;
  tier: number;
  modeId?: string;
  profileId?: string;
  profileName?: string;
  enabled: boolean;
  maxConcurrent: number;
  dataScopes: string[];
  capabilities: string[];
  featureValues?: Record<string, string | number | boolean | null>;
  bucket?: string;
  repositoryRoots?: string[];
  maxTaskMicroUsd?: number;
}
export interface ControllerConfig {
  schemaVersion: 1;
  daemonUrl: string;
  gitExecutable: string;
  orchestrationVersion?: 2 | 3;
  reminderInterval?: number;
  maxWorkflows: number;
  maxRework: number;
  apiEnabled: boolean;
  liveDispatchApproved: boolean;
  apiFunding?: { confirmed: boolean; cycle: string; availableMicroUsd: number; validUntil: string };
  roleRoutes?: Record<Role, string[]> & { ui?: string[] };
  routes: Route[];
  decisions?: DecisionSettings;
  budgets: { decisions: number; implementation: number; "premium-api": number; emergency: number };
}
const credentialStatus = z.object({
  present: z.boolean(),
  source: z.enum(["pi", "encrypted", "missing"]),
  revision: z.string(),
});
export const settingsViewSchema = z.object({
  revision: z.string(),
  config: z.record(z.string(), z.unknown()),
  controllerRoot: z.string(),
  credentials: z.object({ normal: credentialStatus, decisions: credentialStatus }),
  usage: z.object({
    cycle: z.string(),
    committedMicroUsd: z.number(),
    unknownCalls: z.number(),
    calls: z.number(),
  }),
  apiUsage: z
    .object({ cycle: z.string(), committedMicroUsd: z.number(), reservations: z.number() })
    .optional(),
  circuits: z
    .array(z.object({ access: z.string(), reason: z.string(), untilMs: z.number().nullable() }))
    .default([]),
  dispatchPaused: z.boolean(),
  activeAttempts: z.number(),
});
export type SettingsView = Omit<z.infer<typeof settingsViewSchema>, "config"> & {
  config: ControllerConfig;
};
export const loadSettings = defineRpc({
  name: "orchestrator.settings.get",
  input: z.object({}),
  output: settingsViewSchema,
});
export const saveSettings = defineRpc({
  name: "orchestrator.settings.save",
  input: z.object({ revision: z.string(), config: z.record(z.string(), z.unknown()) }),
  output: settingsViewSchema,
});
export const saveCredential = defineRpc({
  name: "orchestrator.credentials.save",
  input: z.object({
    slot: z.enum(["normal", "decisions"]),
    revision: z.string(),
    key: z.string().min(20).max(1024),
  }),
  output: settingsViewSchema,
});
export const testDecisions = defineRpc({
  name: "orchestrator.decisions.test",
  input: z.object({ nonce: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) }),
  output: z.object({
    status: z.enum(["ok", "blocked", "failed"]),
    reason: z.string(),
    model: z.string(),
    reservedMicroUsd: z.number(),
  }),
});
export const pauseDispatch = defineRpc({
  name: "orchestrator.dispatch.pause",
  input: z.object({ paused: z.boolean() }),
  output: settingsViewSchema,
});
