import type { Provider, Snapshot } from "./provider.ts";
import { z } from "zod";

export type CompletionState =
  | "RUNNING"
  | "PERMISSION"
  | "VERIFY"
  | "WAITING_PROCESSES"
  | "NEEDS_CONFIRMATION";
export interface CompletionCapability {
  assess(snapshot: Snapshot): Promise<{ state: CompletionState; reason: string }>;
}

export interface NativeCompletionEvidence {
  agentId: string;
  providerSessionId: string;
  queryGeneration: string;
  observationId: string;
}
export interface BackgroundInventory {
  supported: boolean;
  verified: boolean;
  items: unknown[];
  nativeCompletion?: NativeCompletionEvidence;
}

export function nativeCompletionMatches(
  handle: Pick<BackgroundHandle, "id" | "runtimeInfo">,
  proof?: NativeCompletionEvidence,
  expected?: NativeCompletionEvidence,
): boolean {
  if (
    !proof ||
    proof.agentId !== handle.id ||
    proof.providerSessionId !== handle.runtimeInfo?.sessionId ||
    proof.queryGeneration !== handle.runtimeInfo?.extra?.backgroundWorkGeneration
  )
    return false;
  if (!expected) return true;
  return (
    proof.agentId === expected.agentId &&
    proof.providerSessionId === expected.providerSessionId &&
    proof.queryGeneration === expected.queryGeneration
  );
}

/** Known background state comes from the public SDK, supervised execution,
 * or a recorded operator confirmation of the exact completed turn. */
export class CurrentPaseoCompletion implements CompletionCapability {
  readonly provider: Pick<Provider, "foregroundEvidence">;
  constructor(provider: Pick<Provider, "foregroundEvidence">) {
    this.provider = provider;
  }
  async assess(s: Snapshot): Promise<{ state: CompletionState; reason: string }> {
    if (s.status === "permission") return { state: "PERMISSION", reason: "provider-permission" };
    if (s.status === "running" && !s.turnComplete)
      return { state: "RUNNING", reason: "turn-running" };
    if (s.foregroundActive || (!s.turnComplete && s.status !== "idle"))
      return { state: "NEEDS_CONFIRMATION", reason: "session-outcome-unknown" };
    if (s.backgroundActive === true)
      return { state: "WAITING_PROCESSES", reason: "known-background-work-running" };
    if (s.backgroundActive === null)
      return { state: "NEEDS_CONFIRMATION", reason: "process-coverage-unavailable" };
    if (this.provider.foregroundEvidence) {
      const trace = await this.provider.foregroundEvidence(s.id, s.nativeCompletion);
      if (!trace.complete)
        return {
          state: "NEEDS_CONFIRMATION",
          reason: "tool-history-incomplete-or-unobserved-work",
        };
    }
    return { state: "VERIFY", reason: "turn-and-known-work-complete" };
  }
}

