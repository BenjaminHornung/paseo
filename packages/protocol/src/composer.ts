import { z } from "zod";

export const ComposerPredictionsConfigSchema = z.object({
  enabled: z.boolean(),
  profileId: z.string().min(1).nullable(),
});

export const HarnessContextEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(["skill", "mcp", "plugin", "connector"]),
  name: z.string(),
  description: z.string(),
  invocation: z.string(),
});
export type HarnessContextEntry = z.infer<typeof HarnessContextEntrySchema>;

export const ComposerPredictionRequestSchema = z.object({
  type: z.literal("composer.prediction.request"),
  requestId: z.string(),
  agentId: z.string(),
  sourceTurnId: z.string(),
});

export const ComposerPredictionResponseSchema = z.object({
  type: z.literal("composer.prediction.response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    sourceTurnId: z.string(),
    suggestion: z.string().nullable(),
    error: z.enum(["unavailable", "failed", "timeout"]).nullable(),
  }),
});

export const HarnessContextRequestSchema = z.object({
  type: z.literal("agent.context.list.request"),
  requestId: z.string(),
  agentId: z.string(),
  draftConfig: z
    .object({
      provider: z.string(),
      cwd: z.string(),
      model: z.string().optional(),
      modeId: z.string().optional(),
      thinkingOptionId: z.string().optional(),
      providerOptions: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export const HarnessContextResponseSchema = z.object({
  type: z.literal("agent.context.list.response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    entries: z.array(HarnessContextEntrySchema),
    error: z.string().nullable(),
  }),
});
