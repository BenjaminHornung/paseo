import { createHash } from "node:crypto";

import type { AgentPromptInput } from "./agent-sdk-types.js";

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`);
  return `{${entries.join(",")}}`;
}

/** Hash the normalized prompt that will be dispatched to the provider. */
export function fingerprintAgentPrompt(prompt: AgentPromptInput): string {
  const serialized = stableSerialize({
    kind: typeof prompt === "string" ? "text" : "structured",
    prompt,
  });
  return createHash("sha256").update(serialized).digest("hex");
}
