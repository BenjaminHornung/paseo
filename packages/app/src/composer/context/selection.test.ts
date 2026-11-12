import { expect, it } from "vitest";
import type { UserComposerAttachment } from "@/attachments/types";
import { splitComposerAttachmentsForSubmit } from "../attachments/submit";
import { harnessContextAgentId } from "./selection";

it("keeps the reserved agent identity across draft storage and wire conversion and refuses mixed identities", () => {
  const agentId = "f802293e-dc54-47af-84ca-b8516f2e29ee";
  const attachment: UserComposerAttachment = {
    kind: "harness_context",
    agentId,
    provider: "claude",
    entry: {
      id: "skill:review",
      kind: "skill",
      name: "review",
      description: "Review",
      invocation: "/review",
    },
  };
  const outgoing = splitComposerAttachmentsForSubmit([attachment]);
  expect(harnessContextAgentId([attachment])).toBe(agentId);
  expect(harnessContextAgentId(outgoing.attachments)).toBe(agentId);
  expect(() =>
    harnessContextAgentId([attachment, { ...attachment, agentId: "a-different-agent" }]),
  ).toThrow("different agent drafts");
});
