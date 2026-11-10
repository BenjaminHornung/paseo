import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveDesktopDistribution } from "../distribution.js";

// This module runs outside app.asar; keep its dependencies limited to Node built-ins.
function findInstalledExecutable(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory.replace(/^"|"$/g, ""), `${name}.exe`);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

function registerBundledPlugin(
  paseoHome: string,
  codeRoot: string,
  env: NodeJS.ProcessEnv,
): string {
  const daemonConfigPath = path.join(paseoHome, "config.json");
  const daemonConfig = existsSync(daemonConfigPath)
    ? JSON.parse(readFileSync(daemonConfigPath, "utf8"))
    : { version: 1 };
  const missingListen = daemonConfig.daemon?.listen === undefined;
  const missingPluginSetting = daemonConfig.pluginsEnabled === undefined;
  if (missingPluginSetting) daemonConfig.pluginsEnabled = true;
  if (missingListen) {
    daemonConfig.daemon = {
      ...daemonConfig.daemon,
      listen: env.PASEO_LISTEN ?? `127.0.0.1:${env.PORT ?? "6777"}`,
    };
  }
  const pluginPath = path.join(codeRoot, "paseo-plugin");
  if (
    missingListen ||
    missingPluginSetting ||
    daemonConfig.plugins?.["paseo-orchestrator"]?.path !== pluginPath
  ) {
    daemonConfig.plugins = {
      ...daemonConfig.plugins,
      "paseo-orchestrator": {
        ...daemonConfig.plugins?.["paseo-orchestrator"],
        source: "directory",
        path: pluginPath,
      },
    };
    const pending = `${daemonConfigPath}.advanced-${process.pid}`;
    writeFileSync(pending, JSON.stringify(daemonConfig, null, 2), { flag: "wx", mode: 0o600 });
    renameSync(pending, daemonConfigPath);
  }
  return env.PASEO_LISTEN ?? daemonConfig.daemon?.listen ?? `127.0.0.1:${env.PORT ?? "6777"}`;
}

/** Bind the packaged plugin, RPC and watch process to Advanced-owned code and data. */
export function configureAdvancedOrchestrator(input: {
  executablePath: string;
  env: NodeJS.ProcessEnv;
}): void {
  if (resolveDesktopDistribution(input.executablePath).id !== "advanced") return;
  const { env } = input;
  if (!env.PASEO_HOME) throw new Error("ADVANCED_HOME_REQUIRED");
  const codeRoot = path.join(path.dirname(input.executablePath), "resources", "orchestrator");
  if (!existsSync(path.join(codeRoot, "dist", "build-info.json"))) {
    throw new Error("ADVANCED_CONTROLLER_BUNDLE_MISSING");
  }
  const dataRoot = path.join(env.PASEO_HOME, "orchestrator");
  const configDirectory = path.join(dataRoot, "config");
  const stateDirectory = path.join(dataRoot, "state");
  mkdirSync(configDirectory, { recursive: true });
  mkdirSync(stateDirectory, { recursive: true });
  // These variables belong to this distribution, including when launched from an older Paseo.
  env.PASEO_ORCHESTRATOR_ROOT = codeRoot;
  env.PASEO_ORCHESTRATOR_DATA_ROOT = dataRoot;
  env.PASEO_ORCHESTRATOR_NODE = input.executablePath;
  env.PASEO_ORCHESTRATOR_LUNA_GUARD = path.join(
    codeRoot,
    "dist/pi/extensions/luna-provider-guard.js",
  );
  for (const key of [
    "PASEO_ORCHESTRATOR_BUDGET_FILE",
    "PASEO_ORCHESTRATOR_PROCESS_MONITOR",
    "PASEO_ORCHESTRATOR_WORKTREE",
    "PASEO_ORCHESTRATOR_ALLOWED_PATHS",
    "PASEO_ORCHESTRATOR_SUPERVISED",
    "PASEO_ORCHESTRATOR_POLICY_EVENTS",
  ])
    delete env[key];
  env.ORCHESTRATOR_CONFIG = path.join(configDirectory, "local.controller.json");
  env.ORCHESTRATOR_STATE = path.join(stateDirectory, "controller.sqlite");
  env.PASEO_ORCHESTRATOR_POWERSHELL ??= findInstalledExecutable("pwsh", env);
  if (!env.PASEO_ORCHESTRATOR_POWERSHELL) {
    throw new Error("ADVANCED_POWERSHELL_RUNTIME_REQUIRED");
  }
  const listen = registerBundledPlugin(env.PASEO_HOME, codeRoot, env);
  if (existsSync(env.ORCHESTRATOR_CONFIG)) return;
  const gitExecutable = findInstalledExecutable("git", env);
  if (!gitExecutable) throw new Error("ADVANCED_GIT_RUNTIME_REQUIRED");
  const config = JSON.parse(
    readFileSync(path.join(codeRoot, "config", "controller.local.example.json"), "utf8"),
  );
  const endpoint = String(listen).replace(/^0\.0\.0\.0:/, "127.0.0.1:");
  if (!/^127\.0\.0\.1:\d+$/.test(endpoint)) {
    throw new Error("ADVANCED_CONTROLLER_REQUIRES_LOOPBACK_TCP");
  }
  config.daemonUrl = `ws://${endpoint}/ws`;
  config.gitExecutable = gitExecutable;
  config.apiEnabled = false;
  config.liveDispatchApproved = false;
  // No original config, keys, funding, automation IDs or state are copied into this home.
  writeFileSync(env.ORCHESTRATOR_CONFIG, JSON.stringify(config, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
}