// Documented optional handle surface from PR #6220. No internal RPC fallback;
// the SDK checks the daemon's negotiated feature gates.
export interface BackgroundHandle {
  id?: string;
  runtimeInfo?: { sessionId?: string | null; extra?: Record<string, unknown> } | null;
  backgroundWork?: {
    list?(): Promise<unknown[]>;
    refresh?(options?: { requestId?: string; timeout?: number }): Promise<unknown>;
    subscribe?(
      listener: (items: unknown[]) => void,
      options?: { onError?: (error: unknown) => void },
    ): () => void;
    stop?(item: unknown): Promise<void>;
  };
}
const backgroundObservationSchema = z.object({
  agentId: z.string().min(1),
  providerSessionId: z.string().min(1),
  observationId: z.string().min(1),
  coverage: z.enum(["codex_background_terminals", "claude_background_tasks"]),
  queryGeneration: z.string().min(1).optional(),
  foregroundActive: z.boolean().optional(),
  queriedProviderSessionIds: z.array(z.string()),
  items: z.array(z.unknown()),
  providerSubagents: z.array(
    z.object({ id: z.string(), status: z.enum(["running", "completed", "failed", "canceled"]) }),
  ),
});
function nativeCompletionFromObservation(
  observation: z.infer<typeof backgroundObservationSchema>,
  items: readonly unknown[],
): NativeCompletionEvidence | undefined {
  if (
    observation.coverage !== "claude_background_tasks" ||
    !observation.queryGeneration ||
    items.length > 0
  )
    return undefined;
  return {
    agentId: observation.agentId,
    providerSessionId: observation.providerSessionId,
    queryGeneration: observation.queryGeneration,
    observationId: observation.observationId,
  };
}
export async function verifiedProviderSessionId(handle: BackgroundHandle): Promise<string> {
  const savedSessionId = handle.runtimeInfo?.sessionId;
  if (savedSessionId) return savedSessionId;
  if (!handle.id || !handle.backgroundWork?.refresh) throw Error("INTAKE_SESSION_ID_UNAVAILABLE");
  let observation: z.infer<typeof backgroundObservationSchema>;
  try {
    observation = backgroundObservationSchema.parse(await handle.backgroundWork.refresh());
  } catch {
    throw Error("INTAKE_SESSION_ID_UNAVAILABLE");
  }
  if (
    observation.agentId !== handle.id ||
    !observation.queriedProviderSessionIds.includes(observation.providerSessionId)
  )
    throw Error("INTAKE_SESSION_ID_MISMATCH");
  const refreshedSessionId = handle.runtimeInfo?.sessionId;
  if (refreshedSessionId && refreshedSessionId !== observation.providerSessionId)
    throw Error("INTAKE_HISTORY_SESSION_CHANGED");
  return observation.providerSessionId;
}
export class OptionalBackgroundCapability {
  readonly handle: BackgroundHandle;
  constructor(handle: BackgroundHandle) {
    this.handle = handle;
  }
  get available(): boolean {
    return typeof this.handle.backgroundWork?.refresh === "function";
  }
  async inventory(): Promise<BackgroundInventory> {
    if (!this.available) return { supported: false, verified: false, items: [] };
    try {
      const sessionId = this.handle.runtimeInfo?.sessionId;
      if (!sessionId || !this.handle.id) throw Error("Background observation identity unavailable");
      // The SDK requires agentBackgroundWorkRefresh and awaits a new native
      // query. Cached list/count=0 is deliberately never a completion proof.
      const observation = backgroundObservationSchema.parse(
        await this.handle.backgroundWork!.refresh!(),
      );
      if (
        observation.agentId !== this.handle.id ||
        (observation.coverage === "claude_background_tasks" &&
          (!observation.queryGeneration ||
            observation.foregroundActive !== false ||
            this.handle.runtimeInfo?.extra?.backgroundWorkGeneration !==
              observation.queryGeneration)) ||
        observation.providerSessionId !== sessionId ||
        !observation.queriedProviderSessionIds.includes(sessionId) ||
        this.handle.runtimeInfo?.sessionId !== sessionId
      )
        throw Error("Background observation session changed");
      const runningSubagents = observation.providerSubagents.filter(
        (agent) => agent.status === "running",
      );
      const items = [...observation.items, ...runningSubagents];
      const nativeCompletion = nativeCompletionFromObservation(observation, items);
      return {
        supported: true,
        verified: true,
        items,
        ...(nativeCompletion ? { nativeCompletion } : {}),
      };
    } catch {
      return { supported: true, verified: false, items: [] };
    }
  }
  subscribe(listener: (items: unknown[]) => void, onError: (error: unknown) => void): () => void {
    const api = this.handle.backgroundWork;
    if (!api?.subscribe) throw Error("Background subscriptions not available in installed SDK");
    return api.subscribe(listener, { onError });
  }
  async stop(item: unknown): Promise<void> {
    const api = this.handle.backgroundWork;
    if (!api?.stop) throw Error("Background stop not available in installed SDK");
    await api.stop(item);
  }
}
