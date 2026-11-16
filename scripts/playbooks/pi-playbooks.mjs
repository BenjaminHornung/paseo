import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

// Resolve the installed Pi invocation each time so CLI/extension updates remain authoritative.
// This dedicated alias enables Pi's built-in MCP support; the user's normal launcher is unchanged.
const launcher = process.env.PASEO_PLAYBOOKS_PI_BASE_LAUNCHER;
if (!launcher || !path.isAbsolute(launcher)) throw new Error("PLAYBOOKS_PI_BASE_LAUNCHER_REQUIRED");
const directory = path.dirname(realpathSync(launcher)) + path.sep;
const invocations = readFileSync(launcher, "utf8")
  .split(/\r?\n/)
  .filter((line) => /^"[^"]*node\.exe"\s+"[^"]*cli\.js"/.test(line));
if (invocations.length !== 1 || /[&|<>^]/.test(invocations[0])) {
  throw new Error("PLAYBOOKS_PI_LAUNCHER_CHANGED");
}
const tokens = [...invocations[0].matchAll(/"([^"]*)"|(\S+)/g)].map((match) =>
  (match[1] ?? match[2]).replaceAll("%~dp0", directory),
);
if (
  tokens.pop() !== "%*" ||
  tokens.some((token) => token.includes("%")) ||
  !path.isAbsolute(tokens[0])
) {
  throw new Error("PLAYBOOKS_PI_INVOCATION_INVALID");
}
const command = [];
for (let index = 0; index < tokens.length; index += 1) {
  if (tokens[index] === "--no-mcp") continue;
  // Freeflow is shared normal-Pi infrastructure; this alias must not start or own it.
  if (
    tokens[index] === "--extension" &&
    /[\\/]pi-freeflow[\\/]extensions[\\/]index\.ts$/.test(tokens[index + 1] ?? "")
  ) {
    index += 1;
    continue;
  }
  command.push(tokens[index]);
}
if (!command.includes("--no-extensions"))
  throw new Error("PLAYBOOKS_PI_EXPLICIT_EXTENSIONS_REQUIRED");
// MCP's default deferred exposure needs its discovery executor as well as the MCP bridge.
// Keep all other built-ins disabled, including subagents.
command.push("--extension", "builtin:mcp", "--extension", "builtin:codemode");
const env = {
  ...process.env,
  PI_CODING_AGENT_DIR: path.join(directory, "profile"),
  PI_HASHLINE_DIR: path.join(directory, "profile", "hashline"),
};
// Old task-monitor capabilities must never leak into an unrelated Playbooks run.
for (const key of [
  "PASEO_ORCHESTRATOR_PROCESS_MONITOR",
  "PASEO_ORCHESTRATOR_BUDGET_FILE",
  "PASEO_ORCHESTRATOR_SUPERVISED",
  "PASEO_ORCHESTRATOR_CATALOG_ONLY",
  "PASEO_ORCHESTRATOR_POLICY_EVENTS",
]) {
  delete env[key];
}
const child = spawn(command[0], [...command.slice(1), ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
  windowsHide: true,
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
