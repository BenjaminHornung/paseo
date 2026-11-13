import { z } from "zod";
import { contractSchema, digest, type Contract } from "./contracts.ts";

// Operator input is deliberately separate from human intake and agent tools.
export const terminalRepairRequestSchema = z.strictObject({
  predecessorAttemptId: z.string().min(1),
  predecessorFence: z.number().int().positive(),
  agentId: z.string().min(1),
  nativeSessionId: z.string().min(1),
  contractHash: digest,
  configHash: digest,
  diffHash: digest,
  checkEvidenceSha256: digest,
  scopeRevision: digest,
  checkRevision: digest,
  additionalAllowedPath: contractSchema.shape.allowedPaths.element.optional(),
  checks: contractSchema.shape.checks.optional(),
});
export type TerminalRepairRequest = z.infer<typeof terminalRepairRequestSchema>;
export interface TerminalRepairGrant extends Omit<TerminalRepairRequest, "checks"> {
  checks: Contract["checks"];
  taskKey: string;
  predecessorHash: string;
  approvedCheckRevision: string;
  approvedScopeRevision: string;
  reason: string;
}
