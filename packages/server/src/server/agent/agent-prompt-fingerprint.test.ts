import { describe, expect, test } from "vitest";

import { fingerprintAgentPrompt } from "./agent-prompt-fingerprint.js";
import { buildAgentPrompt } from "./prompt-attachments.js";

describe("fingerprintAgentPrompt", () => {
  test("uses the normalized prompt including images and attachments", () => {
    const first = buildAgentPrompt(
      "  ship it  ",
      [{ data: "image-a", mimeType: "image/png" }],
      [{ type: "text", text: "context", contextKind: "chat_history" }],
    );
    const equivalent = buildAgentPrompt(
      "ship it",
      [{ mimeType: "image/png", data: "image-a" }],
      [{ contextKind: "chat_history", text: "context", type: "text" }],
    );
    const differentImage = buildAgentPrompt(
      "ship it",
      [{ data: "image-b", mimeType: "image/png" }],
      [{ type: "text", text: "context", contextKind: "chat_history" }],
    );
    const differentAttachment = buildAgentPrompt(
      "ship it",
      [{ data: "image-a", mimeType: "image/png" }],
      [{ type: "text", text: "other context", contextKind: "chat_history" }],
    );

    expect(fingerprintAgentPrompt(first)).toBe(fingerprintAgentPrompt(equivalent));
    expect(fingerprintAgentPrompt(differentImage)).not.toBe(fingerprintAgentPrompt(first));
    expect(fingerprintAgentPrompt(differentAttachment)).not.toBe(fingerprintAgentPrompt(first));
  });
});
