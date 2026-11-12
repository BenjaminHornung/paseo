import { describe, expect, it } from "vitest";
import type { AgentAttachment, HarnessContextEntry } from "@getpaseo/protocol/messages";
import {
  discoverHarnessContext,
  HarnessContextUnavailable,
  listHarnessContext,
  validateHarnessContext,
} from "./context.js";

const skill: HarnessContextEntry = {
  id: "skill:review",
  kind: "skill",
  name: "review",
  description: "Review changes",
  invocation: "/review",
};
const attachment: AgentAttachment = {
  type: "text",
  mimeType: "text/plain",
  text: "Use review",
  harnessContext: { agentId: "claude-chat", provider: "claude", entry: skill },
};
const session = {
  provider: "claude",
  listCommands: async () => [
    { name: "review", kind: "skill" as const, description: "Review changes", argumentHint: "" },
  ],
};

describe("harness context submission", () => {
  it("allows a current skill but refuses it in another chat or after removal", async () => {
    await expect(
      validateHarnessContext("claude-chat", session, [attachment]),
    ).resolves.toBeUndefined();
    await expect(validateHarnessContext("pi-chat", session, [attachment])).rejects.toThrow(
      "no longer available",
    );
    await expect(
      validateHarnessContext("claude-chat", { provider: "claude", listCommands: async () => [] }, [
        attachment,
      ]),
    ).rejects.toThrow("no longer available");
    await expect(
      validateHarnessContext("claude-chat", { ...session, provider: "pi" }, [attachment]),
    ).rejects.toThrow("no longer available");
  });

  it("does not turn regular commands into selectable skills and exposes discovery failure", async () => {
    expect(
      await listHarnessContext({
        listCommands: async () => [
          { name: "clear", kind: "command", description: "Clear", argumentHint: "" },
        ],
      }),
    ).toEqual([]);
    await expect(
      listHarnessContext({
        listContext: async () => {
          throw new Error("Discovery unavailable");
        },
      }),
    ).rejects.toThrow("Discovery unavailable");
    const catalog = await discoverHarnessContext({
      ...session,
      listContext: async (kinds) => {
        if (kinds?.includes("mcp")) throw new Error("MCP unavailable while busy");
        return [];
      },
    });
    expect(catalog.entries).toEqual([skill]);
    expect(catalog.error).not.toBeNull();
    const unknown = await discoverHarnessContext({
      ...session,
      listContext: async () => {
        throw new HarnessContextUnavailable("Inventory pending");
      },
    });
    expect(unknown).toEqual({ entries: [skill], error: null });
  });
});
