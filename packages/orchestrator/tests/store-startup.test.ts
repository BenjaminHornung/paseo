import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { Store } from "../src/store.ts";

interface StartupResult {
  ok: boolean;
  version?: number;
  workflowCount?: number;
  code?: string;
  sqliteCode?: number;
  message?: string;
}

function startWorker(database: string) {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { database },
    execArgv: [],
  });
  let readyReceived = false;
  let resultReceived = false;
  let resolveReady!: (result: { ok: boolean; message?: string }) => void;
  let resolveResult!: (result: StartupResult) => void;
  const ready = new Promise<{ ok: boolean; message?: string }>((resolve) => {
    resolveReady = resolve;
  });
  const result = new Promise<StartupResult>((resolve) => {
    resolveResult = resolve;
  });

  worker.on("message", (value: unknown) => {
    const message = value as { ready?: boolean } & StartupResult;
    if (message.ready && !readyReceived) {
      readyReceived = true;
      resolveReady({ ok: true });
    } else if (typeof message.ok === "boolean" && !resultReceived) {
      resultReceived = true;
      resolveResult(message);
    }
  });
  worker.on("error", (error) => {
    if (!readyReceived) {
      readyReceived = true;
      resolveReady({ ok: false, message: error.message });
    }
    if (!resultReceived) {
      resultReceived = true;
      resolveResult({ ok: false, message: error.message });
    }
  });
  worker.on("exit", (code) => {
    if (!readyReceived) {
      readyReceived = true;
      resolveReady({ ok: false, message: `worker exited before readiness (${code})` });
    }
    if (!resultReceived) {
      resultReceived = true;
      resolveResult({ ok: false, message: `worker exited before opening the store (${code})` });
    }
  });

  return { worker, ready, result };
}

function verifyTemporaryRoot(stateDirectory: string, temporaryRoot: string): string {
  const canonicalWorkspace = realpathSync(process.cwd());
  const canonicalStateDirectory = realpathSync(stateDirectory);
  const canonicalTemporaryRoot = realpathSync(temporaryRoot);
  const stateRelative = path.relative(canonicalWorkspace, canonicalStateDirectory);
  if (
    !stateRelative ||
    stateRelative === ".." ||
    stateRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(stateRelative)
  ) {
    throw Error("Store startup test state escaped its workspace");
  }
  const relative = path.relative(canonicalStateDirectory, canonicalTemporaryRoot);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw Error("Store startup test cleanup path escaped its isolated state directory");
  }
  return canonicalTemporaryRoot;
}

if (!isMainThread) {
  parentPort!.once("message", () => {
    try {
      const database = (workerData as { database: string }).database;
      const store = new Store(database);
      let version: number;
      let workflowCount: number;
      try {
        version = (store.db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version;
        workflowCount = (
          store.db.prepare("SELECT COUNT(*) AS count FROM workflows").get() as { count: number }
        ).count;
      } finally {
        store.close();
      }
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker messages have no targetOrigin.
      parentPort!.postMessage({ ok: true, version, workflowCount } satisfies StartupResult);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { errcode?: number };
      const result: StartupResult = {
        ok: false,
        code: failure.code,
        sqliteCode: failure.errcode,
        message: failure.message,
      };
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker messages have no targetOrigin.
      parentPort!.postMessage(result);
    }
  });
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker messages have no targetOrigin.
  parentPort!.postMessage({ ready: true });
} else {
  test(
    "concurrent first opens initialize one usable v9 controller database",
    { timeout: 30000 },
    async () => {
      const stateDirectory = path.join(process.cwd(), "state");
      mkdirSync(stateDirectory, { recursive: true });
      const temporaryRoot = mkdtempSync(path.join(realpathSync(stateDirectory), "store-startup-"));
      const safeTemporaryRoot = verifyTemporaryRoot(stateDirectory, temporaryRoot);
      const database = path.join(safeTemporaryRoot, "controller.sqlite");
      const sessions = Array.from({ length: 8 }, () => startWorker(database));

      try {
        const readyResults = await Promise.all(sessions.map((session) => session.ready));
        assert.ok(
          readyResults.every((result) => result.ok),
          JSON.stringify(readyResults),
        );

        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker messages have no targetOrigin.
        for (const session of sessions) session.worker.postMessage("open");
        const results = await Promise.all(sessions.map((session) => session.result));
        const failures = results.filter((result) => !result.ok);
        assert.deepEqual(
          failures,
          [],
          `all workers should open the fresh database: ${JSON.stringify(failures)}`,
        );
        assert.deepEqual(
          results.map((result) => result.version),
          Array(8).fill(9),
        );
        assert.deepEqual(
          results.map((result) => result.workflowCount),
          Array(8).fill(0),
        );
      } finally {
        await Promise.all(sessions.map((session) => session.worker.terminate()));
        const verifiedCleanupPath = verifyTemporaryRoot(stateDirectory, safeTemporaryRoot);
        rmSync(verifiedCleanupPath, { recursive: true, force: true });
      }
    },
  );
}
