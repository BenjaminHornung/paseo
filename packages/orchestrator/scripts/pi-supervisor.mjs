import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const codeRoot = path.resolve(
  process.env.PASEO_ORCHESTRATOR_ROOT ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const root = path.resolve(process.env.PASEO_ORCHESTRATOR_DATA_ROOT ?? codeRoot);
process.env.PI_CODING_AGENT_DIR = path.join(root, "state/pi-profile");
const binding = process.env.PASEO_ORCHESTRATOR_PROCESS_MONITOR;
// Reuse the installed literal invocation. The shared Freeflow daemon must not
// become owned work in an isolated controller job; ordinary Pi keeps it.
const baseLauncher = process.env.PASEO_ORCHESTRATOR_PI_BASE_LAUNCHER;
if (!baseLauncher || !path.isAbsolute(baseLauncher)) throw Error("PI_BASE_LAUNCHER_REQUIRED");
const piDirectory = path.dirname(realpathSync(baseLauncher)) + path.sep;
const lines = readFileSync(baseLauncher, "utf8")
  .split(/\r?\n/)
  .filter((line) => /^"[^"]*node\.exe"\s+"[^"]*cli\.js"/.test(line));
if (lines.length !== 1 || /[&|<>^]/.test(lines[0]))
  throw Error("Pi launcher invocation cannot be supervised safely");
const tokens = [...lines[0].matchAll(/"([^"]*)"|(\S+)/g)].map((match) =>
  (match[1] ?? match[2]).replaceAll("%~dp0", piDirectory),
);
if (
  tokens.pop() !== "%*" ||
  tokens.some((token) => token.includes("%")) ||
  !path.isAbsolute(tokens[0])
)
  throw Error("Pi launcher identity changed");
const isolated = [];
for (let index = 0; index < tokens.length; index++) {
  if (tokens[index] === "--skill" && tokens[index + 1]) {
    const relative = path.relative(path.join(piDirectory, "profile"), tokens[index + 1]);
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      index++; // Pi discovers skills from its owned profile instead of the legacy profile.
      continue;
    }
  }
  if (
    tokens[index] === "--extension" &&
    (/[\\/]pi-freeflow[\\/]extensions[\\/]index\.ts$/.test(tokens[index + 1] ?? "") ||
      /[\\/]luna-provider-guard\.mjs$/.test(tokens[index + 1] ?? ""))
  ) {
    index++;
    continue;
  }
  isolated.push(tokens[index]);
}
const guard = realpathSync(path.join(codeRoot, "dist/pi/extensions/luna-provider-guard.js"));
if (
  process.env.PASEO_ORCHESTRATOR_LUNA_GUARD &&
  realpathSync(process.env.PASEO_ORCHESTRATOR_LUNA_GUARD).toLowerCase() !== guard.toLowerCase()
)
  throw Error("PI_BUDGET_GUARD_EXTENSION_REQUIRED");
isolated.push("--extension", guard);

async function forwardCatalog(command) {
  const child = spawn(command[0], command.slice(1), {
    cwd: process.cwd(),
    env: { ...process.env, PASEO_ORCHESTRATOR_CATALOG_ONLY: "1" },
    windowsHide: true,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  child.stdout.pipe(process.stdout, { end: false });
  child.stdin.on("error", () => {});
  input.on("line", (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      request = {};
    }
    if (
      ["get_available_models", "get_state"].includes(request.type) &&
      Object.keys(request).every((key) => ["id", "type"].includes(key))
    ) {
      child.stdin.write(JSON.stringify(request) + "\n");
    } else {
      process.stdout.write(
        JSON.stringify({
          type: "response",
          id: request.id,
          command: request.type,
          success: false,
          error: "PI_CATALOG_ONLY_NO_PROMPTS",
        }) + "\n",
      );
    }
  });
  input.on("close", () => child.stdin.end());
  return await new Promise((resolve, reject) => {
    child.on("error", () => {
      input.close();
      reject(Error("PI_CATALOG_RUNTIME_UNAVAILABLE"));
    });
    child.on("close", (code) => {
      input.close();
      process.stdin.pause();
      resolve(code ?? 1);
    });
  });
}

if (!binding) {
  const args = process.argv.slice(2);
  if (
    process.env.PASEO_ORCHESTRATOR_BUDGET_FILE ||
    args.length !== 2 ||
    args[0] !== "--mode" ||
    args[1] !== "rpc"
  )
    throw Error("PI_MONITORED_SESSION_REQUIRED");
  process.exitCode = await forwardCatalog([...isolated, ...args]);
} else {
  const directory = realpathSync(path.join(root, "state/process-monitors"));
  if (
    path.dirname(path.resolve(binding)).toLowerCase() !== directory.toLowerCase() ||
    !/^[a-f0-9]{64}\.json$/.test(path.basename(binding))
  )
    throw Error("Process monitor identity invalid");
  const generation = randomUUID(),
    monitorFile = path.join(directory, `${path.basename(binding, ".json")}-${generation}.json`);
  const temporary = `${binding}.${process.pid}.pending`;
  writeFileSync(
    temporary,
    JSON.stringify({ version: 1, generation, monitorFile, startedAt: Date.now() }),
    { flag: "wx", mode: 0o600 },
  );
  renameSync(temporary, binding);
  const conversion = isolated.find((value) =>
    /[\\/]@howaboua[\\/]pi-codex-conversion[\\/]dist[\\/]index\.js$/.test(value),
  );
  const execBridgeExecutable = conversion
    ? realpathSync(
        path.join(
          path.dirname(conversion),
          "../src/tools/exec/bin",
          `${process.platform}-${process.arch}`,
          "exec_bridge.exe",
        ),
      )
    : undefined;
  const request = {
    command: [
      ...isolated,
      "--extension",
      path.join(codeRoot, "dist/pi/extensions/orchestrator-tools.js"),
      ...process.argv.slice(2),
    ],
    cwd: process.cwd(),
    nodeExecutable: realpathSync(tokens[0]),
    monitorFile,
    execBridgeExecutable,
  };
  const env = { ...process.env };
  delete env.PASEO_ORCHESTRATOR_PROCESS_MONITOR;
  env.PASEO_ORCHESTRATOR_SUPERVISED = "1";
  env.PASEO_ORCHESTRATOR_POLICY_EVENTS = `${binding}.policy.jsonl`;
  env.MSBUILDDISABLENODEREUSE = "1";
  env.DOTNET_CLI_USE_MSBUILD_SERVER = "0";
  env.UseSharedCompilation = "false";
  const scratch = path.join(root, "state/check-tmp");
  mkdirSync(scratch, { recursive: true });
  env.TMP = scratch;
  env.TEMP = scratch;
  const powershell = process.env.PASEO_ORCHESTRATOR_POWERSHELL;
  if (!powershell || !path.isAbsolute(powershell)) throw Error("PI_POWERSHELL_RUNTIME_REQUIRED");
  const result = spawnSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(codeRoot, "scripts/pi-supervise.ps1"),
      "-Request",
      Buffer.from(JSON.stringify(request)).toString("base64"),
    ],
    { cwd: process.cwd(), env, stdio: "inherit", windowsHide: true },
  );
  process.exitCode = result.status ?? 1;
}
