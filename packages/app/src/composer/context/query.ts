import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { DraftCommandTarget } from "@/agent-commands";

export function useHarnessContext(
  serverId: string,
  agentId: string,
  enabled: boolean,
  draft?: DraftCommandTarget,
) {
  const client = useHostRuntimeClient(serverId);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.harnessContext === true,
  );
  const provider = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.provider,
  );
  const draftConfig = draft?.status === "ready" ? draft.config : undefined;
  return useFetchQuery({
    queryKey: ["harness-context", serverId, agentId, provider, draftConfig],
    enabled: enabled && supported && !!client && !!(provider ?? draftConfig?.provider),
    dataShape: "value",
    staleTimeMs: 10_000,
    retry: false,
    queryFn: async () => {
      if (!client) throw new Error("Host disconnected");
      const result = await client.listHarnessContext(agentId, draftConfig);
      if (result.error && result.entries.length === 0) throw new Error(result.error);
      return result;
    },
  });
}
