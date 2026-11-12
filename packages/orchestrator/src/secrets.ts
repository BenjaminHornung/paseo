import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import {
  appRoot,
  codeRoot,
  atomicWrite,
  withSettingsLock,
  powershellExecutable,
} from "./settings-files.ts";
import { localPath } from "./contracts.ts";

export type CredentialSlot = "normal" | "decisions";
export interface CredentialStatus {
  present: boolean;
  source: "pi" | "encrypted" | "missing";
  revision: string;
}
export class CredentialVault {
  readonly root: string;
  readonly piAuth: string;
  constructor(root = appRoot, piAuth = path.join(root, "state/pi-profile/auth.json")) {
    this.root = localPath(root);
    this.piAuth = piAuth;
  }
  private file(slot: CredentialSlot, generation = ""): string {
    return path.join(
      this.root,
      "state/secrets",
      slot + (generation ? "-" + generation : "") + ".dpapi",
    );
  }
  private revision(file: string): string {
    if (!existsSync(file)) return "missing";
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  }
  private piEntry(): { type?: string; key?: string } | undefined {
    if (!existsSync(this.piAuth)) return undefined;
    return JSON.parse(readFileSync(this.piAuth, "utf8")).openai;
  }
  private reference(generation = ""): string {
    localPath(powershellExecutable);
    return `!"${powershellExecutable.replaceAll("/", "\\")}" -NoProfile -NonInteractive -File "${path.join(codeRoot, "scripts/pi-normal-key.ps1")}"${generation ? " -Generation " + generation : ""}`;
  }
  private managedGeneration(key: string | undefined): string | undefined {
    if (key === this.reference()) return "";
    const prefix = this.reference() + " -Generation ";
    const generation = key?.startsWith(prefix) ? key.slice(prefix.length) : undefined;
    return generation && /^[a-f0-9]{32}$/.test(generation) ? generation : undefined;
  }
  status(slot: CredentialSlot): CredentialStatus {
    const entry = slot === "normal" ? this.piEntry() : undefined,
      generation = this.managedGeneration(entry?.key);
    const file = this.file(slot, slot === "normal" ? generation : undefined);
    if (slot === "normal" && generation === undefined)
      return {
        present: entry?.type === "api_key" && !!entry.key,
        source: entry?.key ? "pi" : "missing",
        revision: this.revision(this.piAuth),
      };
    return {
      present: existsSync(file),
      source: existsSync(file) ? "encrypted" : "missing",
      revision: (slot === "normal" ? this.revision(this.piAuth) + "/" : "") + this.revision(file),
    };
  }
  private crypt(operation: "protect" | "unprotect", value: string): string {
    const r = spawnSync(
      localPath(powershellExecutable),
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        path.join(codeRoot, "scripts/credential-crypto.ps1"),
      ],
      {
        cwd: this.root,
        input: JSON.stringify({ operation, value }),
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 16384,
        windowsHide: true,
        env: { ...process.env, PASEO_ORCHESTRATOR_DATA_ROOT: this.root },
      },
    );
    // The child output can contain a key. It is consumed only in memory, never logged.
    if (r.status !== 0 || !r.stdout?.trim()) throw Error("CREDENTIAL_STORE_FAILED");
    return r.stdout.trim();
  }
  read(slot: CredentialSlot): string | undefined {
    let generation: string | undefined;
    if (slot === "normal") {
      const entry = this.piEntry();
      generation = this.managedGeneration(entry?.key);
      if (generation === undefined)
        return entry?.type === "api_key" && entry.key && !entry.key.startsWith("!")
          ? entry.key
          : undefined;
    }
    const file = this.file(slot, generation);
    if (!existsSync(file)) return undefined;
    if (!lstatSync(file).isFile() || localPath(file) !== path.resolve(file).toLowerCase())
      throw Error("CREDENTIAL_PATH_INVALID");
    return this.crypt("unprotect", readFileSync(file, "utf8").trim());
  }
  save(slot: CredentialSlot, key: string, revision: string): void {
    if (!/^sk-[a-zA-Z0-9_-]{16,1000}$/.test(key)) throw Error("CREDENTIAL_FORMAT_INVALID");
    withSettingsLock(this.root, () => {
      // Use Pi's own lock protocol: /login and OAuth refresh are other writers.
      let release: (() => void) | undefined;
      try {
        release = lockfile.lockSync(this.piAuth, { realpath: false, stale: 30000 });
      } catch {
        throw Error("PI_CREDENTIALS_BUSY");
      }
      try {
        if (this.status(slot).revision !== revision) throw Error("CREDENTIAL_CONFLICT");
        const other = this.read(slot === "normal" ? "decisions" : "normal");
        if (other && other === key) throw Error("SEPARATE_PROJECT_KEYS_REQUIRED");
        const directory = path.dirname(this.file(slot));
        mkdirSync(directory, { recursive: true });
        localPath(directory);
        const encrypted = this.crypt("protect", key);
        if (slot === "normal") {
          const auth = existsSync(this.piAuth) ? JSON.parse(readFileSync(this.piAuth, "utf8")) : {};
          if (auth.openai && auth.openai.type !== "api_key") throw Error("PI_AUTH_TYPE_MISMATCH");
          // A new reference also invalidates Pi's process-local command-result cache.
          // Older encrypted generations remain usable by already-open Pi sessions.
          const generation = randomUUID().replaceAll("-", "");
          atomicWrite(this.file(slot, generation), encrypted + "\n");
          auth.openai = { ...auth.openai, type: "api_key", key: this.reference(generation) };
          atomicWrite(this.piAuth, JSON.stringify(auth, null, 2) + "\n");
        } else atomicWrite(this.file(slot), encrypted + "\n");
      } finally {
        release();
      }
    });
  }
}
