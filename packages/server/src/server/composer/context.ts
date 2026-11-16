import type { HarnessContextEntry } from "@getpaseo/protocol/messages";
import type { AgentSession, AgentPromptContentBlock } from "../agent/agent-sdk-types.js";

type ContextSession = Pick<AgentSession, "listCommands" | "listContext">;

/** The current native runtime cannot yet verify this category. */
export class HarnessContextUnavailable extends Error {}

export async function listHarnessContext(
  session: ContextSession,
  kinds: readonly HarnessContextEntry["kind"][] = ["skill", "mcp", "plugin", "connector"],
): Promise<HarnessContextEntry[]> {
  const commands = kinds.includes("skill") ? ((await session.listCommands?.()) ?? []) : [];
  const skills: HarnessContextEntry[] = commands
    .filter((command) => command.kind === "skill")
    .map((command) => ({
      id: `skill:${command.name}`,
      kind: "skill",
      name: command.name,
      description: command.description,
      invocation: `/${command.name}`,
    }));
  const resources = kinds.some((kind) => kind !== "skill")
    ? ((await session.listContext?.(kinds)) ?? [])
    : [];
  return [...skills, ...resources];
}

/** Discovery keeps healthy categories visible; submission remains strict. */
export async function discoverHarnessContext(session: ContextSession): Promise<{
  entries: HarnessContextEntry[];
  error: string | null;
}> {
  const kinds: HarnessContextEntry["kind"][] = ["skill", "mcp", "plugin", "connector"];
  const entries: HarnessContextEntry[] = [];
  let failed = false;
  for (const kind of kinds) {
    try {
      entries.push(...(await listHarnessContext(session, [kind])));
    } catch (error) {
      if (!(error instanceof HarnessContextUnavailable)) failed = true;
    }
  }
  return { entries, error: failed ? "Some skills or connections could not be loaded" : null };
}

export async function validateHarnessContext(
  agentId: string,
  session: ContextSession & Pick<AgentSession, "provider">,
  attachments: readonly AgentPromptContentBlock[] = [],
): Promise<void> {
  const selected = attachments.flatMap((attachment) => {
    if (
      attachment.type !== "text" ||
      !("harnessContext" in attachment) ||
      !attachment.harnessContext
    )
      return [];
    return [attachment.harnessContext];
  });
  if (selected.length === 0) return;
  const available = await listHarnessContext(
    session,
    selected.map((selection) => selection.entry.kind),
  );
  for (const selection of selected) {
    const entry = available.find((candidate) => candidate.id === selection.entry.id);
    if (
      selection.agentId !== agentId ||
      selection.provider !== session.provider ||
      !entry ||
      entry.invocation !== selection.entry.invocation
    ) {
      throw new Error("Selected skill or connection is no longer available for this agent");
    }
  }
}
