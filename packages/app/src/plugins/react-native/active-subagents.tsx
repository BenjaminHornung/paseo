import { Text, View } from "react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePaneContext } from "@/panels/pane-context";
import { useSubagentsForParent, type SubagentRow } from "@/subagents/select";
import {
  activeSubagentRows,
  buildSubagentRowPresentationData,
} from "@/subagents/track-presentation";
import { subagentRowTarget } from "@/subagents/sheet-tab";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StyleSheet } from "react-native-unistyles";
import { useSessionStore } from "@/stores/session-store";
import { refreshProviderSubagents } from "@/subagents/provider-store";
import { useProviderIcon } from "@/components/provider-icons";
import { WorkspaceTabIcon } from "@/screens/workspace/workspace-tab-presentation";

export function ActiveSubagents({ agentId }: { agentId: string }) {
  const { serverId } = usePaneContext();
  const rows = useSubagentsForParent({ serverId, parentAgentId: agentId, refresh: false });
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const serverInfo = useSessionStore((state) => state.sessions[serverId]?.serverInfo ?? null);
  const supported = serverInfo?.features?.providerSubagents === true;
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    let current = true;
    if (!client) {
      setLoadState("error");
    } else if (!serverInfo) {
      setLoadState("loading");
    } else if (!supported) {
      setLoadState("ready");
    } else {
      setLoadState("loading");
      void refreshProviderSubagents(client, serverId, agentId).then(
        () => {
          if (current) setLoadState("ready");
          return null;
        },
        () => {
          if (current) setLoadState("error");
          return null;
        },
      );
    }
    return () => {
      current = false;
    };
  }, [agentId, client, serverId, serverInfo, supported]);
  const active = activeSubagentRows(rows);
  return (
    <View style={styles.container}>
      {loadState !== "ready" && (
        <Text style={styles.muted}>
          {loadState === "loading"
            ? "Subagents werden geladen …"
            : "Subagents konnten nicht vollständig geladen werden."}
        </Text>
      )}
      {loadState === "ready" && !active.length && (
        <Text style={styles.muted}>Keine aktiven Subagents.</Text>
      )}
      {active.map((row) => (
        <ActiveSubagentButton key={`${row.kind}:${row.id}`} row={row} />
      ))}
    </View>
  );
}

function ActiveSubagentButton({ row }: { row: SubagentRow }) {
  const { serverId, workspaceId, openPreferredTarget } = usePaneContext();
  const rowServerId = row.kind === "paseo" ? row.address.serverId : serverId;
  const icon = useProviderIcon(row.provider, rowServerId);
  const presentation = useMemo(() => {
    const data = buildSubagentRowPresentationData(row);
    const label = data.label || "Subagent";
    return { ...data, label, tooltip: label, modified: false, showCloseButton: false, icon };
  }, [row, icon]);
  const label = presentation.label;
  const open = useCallback(() => {
    const agent =
      row.kind === "paseo"
        ? useSessionStore.getState().sessions[row.address.serverId]?.agents.get(row.id)
        : undefined;
    if (
      row.kind === "paseo" &&
      (row.address.serverId !== serverId ||
        (agent?.workspaceId && agent.workspaceId !== workspaceId))
    ) {
      navigateToAgent(row.address);
    } else {
      openPreferredTarget(subagentRowTarget(row), "subagents");
    }
  }, [row, serverId, workspaceId, openPreferredTarget]);
  return (
    <Tooltip enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <PressHighlight
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={open}
          style={styles.row}
        >
          <WorkspaceTabIcon presentation={presentation} backdrop="surface1" />
          <Text numberOfLines={1} ellipsizeMode="tail" style={styles.label}>
            {label}
          </Text>
        </PressHighlight>
      </TooltipTrigger>
      <TooltipContent>
        <Text style={styles.label}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: 6 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    minWidth: 0,
  },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.base, flexShrink: 1 },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
