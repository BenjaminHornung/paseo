import path from "node:path";
import type { HarnessContextEntry } from "@getpaseo/protocol/messages";
import type { PiRuntimeSession } from "./runtime.js";

export function isPiMcpStatusMessage(message: unknown): message is string {
  if (typeof message !== "string") return false;
  if (
    /^No MCP servers configured\. Add them to [^\r\n]+[\\/]mcp\.json or \.pi\/mcp\.json\.$/.test(
      message,
    )
  )
    return true;
  let hasServer = false;
  for (const line of message.split(/\r?\n/)) {
    if (hasServer && line.startsWith("    ")) continue;
    if (line.startsWith("config error: ") || line.startsWith("overridden: ")) continue;
    const header = /^([^:\r\n]+): (.+) \((codemode|deferred|direct|hidden)\)$/.exec(line);
    if (!header) return false;
    const [, name, state] = header;
    const valid =
      /^(connected, \d+ tools|disabled(?:, \d+ tools)?|connecting|failed|closed|starting)$/.test(
        state,
      ) ||
      state === "disconnected, reconnects on next call" ||
      state === `needs sign-in, run /mcp login ${name}`;
    if (!valid) return false;
    hasServer = true;
  }
  return hasServer;
}

export function connectedPiMcpServers(message: string): HarnessContextEntry[] {
  const entries: HarnessContextEntry[] = [];
  for (const line of message.split("\n")) {
    const match = /^([^:\r\n]+): connected, (\d+) tools \(([^)]+)\)$/.exec(line);
    if (!match || Number(match[2]) === 0 || match[3] === "hidden") continue;
    const name = match[1];
    entries.push({
      id: `mcp:${name}`,
      kind: "mcp",
      name,
      description: "",
      invocation: `MCP server ${name}`,
    });
  }
  return entries;
}

export async function listPiContext(
  runtime: PiRuntimeSession,
  allowMcp: boolean,
): Promise<HarnessContextEntry[]> {
  const commands = await runtime.getCommands();
  const plugins = new Map<string, HarnessContextEntry>();
  for (const command of commands) {
    const origin = command.sourceInfo?.path;
    if (
      command.source !== "extension" ||
      typeof origin !== "string" ||
      origin.startsWith("builtin:")
    )
      continue;
    if (plugins.has(origin)) continue;
    const name = path.basename(origin).replace(/\.[cm]?[jt]s$/, "");
    plugins.set(origin, {
      id: `plugin:${origin}`,
      kind: "plugin",
      name,
      description: command.description ?? "",
      invocation: `/${command.name}`,
    });
  }
  const entries = [...plugins.values()];
  const builtinMcp = commands.some(
    (command) => command.name === "mcp" && command.sourceInfo?.path === "builtin:mcp",
  );
  if (!allowMcp || !builtinMcp) return entries;
  let stop: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const status = new Promise<string>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("MCP status timed out")), 10_000);
    stop = runtime.onEvent((event) => {
      if (
        event.type !== "extension_ui_request" ||
        event.method !== "notify" ||
        event.notifyType !== "info" ||
        !isPiMcpStatusMessage(event.message)
      )
        return;
      resolve(event.message);
    });
  });
  // Attach the rejection handler before awaiting the command acknowledgement.
  const observedStatus = status.then(
    (message) => ({ message }),
    (error: unknown) => ({ error }),
  );
  try {
    const ack = await runtime.prompt("/mcp");
    if (ack.agentInvoked === true)
      throw new Error("MCP status command unexpectedly invoked the model");
    const observed = await observedStatus;
    if ("error" in observed) throw observed.error;
    return [...entries, ...connectedPiMcpServers(observed.message)];
  } finally {
    if (timer) clearTimeout(timer);
    stop?.();
  }
}
