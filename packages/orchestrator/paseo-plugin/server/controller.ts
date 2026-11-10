import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";

export const controllerRoot = process.env.PASEO_ORCHESTRATOR_ROOT ?? "";
export const controllerNodeExecutable = process.env.PASEO_ORCHESTRATOR_NODE ?? process.execPath;
if (!path.isAbsolute(controllerRoot) || !path.isAbsolute(controllerNodeExecutable))
  throw Error("CONTROLLER_ABSOLUTE_RUNTIME_PATH_REQUIRED");
export function controllerEntrypoint(name: "settings-rpc" | "cli"): string {
  const compiled = path.join(controllerRoot, "dist/src", `${name}.js`);
  return existsSync(compiled) ? compiled : path.join(controllerRoot, "src", `${name}.ts`);
}
export async function controller(operation: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(controllerNodeExecutable, [controllerEntrypoint("settings-rpc")], {
      cwd: controllerRoot,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "",
      finished = false;
    // Tool-free research can use healthy Luna Flex. A quiet model request is
    // not a transport failure and must not be cancelled by this RPC wrapper.
    const modelResearch =
      operation.operation === "auto-research" &&
      (operation.request as { synthesize?: boolean } | undefined)?.synthesize === true;
    const timer = modelResearch
      ? undefined
      : setTimeout(() => {
          if (!finished) {
            child.kill();
            reject(Error("CONTROLLER_REQUEST_TIMEOUT"));
          }
        }, 45000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > 262144) child.kill();
    });
    // Raw child errors can contain sensitive data. Never forward or log them.
    child.stderr.resume();
    child.on("error", () => {
      finished = true;
      clearTimeout(timer);
      reject(Error("CONTROLLER_UNAVAILABLE"));
    });
    child.on("close", () => {
      finished = true;
      clearTimeout(timer);
      try {
        const value = JSON.parse(output) as { ok: boolean; result?: unknown; error?: string };
        if (!value.ok) {
          reject(
            Error(
              value.error && /^[A-Z0-9_]{1,70}$/.test(value.error)
                ? value.error
                : "CONTROLLER_REQUEST_FAILED",
            ),
          );
          return;
        }
        resolve(value.result);
      } catch {
        reject(Error("CONTROLLER_RESPONSE_INVALID"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(operation));
  });
}
