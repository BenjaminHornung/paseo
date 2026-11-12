import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import lockfile from "proper-lockfile";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { configSchema, hash, localPath, type Config } from "./contracts.ts";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const codeRoot = path.resolve(
  process.env.PASEO_ORCHESTRATOR_ROOT ??
    (path.basename(source) === "dist" ? path.resolve(source, "..") : source),
);
export const appRoot = path.resolve(process.env.PASEO_ORCHESTRATOR_DATA_ROOT ?? codeRoot);
export const configPath =
  process.env.ORCHESTRATOR_CONFIG ?? path.join(appRoot, "config/local.controller.json");
export const statePath =
  process.env.ORCHESTRATOR_STATE ?? path.join(appRoot, "state/controller.sqlite");
export const powershellExecutable =
  process.env.PASEO_ORCHESTRATOR_POWERSHELL ??
  path.join(process.env.ProgramFiles ?? "C:/Program Files", "PowerShell/7/pwsh.exe");
export function readConfig(file = configPath): Config {
  return configSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}
export function atomicWrite(file: string, contents: string): void {
  localPath(path.dirname(file));
  const temporary = `${file}.pending-${process.pid}`;
  writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
  // Windows readers/scanners may briefly hold the destination without delete
  // sharing. Preserve atomic replacement and the settings lock; never unlink
  // the live file or replay the caller's mutation.
  for (let retry = 0; ; retry++) {
    try {
      renameSync(temporary, file);
      break;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        retry >= 10 ||
        !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")
      )
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}
export function withSettingsLock<T>(root: string, action: () => T): T {
  const directory = path.join(localPath(root), "state");
  mkdirSync(directory, { recursive: true });
  let release: () => void;
  // Longer than the bounded credential helpers/RPC; a crashed writer cannot
  // permanently disable the GUI. Atomic files + revision CAS remain the authority.
  try {
    release = lockfile.lockSync(path.join(directory, "settings-write"), {
      realpath: false,
      stale: 120000,
    });
  } catch {
    throw Error("SETTINGS_BUSY");
  }
  try {
    return action();
  } finally {
    release();
  }
}
export function saveConfig(
  input: unknown,
  revision: string,
  file = configPath,
  root = appRoot,
): Config {
  const next = configSchema.parse(input);
  return withSettingsLock(root, () => {
    const current = readConfig(file);
    if (hash(current) !== revision) throw Error("SETTINGS_CONFLICT");
    // Secrets never belong in this strict schema or its configuration backups.
    const backup = `${file}.${revision.slice(0, 12)}.bak`;
    if (!existsSync(backup))
      writeFileSync(backup, JSON.stringify(current, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    atomicWrite(file, JSON.stringify(next, null, 2) + "\n");
    if (hash(readConfig(file)) !== hash(next)) throw Error("SETTINGS_READBACK_FAILED");
    return next;
  });
}
