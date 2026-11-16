import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { ComposerAttachment } from "@/attachments/types";

export function harnessContextAgentId(
  attachments: readonly (ComposerAttachment | AgentAttachment)[],
): string | null {
  let selected: string | null = null;
  for (const attachment of attachments) {
    let candidate: string | undefined;
    if ("kind" in attachment && attachment.kind === "harness_context") {
      candidate = attachment.agentId;
    } else if ("type" in attachment && attachment.type === "text") {
      candidate = attachment.harnessContext?.agentId;
    }
    if (!candidate) continue;
    if (selected && selected !== candidate)
      throw new Error("Selected context belongs to different agent drafts");
    selected = candidate;
  }
  return selected;
}

export function bindHarnessContextAgentId(
  attachments: readonly AgentAttachment[],
  agentId: string,
): AgentAttachment[] {
  return attachments.map((attachment) => {
    if (attachment.type !== "text" || !attachment.harnessContext) return attachment;
    return {
      ...attachment,
      harnessContext: { ...attachment.harnessContext, agentId },
    };
  });
}
