import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { PaseoAgent } from "@getpaseo/client";

export const preparationInput = z.object({
  requestId: z
    .string()
    .min(16)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/),
  projectId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  model: z.string().min(1),
  reasoning: z.string(),
  modeId: z.string().optional(),
  autoRouting: z.boolean(),
  dataScope: z.enum(["public", "personal", "company", "restricted"]).default("company"),
});
export type PreparationInput = z.infer<typeof preparationInput>;
export function existingMainSelection(agent: PaseoAgent) {
  return {
    model: agent.runtimeInfo?.model ?? agent.model ?? "",
    reasoning:
      agent.runtimeInfo?.thinkingOptionId ??
      agent.effectiveThinkingOptionId ??
      agent.thinkingOptionId ??
      "",
    modeId: agent.runtimeInfo?.modeId ?? agent.currentModeId ?? undefined,
  };
}
export const prepareSession = defineRpc({
  name: "orchestrator.prepare-session",
  input: preparationInput,
  output: z.object({
    agentId: z.string(),
    workspaceId: z.string(),
    automation: z.enum(["off", "arming", "ready", "uncertain"]),
  }),
});
