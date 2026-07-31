import { describe, expect, it } from "vitest";
import { vi } from "vitest";
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__DEV__ = false;
});
import { shouldDrainLegacyQueuedAgentMessage } from "./session-context-queue-drain";

describe("shouldDrainLegacyQueuedAgentMessage", () => {
  it("does not legacy-drain when the daemon owns queued agent messages", () => {
    expect(
      shouldDrainLegacyQueuedAgentMessage({
        agentStatus: "closed",
        daemonOwnsQueue: true,
      }),
    ).toBe(false);
  });

  it("legacy-drains only for non-running agents when queue ownership stays local", () => {
    expect(
      shouldDrainLegacyQueuedAgentMessage({
        agentStatus: "closed",
        daemonOwnsQueue: false,
      }),
    ).toBe(true);
    expect(
      shouldDrainLegacyQueuedAgentMessage({
        agentStatus: "running",
        daemonOwnsQueue: false,
      }),
    ).toBe(false);
  });
});
