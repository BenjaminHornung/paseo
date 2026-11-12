import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import path from "node:path";
import lockfile from "proper-lockfile";
import { localPath } from "./contracts.ts";

export interface WatchLease {
  held(): boolean;
  release(): Promise<void>;
}

// Keep the filesystem heartbeat independent of the controller's synchronous
// build/test calls. A crashed controller's worker dies with it; its lock can
// expire promptly without taking over a healthy long-running check.
if (!isMainThread && workerData?.kind === "paseo-watch-lock") {
  try {
    const release = lockfile.lockSync(workerData.filename, {
      realpath: false,
      stale: 15000,
      update: 1000,
      onCompromised: () => {
        parentPort?.postMessage("lost");
        parentPort?.close();
      },
    });
    parentPort?.postMessage("locked");
    parentPort?.once("message", () => {
      try {
        release();
      } finally {
        parentPort?.close();
      }
    });
  } catch (error) {
    parentPort?.postMessage(
      error instanceof Error && "code" in error && error.code === "ELOCKED" ? "busy" : "failed",
    );
    parentPort?.close();
  }
}

export async function acquireWatchLease(filename: string): Promise<WatchLease> {
  localPath(path.dirname(filename));
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { kind: "paseo-watch-lock", filename },
  });
  let held = false;
  const exited = new Promise<void>((resolve) =>
    worker.once("exit", () => {
      held = false;
      resolve();
    }),
  );
  await new Promise<void>((resolve, reject) => {
    worker.on("message", (message) => {
      if (message === "locked") {
        held = true;
        resolve();
      } else {
        held = false;
        reject(Error(message === "busy" ? "WATCH_ALREADY_RUNNING" : "WATCH_LOCK_LOST"));
      }
    });
    worker.once("error", () => {
      held = false;
      reject(Error("WATCH_LOCK_FAILED"));
    });
    worker.once("exit", () => {
      held = false;
      reject(Error("WATCH_LOCK_CLOSED"));
    });
  });
  return {
    held: () => held,
    release: async () => {
      if (held) worker.postMessage("release");
      await exited;
    },
  };
}
