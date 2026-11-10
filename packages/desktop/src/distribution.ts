import { homedir } from "node:os";
import path from "node:path";

export interface DesktopDistribution {
  id: "upstream" | "advanced";
  productName: string;
  cliName: string;
}

const upstream: DesktopDistribution = {
  id: "upstream",
  productName: "Paseo",
  cliName: "paseo",
};

const advanced: DesktopDistribution = {
  id: "advanced",
  productName: "Paseo Advanced",
  cliName: "paseo-advanced",
};

export function resolveDesktopDistribution(executablePath: string): DesktopDistribution {
  return path.basename(executablePath).toLowerCase() === "paseoadvanced.exe" ? advanced : upstream;
}

/** GUI and the bundled CLI must choose the same home without claiming the upstream daemon. */
export function configureDesktopDistributionEnvironment(input: {
  executablePath: string;
  env: NodeJS.ProcessEnv;
  userHome?: string;
}): void {
  if (resolveDesktopDistribution(input.executablePath).id !== "advanced") return;
  input.env.PASEO_HOME ??= path.join(input.userHome ?? homedir(), ".paseo-advanced");
  // PORT is the existing lowest-priority default; explicit listen/config values still win.
  input.env.PORT ??= "6777";
  input.env.PASEO_DESKTOP_EXECUTABLE ??= input.executablePath;
}

export function normalizeDesktopAgentLink(
  input: string,
  distribution: DesktopDistribution,
): string {
  if (distribution.id !== "advanced") return input;
  return input.replace(/^paseo-advanced:/i, "paseo:");
}
