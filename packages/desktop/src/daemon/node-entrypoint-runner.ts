import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  configureDesktopDistributionEnvironment,
  resolveDesktopDistribution,
} from "../distribution.js";
import { configureAdvancedOrchestrator } from "./advanced-orchestrator.js";

export async function main(): Promise<void> {
  const [argvMode, entryPath, ...args] = process.argv.slice(2);
  if (argvMode !== "bare" && argvMode !== "node-script") {
    throw new Error(`Unsupported node entrypoint argv mode: ${argvMode ?? "<missing>"}`);
  }
  if (!entryPath) {
    throw new Error("Missing node entrypoint path.");
  }
  if (
    resolveDesktopDistribution(process.execPath).id === "advanced" &&
    entryPath.replaceAll("\\", "/").includes("/@getpaseo/cli/")
  ) {
    const end = args.indexOf("--");
    const options = end < 0 ? args : args.slice(0, end);
    const homeIndex = options.indexOf("--home");
    const home =
      homeIndex >= 0
        ? options[homeIndex + 1]
        : options.find((value) => value.startsWith("--home="))?.slice("--home=".length);
    if (home) process.env.PASEO_HOME = path.resolve(home);
  }
  configureDesktopDistributionEnvironment({ executablePath: process.execPath, env: process.env });
  configureAdvancedOrchestrator({ executablePath: process.execPath, env: process.env });

  process.argv =
    argvMode === "bare"
      ? [process.argv[0] ?? "node", ...args]
      : [process.argv[0] ?? "node", entryPath, ...args];
  await import(pathToFileURL(entryPath).href);
}

if (require.main === module) {
  void main().catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
