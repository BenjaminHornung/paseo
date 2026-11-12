import { z } from "zod";
import { workKindSchema } from "./work-categories.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const mainTaskTargetSchema = z.strictObject({
  taskKey: z.string().min(1),
  contractHash: digest,
  packageAssessmentId: digest,
  diffHash: digest.optional(),
});
export const mainInputInterpretationSchema = z
  .strictObject({
    version: z.literal(1),
    intakeId: digest,
    factsHash: digest,
    previousWorkIntakeId: digest.nullable(),
    action: z.enum([
      "plan",
      "review",
      "start",
      "question",
      "status",
      "continue",
      "stop",
      "change",
      "approve",
    ]),
    needExplorer: z.boolean().optional(),
    target: mainTaskTargetSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.action === "approve" && !value.target)
      context.addIssue({
        code: "custom",
        message: "Task approval requires an exact existing target",
      });
    if (value.target && !["approve", "change"].includes(value.action))
      context.addIssue({ code: "custom", message: "Only approval or change selects a task" });
    if (value.action === "change" && value.target && !value.target.diffHash)
      context.addIssue({
        code: "custom",
        message: "Changing a registered task requires its current diff",
      });
  });
export type MainInputInterpretation = z.infer<typeof mainInputInterpretationSchema>;
export const mainPackageDeclarationSchema = z.strictObject({
  complexity: z.enum(["simple", "normal", "complex", "unknown"]),
  workKind: workKindSchema.optional(),
  additionalPlanning: z.boolean(),
  advisorNeeded: z.boolean(),
});
export const mainPackageInterpretationSchema = z.strictObject({
  version: z.literal(1),
  packageAssessmentId: digest,
  factsHash: digest,
  declaration: mainPackageDeclarationSchema,
});
export type MainPackageInterpretation = z.infer<typeof mainPackageInterpretationSchema>;
