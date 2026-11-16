import { readFileSync } from "node:fs";
import path from "node:path";
import { appRoot } from "./settings-files.ts";
import type { Store } from "./store.ts";

// Leaf module: no imports from intake.ts or automation.ts, so every gate can use it.
type AdvisoryReader = () => boolean;

function readAdvisoryFlag(): boolean {
  try {
    const file = path.join(appRoot, "state/automation.json");
    return JSON.parse(readFileSync(file, "utf8")).advisory === true;
  } catch {
    return false;
  }
}

let reader: AdvisoryReader = readAdvisoryFlag;

export function advisoryOn(): boolean {
  return reader();
}

// Test seam. Process-global: callers must run the returned restore function in `finally`.
export function useAdvisoryReader(next: AdvisoryReader): () => void {
  const previous = reader;
  reader = next;
  return () => {
    reader = previous;
  };
}

const codePattern = /^[A-Z][A-Z0-9_]{1,70}$/;
const sqliteCodePattern = /^SQLITE_[A-Z_]+$/;
// node:sqlite reports the primary result code in `errcode` and carries the code name only in `errstr`.
const sqliteBusy = 5;
const sqliteLocked = 6;
// Only static UPPER_SNAKE codes leave the process. Raw messages may carry paths or prompts.
export function softCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const { code, errcode, errstr } = error as Record<string, unknown>;
    if (typeof code === "string" && sqliteCodePattern.test(code)) return code;
    if (typeof errcode === "number") {
      if ((errcode & 0xff) === sqliteBusy) return "SQLITE_BUSY";
      if ((errcode & 0xff) === sqliteLocked) return "SQLITE_LOCKED";
    }
    if (errstr === "database is locked") return "SQLITE_BUSY";
  }
  const message = error instanceof Error ? error.message : "";
  return codePattern.test(message) ? message : "UNCLASSIFIED";
}

// Event rows that describe a decision, never authority. One row per kind and store.
const seenEvents = new WeakMap<Store, Set<string>>();
export function recordOnce(store: Store, kind: string, attemptId: string | null = null): void {
  try {
    let seen = seenEvents.get(store);
    if (!seen) seenEvents.set(store, (seen = new Set()));
    if (seen.has(kind)) return;
    if (!store.db.prepare("SELECT 1 FROM events WHERE kind=? LIMIT 1").get(kind))
      store.event(kind, attemptId);
    // Marked only after the row exists, so a failed write is retried on the next call.
    seen.add(kind);
  } catch {
    /* Recording must never change the outcome of the path it describes. */
  }
}

export function advisoryHint(
  store: Store,
  code: string,
  data: Readonly<Record<string, string | number>>,
  attemptId: string | null = null,
): void {
  recordOnce(store, `ADVISORY_HINT:${JSON.stringify({ code, ...data })}`, attemptId);
}
