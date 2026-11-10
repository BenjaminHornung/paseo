import { z } from "zod";

export const reviewFindingsSchema = z
  .array(
    z.strictObject({
      severity: z.enum(["P1", "P2", "P3"]),
      file: z.string().min(1).max(300),
      line: z.number().int().positive(),
      problem: z.string().min(1).max(2000),
      requiredChange: z.string().min(1).max(2000),
    }),
  )
  .max(30);

export const continuationRepairSchema = z.strictObject({
  diffHash: z.string().regex(/^[a-f0-9]{64}$/),
  findings: reviewFindingsSchema.min(1),
});
