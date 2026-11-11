import {
  useAgent,
  type PluginClientContext,
  useWorkspace,
  useRpc,
  type PluginAgentPanelProps,
  type PluginWorkspacePanelProps,
  type PluginSurfaceProps,
  type PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import {
  Icon,
  ActiveSubagents,
  Loading,
  Modal,
  ScrollView,
  SettingsAction,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Text, View } from "react-native";
import {
  loadStatus,
  autoRouting,
  phaseLabel,
  reasonLabel,
  type WorkflowStatus,
} from "../shared/status";
import {
  currentTask,
  decisionView,
  needsAttention,
  taskLabel,
  workerNeedsReconciliation,
} from "../shared/status-view";
import { decisionsHistory } from "../shared/decisions-history";
import { DecisionsHistory } from "./decisions-history";
import { CompactAction } from "./compact-action";

const automationLabel = {
  off: "Aus",
  arming: "Wird eingerichtet",
  ready: "Ein",
  uncertain: "Aktivierung unklar – keine neuen Starts",
};
const runnerLabel = {
  stopped: "Controller-Schleife aus",
  starting: "Controller startet",
  running: "Controller überwacht Aufträge",
  waiting: "Wartet auf die bestehende Controller-Schleife",
  failed: "Controller-Start fehlgeschlagen",
};
function actionError(error: unknown): string {
  const code =
    typeof error === "object" && error && "safeCode" in error
      ? String(error.safeCode)
      : error instanceof Error
        ? error.message
        : "";
  if (code.includes("MAIN_MUST_BE_IDLE"))
    return "Beende zuerst den laufenden Turn, bevor du Auto-Routing einschaltest.";
  if (code.includes("ACTIVATION_UNCERTAIN"))
    return "Aktivierung unklar. Prüfe den Hauptchat vor einem erneuten Einschalten.";
  if (code.includes("INITIALIZATION_FAILED"))
    return "Session noch nicht bereit. Nach dem Start erneut einschalten.";
  if (code.includes("MAIN_REQUIRED")) return "Auto-Routing benötigt eine Codex-Hauptsession.";
  return "Aktion fehlgeschlagen. Bitte erneut prüfen.";
}
function StatusBody(
  props: PluginSurfaceProps & { directory: string; agentId?: string; controls?: boolean },
) {
  const load = useRpc(loadStatus);
  const toggle = useRpc(autoRouting);
  const loadDecisions = useRpc(decisionsHistory);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const query = useQuery({
    queryKey: ["orchestrator-status", props.directory, props.agentId],
    queryFn: () => load({ directory: props.directory, agentId: props.agentId }),
    refetchInterval: 5000,
    retry: false,
  });
  const state = query.data;
  const agentId = props.agentId ?? state?.mainAgentId;
  const main = useAgent(agentId ?? "", (value) => ({ provider: value.provider }));
  const controls = !!agentId && (props.controls || main?.provider.split("/")[0] === "codex");
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => toggle({ agentId: agentId!, enabled }),
    onSuccess: () => {
      void query.refetch();
    },
  });
  const history = useQuery({
    queryKey: ["decisions-history", agentId, props.directory, undefined],
    queryFn: () => loadDecisions({ directory: props.directory, agentId }),
    enabled: !!agentId,
    refetchInterval: 5000,
    retry: false,
  });
  const latest = history.data?.items[0];
  const decision = useQuery({
    queryKey: ["decision-detail", agentId, latest?.id],
    queryFn: () => loadDecisions({ directory: props.directory, agentId, assessmentId: latest!.id }),
    enabled: !!latest,
    refetchInterval: 5000,
    retry: false,
  });
  const view = decisionView({
    latestId: latest?.id,
    detail: decision.data?.detail,
    loading: history.isPending || (!!latest && decision.isPending),
    error: history.isError || decision.isError,
  });
  const { status: decisionStatus, summary } = view;
  const task = currentTask(state?.tasks ?? []);
  const workerId =
    task?.attemptState === "VERIFY" && task.review?.agentId ? task.review.agentId : task?.agentId;
  const worker = useAgent(workerId ?? "", (value) => ({
    status: value.status,
    lastActivityAt: value.lastActivityAt,
    title: value.title,
    requiresAttention: value.requiresAttention,
    attentionReason: value.attentionReason,
  }));
  const reconcile = !!task && workerNeedsReconciliation(task, worker, Date.now());
  const attention =
    !!task &&
    (needsAttention(task) ||
      reconcile ||
      worker?.status === "error" ||
      worker?.attentionReason === "permission");
  const title = !state
    ? "Status wird geladen"
    : state.dispatchPaused
      ? "Neue Starts pausiert"
      : attention
        ? "Wartet auf Klärung"
        : task?.state === "COMPLETE"
          ? "Verifiziert abgeschlossen"
          : task
            ? taskLabel(task, phaseLabel)
            : "Bereit für deinen Auftrag";
  const colors = props.theme.colors;
  let attentionMessage = title;
  if (reconcile) attentionMessage = "Worker ruht; Abgleich ausstehend.";
  else if (task?.errorKind) attentionMessage = reasonLabel[task.errorKind] ?? task.errorKind;
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <View style={{ padding: 12, gap: 4, borderBottomWidth: 1, borderColor: colors.border }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon
            name={attention ? "TriangleAlert" : "Workflow"}
            size={16}
            color={attention ? colors.statusWarning : colors.foregroundMuted}
          />
          <Text
            accessibilityRole="header"
            style={{ flex: 1, color: colors.foreground, fontWeight: "600" }}
          >
            {title}
          </Text>
          <CompactAction
            theme={props.theme}
            label="Status aktualisieren"
            icon="RefreshCw"
            iconOnly
            disabled={query.isFetching}
            onPress={() => void query.refetch()}
          />
        </View>
        {state && (
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
            {runnerLabel[state.runner]} · Auto-Routing {automationLabel[state.automation]}
          </Text>
        )}
        {controls && state && (
          <SettingsSwitch
            label="Auto-Routing"
            value={state.automation !== "off"}
            disabled={mutation.isPending}
            onValueChange={(value) => mutation.mutate(value)}
          />
        )}
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 20 }}>
        {!state && query.isPending && <Loading />}
        {query.isError && (
          <Text style={{ color: colors.statusWarning }}>
            Status konnte nicht geladen werden. Angezeigte Daten können veraltet sein.
          </Text>
        )}
        {mutation.isError && (
          <Text style={{ color: colors.statusWarning }}>{actionError(mutation.error)}</Text>
        )}
        {state?.timelineAvailable === false && (
          <Text style={{ color: colors.statusWarning }}>
            Chat-Status nicht verfügbar; gespeicherter Stand.
          </Text>
        )}
        {state?.runner === "failed" && (
          <Text style={{ color: colors.statusDanger }}>Controller-Start fehlgeschlagen.</Text>
        )}
        {state?.automation === "uncertain" && (
          <Text style={{ color: colors.statusWarning }}>
            Aktivierung unklar. Hauptchat vor erneutem Einschalten prüfen.
          </Text>
        )}
        {state?.writeAuthorization?.allowed === false && (
          <Text style={{ color: colors.statusWarning }}>
            Neue Schreibstarts gesperrt:{" "}
            {reasonLabel[state.writeAuthorization.reason] ?? state.writeAuthorization.reason}
          </Text>
        )}
        {attention && <Text style={{ color: colors.statusWarning }}>{attentionMessage}</Text>}
        {!agentId && !!state?.mainAgents?.length && (
          <View style={{ gap: 4 }}>
            <Text style={{ color: colors.foregroundMuted }}>
              Mehrere Hauptchats: gewünschten Chat öffnen.
            </Text>
            {state.mainAgents.map((value) => (
              <CompactAction
                key={value.agentId}
                theme={props.theme}
                label={`Hauptchat ${value.agentId.slice(0, 8)}`}
                icon="ArrowUpRight"
                onPress={() => props.navigation?.openAgent({ agentId: value.agentId })}
              />
            ))}
          </View>
        )}
        {agentId && (
          <>
            <View style={{ gap: 8 }}>
              <Text
                accessibilityRole="header"
                style={{ color: colors.foreground, fontWeight: "600" }}
              >
                Subagents
              </Text>
              {typeof ActiveSubagents === "function" ? (
                <ActiveSubagents agentId={agentId} />
              ) : (
                <Text style={{ color: colors.statusWarning }}>
                  Subagents benötigen eine aktualisierte App.
                </Text>
              )}
            </View>
            <View style={{ gap: 8 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text
                  accessibilityRole="header"
                  style={{ flex: 1, color: colors.foreground, fontWeight: "600" }}
                >
                  Decision
                </Text>
                <CompactAction
                  theme={props.theme}
                  label="Details"
                  icon="ArrowUpRight"
                  onPress={() => setDetailsOpen(true)}
                />
              </View>
              <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{decisionStatus}</Text>
              {!!summary && !history.isError && !decision.isError && (
                <Text style={{ color: colors.foreground, fontSize: 13, lineHeight: 18 }}>
                  {summary}
                </Text>
              )}
            </View>
            <Modal title="Decision-Details" open={detailsOpen} onOpenChange={setDetailsOpen}>
              <Modal.Content>
                <DecisionsHistory {...props} agentId={agentId} />
              </Modal.Content>
            </Modal>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const agentPanelStyle = { flex: 1 };
export function AgentStatus(
  props: PluginAgentPanelProps & { openPreparation?: PluginClientContext["openScreen"] },
) {
  const { workspaceId, openPreparation } = props;
  const agentId = props.params.agentId;
  const projectId = useWorkspace(props.workspaceId, (workspace) => workspace.projectId);
  const agent = useAgent(props.params.agentId, (value) => ({
    cwd: value.cwd,
    provider: value.provider,
    prepared: !!value.labels.orchestratorPreparation,
  }));
  const prepareMain = useCallback(() => {
    if (projectId)
      openPreparation?.({
        screenId: "orchestrator-prepare",
        params: { projectId, workspaceId, agentId },
      });
  }, [projectId, openPreparation, workspaceId, agentId]);
  if (!agent) return <Loading />;
  return (
    <View style={agentPanelStyle}>
      {!agent.prepared && props.openPreparation && (
        <SettingsAction
          label="Den normalen Composer mit dieser Hauptsession verbinden"
          actionLabel="Hauptchat vorbereiten"
          onPress={prepareMain}
          disabled={!projectId}
        />
      )}
      <StatusBody
        {...props}
        directory={agent.cwd}
        agentId={props.params.agentId}
        controls={agent.provider.split("/")[0] === "codex"}
      />
    </View>
  );
}
export function WorkspaceStatus(props: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(props.workspaceId, (value) => ({ directory: value.directory }));
  return workspace ? <StatusBody {...props} directory={workspace.directory} /> : <Loading />;
}
export function StatusTimeline({ item, theme }: PluginTimelineItemProps<WorkflowStatus>) {
  return (
    <View style={{ gap: 8, paddingVertical: 12 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
        Orchestrator · Auto-Routing {automationLabel[item.data.automation]}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>
        {runnerLabel[item.data.runner]} · {new Date(item.data.at).toLocaleTimeString()}
      </Text>
      {item.data.tasks.map((task) => (
        <View key={task.key} style={{ gap: 4 }}>
          <Text style={{ color: theme.colors.foreground }}>
            {task.taskId} · {phaseLabel[task.state] ?? task.state}
          </Text>
          {task.route && (
            <Text style={{ color: theme.colors.foregroundMuted }}>
              {task.route.name} · {task.route.model} · {task.route.reasoning}
            </Text>
          )}
          {task.routing && (
            <Text style={{ color: theme.colors.foregroundMuted }}>
              {reasonLabel[task.routing.reason] ?? task.routing.reason}
              {task.routing.confidence === undefined
                ? ""
                : ` · Konfidenz ${Math.round(task.routing.confidence * 100)} %`}
            </Text>
          )}
          {task.errorKind && (
            <Text style={{ color: theme.colors.statusWarning }}>
              {reasonLabel[task.errorKind] ?? task.errorKind}
            </Text>
          )}
          <Text style={{ color: theme.colors.foregroundMuted }}>
            Checks:{" "}
            {task.checks
              ? task.checks.build === 0 &&
                task.checks.test === 0 &&
                task.checks.diff === 0 &&
                task.checks.scopeViolations === 0 &&
                !task.checks.changed
                ? "bestanden"
                : "Prüfung fehlgeschlagen"
              : "ausstehend"}{" "}
            · Review: {task.review?.state ?? "ausstehend"}
          </Text>
          {task.events.slice(0, 3).map((event) => (
            <Text key={event.sequence} style={{ color: theme.colors.foregroundMuted }}>
              {new Date(event.at).toLocaleTimeString()} · {phaseLabel[event.kind] ?? event.kind}
            </Text>
          ))}
        </View>
      ))}
      {!item.data.tasks.length && (
        <Text style={{ color: theme.colors.foregroundMuted }}>
          Bereit für den nächsten Arbeitsauftrag. Noch keine registrierten Aufgaben.
        </Text>
      )}
    </View>
  );
}
