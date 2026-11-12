import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { withTimeout } from "../../../../utils/promise-timeout.js";
import type { Query, SDKMessage, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import {
  AgentBackgroundWorkRefreshError,
  type AgentBackgroundWorkObservationInput,
} from "../../background-work/index.js";

interface Snapshot {
  uuid: string;
  sessionId: string;
}
interface PendingRefresh {
  requestId: string | null;
  acknowledged: boolean;
  fulfilled: boolean;
  snapshot: Snapshot | null;
  processed: string | null;
  barrier: string | null;
  finish(error?: AgentBackgroundWorkRefreshError): void;
}
interface RefreshInput {
  query: Query;
  sessionId: string | null;
  isCurrent(): boolean;
  observation(
    sessionId: string,
  ): Omit<AgentBackgroundWorkObservationInput, "observationId" | "queryGeneration">;
}

/** Correlates SDK-owned initialize frames before the SDK's separate message queue. */
export class ClaudeBackgroundInventory {
  private generation: string | null = null;
  private pending: PendingRefresh | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private readers = 0;
  private revision = 0;

  get queryGeneration(): string | null {
    return this.generation;
  }

  get refreshing(): boolean {
    return this.readers > 0;
  }
  get stateRevision(): number | null {
    return this.generation ? this.revision : null;
  }

  attach(child: SpawnedProcess): SpawnedProcess {
    this.invalidate();
    const generation = randomUUID();
    this.generation = generation;
    this.revision = 0;
    const input = this.tap(generation, (frame) => this.sent(frame));
    const output = this.tap(generation, (frame) => this.received(frame));
    // Transform streams retain every byte and apply normal pipe backpressure.
    // No data listener puts the child into flowing mode before a destination exists.
    input.pipe(child.stdin);
    child.stdout.pipe(output);
    const failed = () => this.invalidate(generation);
    child.once("exit", failed);
    child.once("error", failed);
    child.stdin.on("error", (error) => {
      failed();
      input.destroy(error);
    });
    child.stdout.on("error", (error) => {
      failed();
      output.destroy(error);
    });
    return {
      stdin: input,
      stdout: output,
      get killed() {
        return child.killed;
      },
      get exitCode() {
        return child.exitCode;
      },
      get signalCode() {
        return child.signalCode;
      },
      kill: child.kill.bind(child),
      on: child.on.bind(child),
      once: child.once.bind(child),
      off: child.off.bind(child),
    };
  }

  invalidate(generation: string | null = this.generation): void {
    if (generation !== this.generation) return;
    this.generation = null;
    this.pending?.finish(new AgentBackgroundWorkRefreshError("BACKGROUND_WORK_SESSION_CHANGED"));
  }

  refresh(input: RefreshInput): Promise<AgentBackgroundWorkObservationInput> {
    this.readers++;
    const operation = this.tail.then(() => this.refreshSerialized(input));
    this.tail = operation.catch(() => undefined);
    return operation.finally(() => {
      this.readers--;
    });
  }

  private async refreshSerialized(
    input: RefreshInput,
  ): Promise<AgentBackgroundWorkObservationInput> {
    const generation = this.generation;
    if (!generation || !input.isCurrent())
      throw new AgentBackgroundWorkRefreshError("BACKGROUND_WORK_SESSION_UNAVAILABLE");
    // The first initialize belongs to query startup, never to this refresh.
    await withTimeout(
      input.query.initializationResult(),
      30_000,
      "BACKGROUND_WORK_REFRESH_TIMEOUT",
    );
    if (generation !== this.generation || !input.isCurrent())
      throw new AgentBackgroundWorkRefreshError("BACKGROUND_WORK_SESSION_CHANGED");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          pending.finish(new AgentBackgroundWorkRefreshError("BACKGROUND_WORK_REFRESH_TIMEOUT")),
        30_000,
      );
      const pending: PendingRefresh = {
        requestId: null,
        acknowledged: false,
        fulfilled: false,
        snapshot: null,
        processed: null,
        barrier: null,
        finish: (error) => {
          if (this.pending !== pending) return;
          if (
            !error &&
            (!pending.fulfilled || !pending.snapshot || pending.processed !== pending.barrier)
          )
            return;
          clearTimeout(timer);
          this.pending = null;
          if (error) {
            this.generation = null;
            reject(error);
            return;
          }
          if (
            generation !== this.generation ||
            !input.isCurrent() ||
            (input.sessionId !== null && pending.snapshot!.sessionId !== input.sessionId)
          ) {
            reject(new AgentBackgroundWorkRefreshError("BACKGROUND_WORK_SESSION_CHANGED"));
            return;
          }
          try {
            resolve({
              ...input.observation(pending.snapshot!.sessionId),
              observationId: randomUUID(),
              queryGeneration: generation,
              stateRevision: this.revision,
            });
          } catch (failure) {
            reject(failure);
          }
        },
      };
      this.pending = pending;
      // This is the only control operation we initiate. The public spawn tap observes
      // its SDK-generated request ID; neither Query internals nor raw requests are used.
      void input.query.reinitialize().then(
        () => {
          pending.fulfilled = true;
          pending.finish();
          return undefined;
        },
        () => pending.finish(new AgentBackgroundWorkRefreshError("BACKGROUND_WORK_REFRESH_FAILED")),
      );
    });
  }

  processed(message: SDKMessage): void {
    const pending = this.pending;
    if (!pending || !("uuid" in message) || pending.barrier !== message.uuid) return;
    pending.processed = message.uuid;
    pending.finish();
  }

  private sent(frame: Record<string, unknown>): void {
    if (frame.type === "user") this.revision++;
    const request = frame.request as Record<string, unknown> | undefined;
    if (frame.type !== "control_request" || request?.subtype !== "initialize") return;
    const pending = this.pending;
    if (!pending) return;
    if (pending.requestId !== null || typeof frame.request_id !== "string") {
      pending.finish(new AgentBackgroundWorkRefreshError("BACKGROUND_WORK_REFRESH_FAILED"));
      return;
    }
    pending.requestId = frame.request_id;
  }

  private received(frame: Record<string, unknown>): void {
    if (typeof frame.uuid === "string" || frame.type === "control_request") this.revision++;
    const pending = this.pending;
    if (!pending?.requestId) return;
    const response = frame.response as Record<string, unknown> | undefined;
    if (frame.type === "control_response" && response?.request_id === pending.requestId) {
      if (response.subtype !== "success")
        pending.finish(new AgentBackgroundWorkRefreshError("BACKGROUND_WORK_REFRESH_FAILED"));
      else pending.acknowledged = true;
      return;
    }
    if (pending.acknowledged && frame.type === "control_request") {
      pending.finish(new AgentBackgroundWorkRefreshError("BACKGROUND_WORK_REFRESH_FAILED"));
      return;
    }
    if (pending.acknowledged && typeof frame.uuid === "string") pending.barrier = frame.uuid;
    if (
      pending.acknowledged &&
      frame.type === "system" &&
      frame.subtype === "background_tasks_changed" &&
      typeof frame.uuid === "string" &&
      typeof frame.session_id === "string" &&
      Array.isArray(frame.tasks)
    ) {
      pending.snapshot = { uuid: frame.uuid, sessionId: frame.session_id };
    }
  }

  private tap(generation: string, observe: (frame: Record<string, unknown>) => void): Transform {
    const decoder = new StringDecoder("utf8");
    let buffered = "";
    const invalidate = () => this.invalidate(generation);
    return new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        if (this.generation === generation) {
          buffered += decoder.write(chunk);
          let newline: number;
          while ((newline = buffered.indexOf("\n")) !== -1) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            if (!line.trim()) continue;
            try {
              const frame: unknown = JSON.parse(line);
              if (frame && typeof frame === "object" && !Array.isArray(frame))
                observe(frame as Record<string, unknown>);
            } catch {
              invalidate();
            }
          }
          if (buffered.length > 4 * 1024 * 1024) invalidate();
        }
        callback(null, chunk);
      },
      flush: (callback) => {
        invalidate();
        callback();
      },
      destroy: (error, callback) => {
        invalidate();
        callback(error);
      },
    });
  }
}
