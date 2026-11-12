import { z } from "zod";

export const intakeConfirmationSchema = z.strictObject({
  assessmentId: z.string().regex(/^[a-f0-9]{64}$/),
  messageId: z.string().min(1),
  assessmentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type IntakeConfirmation = z.infer<typeof intakeConfirmationSchema>;
