import type {
  PluginClientContext,
  PluginSidebarItemProps,
  PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { OrchestratorSettings } from "./client/settings";
import { AgentStatus, WorkspaceStatus, StatusTimeline } from "./client/status";
import { statusSchema } from "./shared/status";
import { PrepareSession } from "./client/preparation";
import { watchAgentDirectory } from "./client/agent-directory";

const Roles = (props: PluginSurfaceProps) => (
  <OrchestratorSettings {...props} initialTab="routes" />
);
function Sidebar({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="SlidersHorizontal"
      active={currentScreen?.screenId === "orchestrator"}
      onPress={() => openScreen({ screenId: "orchestrator" })}
    />
  );
}
function PrepareSidebar({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Plus"
      active={currentScreen?.screenId === "orchestrator-prepare"}
      onPress={() => openScreen({ screenId: "orchestrator-prepare" })}
    />
  );
}
export default function contribute(client: PluginClientContext) {
  const pills = new Map<string, ReturnType<typeof client.addComposerPill>>();
  let disposed = false;
  const installPill = (agent: {
    id: string;
    workspaceId?: string | null;
    provider: string;
    cwd: string;
    labels?: Record<string, string>;
  }) => {
    if (
      disposed ||
      pills.has(agent.id) ||
      !agent.workspaceId ||
      agent.provider.split("/")[0] !== "codex" ||
      agent.labels?.controller === "variant-a" ||
      !/^C:[\\/]IFI_SourceCode(?:[\\/]|$)/i.test(agent.cwd)
    )
      return;
    pills.set(
      agent.id,
      client.addComposerPill({
        id: `auto-routing-${agent.id}`,
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: {
          title: "Auto-Routing und Status",
          icon: "Workflow",
          label: "Auto-Routing",
          behavior: {
            kind: "action",
            onPress: () =>
              client.openPanel("orchestrator-agent-status", {
                workspaceId: agent.workspaceId!,
                agentId: agent.id,
                location: "explorer",
              }),
          },
        },
      }),
    );
  };
  const subscription = watchAgentDirectory(client.paseo, installPill, (agentId) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  });
  const cleanups = [
    client.addScreen({
      id: "orchestrator-prepare",
      title: "Orchestrator-Session vorbereiten",
      Component: PrepareSession,
    }),
    client.addSidebarHeaderItem({
      id: "orchestrator-prepare",
      title: "Orchestrator-Session vorbereiten",
      Component: PrepareSidebar,
    }),
    client.addCommandCenterItem({
      id: "prepare-orchestrator-here",
      title: "Orchestrator-Session in diesem Workspace",
      icon: "Plus",
      keywords: ["neu", "session", "vorbereiten", "auto-routing"],
      context: "workspace",
      onSelect({ workspace, openScreen }) {
        openScreen({
          screenId: "orchestrator-prepare",
          params: { projectId: workspace.projectId, workspaceId: workspace.id },
        });
      },
    }),
    client.addCommandCenterItem({
      id: "prepare-orchestrator-session",
      title: "Orchestrator-Session vorbereiten",
      icon: "Plus",
      keywords: ["neu", "workspace", "session", "vorbereiten", "auto-routing"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: "orchestrator-prepare" });
      },
    }),
    client.addWorkspacePanel({
      id: "orchestrator-status",
      title: "Orchestrator",
      icon: "Workflow",
      locations: ["workspace", "explorer"],
      Component: WorkspaceStatus,
    }),
    client.addAgentPanel({
      id: "orchestrator-agent-status",
      title: "Orchestrator",
      icon: "Workflow",
      locations: ["workspace", "explorer"],
      Component: AgentStatus,
    }),
    client.addTimelineRenderer({
      kind: "orchestrator-status",
      version: 1,
      schema: statusSchema,
      Component: StatusTimeline,
    }),
    client.addCommandCenterItem({
      id: "open-orchestrator-status",
      title: "Orchestrator-Status / Auto-Routing",
      icon: "Workflow",
      keywords: ["automatisch", "fortschritt", "aufgaben", "decisions"],
      context: "agent",
      onSelect({ openPanel }) {
        openPanel("orchestrator-agent-status", { location: "explorer" });
      },
    }),
    client.addCommandCenterItem({
      id: "open-workspace-orchestrator-status",
      title: "Orchestrator-Übersicht in der Sidebar",
      icon: "Workflow",
      keywords: ["status", "fortschritt", "aufgaben"],
      context: "workspace",
      onSelect({ openPanel }) {
        openPanel("orchestrator-status", { location: "explorer" });
      },
    }),
    client.addSettingsScreen({
      id: "orchestrator-routes",
      title: "Routing & Decisions",
      icon: "SlidersHorizontal",
      Component: Roles,
    }),
    client.addScreen({ id: "orchestrator", title: "Orchestrator", Component: Roles }),
    client.addSidebarHeaderItem({ id: "orchestrator", title: "Orchestrator", Component: Sidebar }),
    client.addCommandCenterItem({
      id: "open-orchestrator-settings",
      title: "Orchestrator-Einstellungen",
      icon: "SlidersHorizontal",
      keywords: ["routing", "decisions", "modelle", "reasoning", "keys", "budgets"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: "orchestrator" });
      },
    }),
  ];
  return () => {
    disposed = true;
    subscription();
    pills.forEach((pill) => pill.remove());
    cleanups.forEach((cleanup) => cleanup());
  };
}
