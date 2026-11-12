import type { PaseoApi, PaseoAgent } from "@getpaseo/client";

// Own the remote observation, not just a local callback on an otherwise silent
// connection. This includes agents created after the plugin was loaded.
export function watchAgentDirectory(
  paseo: PaseoApi,
  upsert: (agent: PaseoAgent) => void,
  remove: (id: string) => void,
) {
  const abort = new AbortController();
  let release: (() => Promise<void>) | undefined;
  async function observe() {
    try {
      const result = await paseo.agents.list({
        subscribe: {},
        signal: abort.signal,
        page: { limit: 200 },
      });
      release = () => result.subscription.release();
      if (abort.signal.aborted) {
        await release();
        return;
      }
      result.subscription.subscribe({
        snapshot: (snapshot) => {
          if (!abort.signal.aborted) snapshot.entries.forEach((entry) => upsert(entry.agent));
        },
        update: (message) => {
          if (abort.signal.aborted || message.type !== "agent_update") return;
          if (message.payload.kind === "upsert") upsert(message.payload.agent);
          else remove(message.payload.agentId);
        },
        error: () => {
          if (!abort.signal.aborted) console.warn("Orchestrator agent observation unavailable");
        },
      });
      let cursor = result.pageInfo.nextCursor;
      while (cursor && !abort.signal.aborted) {
        const page = await paseo.agents.list({
          page: { limit: 200, cursor },
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        page.entries.forEach((entry) => upsert(entry.agent));
        cursor = page.pageInfo.nextCursor;
      }
    } catch {
      if (!abort.signal.aborted) console.warn("Orchestrator agent observation unavailable");
    }
  }
  void observe();
  return () => {
    abort.abort();
    void release?.().catch(() => {});
  };
}
