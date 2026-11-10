import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const preparationInput = z.object({
  requestId: z
    .string()
    .min(16)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/),
  projectId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  model: z.string().min(1),
  reasoning: z.string(),
  modeId: z.string().optional(),
  autoRouting: z.boolean(),
  dataScope: z.enum(["public", "personal", "company", "restricted"]).default("company"),
});
export type PreparationInput = z.infer<typeof preparationInput>;
export const prepareSession = defineRpc({
  name: "orchestrator.prepare-session",
  input: preparationInput,
  output: z.object({
    agentId: z.string(),
    workspaceId: z.string(),
    automation: z.enum(["off", "arming", "ready", "uncertain"]),
  }),
});
