import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const decisionsHistorySchema = z.object({
  mainAgentId: z.string(),
  items: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      at: z.number(),
      source: z.string(),
      reason: z.string(),
    }),
  ),
  nextBefore: z.number().optional(),
  detail: z
    .object({
      id: z.string(),
      input: z.string(),
      result: z.string().nullable(),
      response: z.string().nullable(),
      diagnostics: z.string().nullable(),
      request: z.string().nullable(),
      confidence: z.number().optional(),
      source: z.string(),
      reason: z.string(),
      callState: z.string(),
      reservedMicroUsd: z.number(),
      chargedMicroUsd: z.number().nullable(),
      inputHash: z.string(),
      provenance: z.string(),
    })
    .optional(),
});
export const decisionsHistory = defineRpc({
  name: "orchestrator.decisions-history",
  input: z.object({
    directory: z.string(),
    agentId: z.string().optional(),
    assessmentId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    before: z.number().int().positive().optional(),
  }),
  output: decisionsHistorySchema,
});
