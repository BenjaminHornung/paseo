import type { Agent } from "@/stores/session-store";

export function shouldDrainLegacyQueuedAgentMessage(input: {
  agentStatus: Agent["status"] | null | undefined;
  daemonOwnsQueue: boolean;
}): boolean {
  return (
    input.agentStatus !== undefined && input.agentStatus !== "running" && !input.daemonOwnsQueue
  );
}
