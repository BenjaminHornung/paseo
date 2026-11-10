import {
  useAgent,
  useWorkspace,
  useRpc,
  type PluginAgentPanelProps,
  type PluginWorkspacePanelProps,
  type PluginSurfaceProps,
  type PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import {
  Icon,
  Loading,
  ScrollView,
  SettingsAction,
  SettingsRow,
  SettingsSwitch,
  SettingsInput,
} from "@getpaseo/plugin/client/ui";
import { useState, type ReactNode } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import {
  loadStatus,
  autoRouting,
  submitInput,
  abandonInput,
  phaseLabel,
  reasonLabel,
  type WorkflowStatus,
} from "../shared/status";
import {
  checksPassed,
  currentTask,
  needsAttention,
  taskLabel,
  taskPhases,
  workerNeedsReconciliation,
} from "../shared/status-view";
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
const workerLabel = {
  idle: "ruht",
  running: "arbeitet",
  initializing: "startet",
  error: "Fehler",
  closed: "geschlossen",
};
const inputId = () => `input-${Date.now()}-${Math.random().toString(36).slice(2)}`;
function errorLabel(error: unknown) {
  const value =
    typeof error === "object" && error && "safeCode" in error
      ? String(error.safeCode)
      : error instanceof Error
        ? error.message
        : "";
  if (value.includes("MAIN_MUST_BE_IDLE"))
    return "Beende zuerst den laufenden Turn. Auto-Routing wird nur in einer ruhenden Hauptsession eingeschaltet.";
  if (value.includes("ACTIVATION_UNCERTAIN"))
    return "Aktivierung unklar. Prüfe den Chat vor einem erneuten Einschalten; die Einrichtung wird nicht automatisch wiederholt.";
  if (value.includes("INITIALIZATION_FAILED"))
    return "Session noch nicht bereit. Es wurde kein Einrichtungsauftrag gesendet; nach dem Start erneut einschalten.";
  if (value.includes("MAIN_REQUIRED"))
    return "Auto-Routing benötigt eine Codex-Hauptsession, keinen Worker.";
  return "Status oder Aktion fehlgeschlagen. Angezeigte Daten können veraltet sein; erneut laden.";
}
function Disclosure({
  title,
  open,
  onPress,
  children,
  theme,
}: {
  title: string;
  open: boolean;
  onPress(): void;
  children: ReactNode;
  theme: PluginSurfaceProps["theme"];
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={onPress}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          paddingVertical: 7,
          paddingHorizontal: 4,
          flexDirection: "row",
          gap: 6,
          alignItems: "center",
          borderWidth: 1,
          borderRadius: 6,
          borderColor: focused ? theme.colors.accent : "transparent",
        }}
      >
        <Icon
          name={open ? "ChevronDown" : "ChevronRight"}
          size={14}
          color={theme.colors.foregroundMuted}
        />
        <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 13, flex: 1 }}>
          {title}
        </Text>
      </Pressable>
      {open && <View style={{ gap: 8, paddingBottom: 12 }}>{children}</View>}
    </View>
  );
}

function StatusBody(
  props: PluginSurfaceProps & {
    directory: string;
    agentId?: string;
    controls?: boolean;
    tab?: PluginAgentPanelProps["tab"];
  },
) {
  const load = useRpc(loadStatus),
    toggle = useRpc(autoRouting);
  const submit = useRpc(submitInput),
    [text, setText] = useState(""),
    [messageId, setMessageId] = useState(inputId);
  const abandon = useRpc(abandonInput);
  const abandonMutation = useMutation({
    mutationFn: () => abandon({ agentId: resolvedAgentId!, messageId }),
    onSuccess: () => {
      inputMutation.reset();
      setMessageId(inputId());
      void query.refetch();
    },
  });
  const inputMutation = useMutation({
    mutationFn: () => submit({ agentId: resolvedAgentId!, messageId, text }),
    onSuccess: () => {
      setText("");
      setMessageId(inputId());
      void query.refetch();
    },
  });
  const query = useQuery({
    queryKey: ["orchestrator-status", props.directory, props.agentId],
    queryFn: () => load({ directory: props.directory, agentId: props.agentId }),
    refetchInterval: 5000,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => toggle({ agentId: resolvedAgentId!, enabled }),
    onSuccess: () => {
      void query.refetch();
    },
  });
  const state = query.data;
  const resolvedAgentId = props.agentId ?? state?.mainAgentId;
  const main = useAgent(resolvedAgentId ?? "", (value) => ({
    provider: value.provider,
    title: value.title,
  }));
  const controls =
    !!resolvedAgentId && (props.controls || main?.provider.split("/")[0] === "codex");
  const [selected, setSelected] = useState<string>();
  const [folds, setFolds] = useState<Record<string, boolean>>(() => {
    const saved = props.tab?.state;
    return saved &&
      typeof saved === "object" &&
      "folds" in saved &&
      saved.folds &&
      typeof saved.folds === "object"
      ? Object.fromEntries(
          Object.entries(saved.folds).filter(
            (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
          ),
        )
      : {};
  });
  const colors = props.theme.colors;
  const task =
    state?.tasks.find((value) => value.key === selected) ?? currentTask(state?.tasks ?? []);
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
  const done = state?.tasks.filter((value) => value.state === "COMPLETE").length ?? 0;
  const phases = task ? taskPhases(task) : [];
  const attention =
    task &&
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
  const liveTitle =
    task?.state === "COMPLETE"
      ? title
      : worker?.status === "error"
        ? "Worker-Fehler"
        : reconcile
          ? "Worker ruht · Abgleich ausstehend"
          : title;
  const activityMinutes = worker
    ? Math.floor((Date.now() - Date.parse(worker.lastActivityAt)) / 60000)
    : NaN;
  const fold = (id: string, label: string, content: ReactNode, defaultOpen = false) => {
    const open = folds[id] ?? defaultOpen;
    return (
      <Disclosure
        title={label}
        open={open}
        theme={props.theme}
        onPress={() => {
          const next = { ...folds, [id]: !open };
          setFolds(next);
          props.tab?.setState({ folds: next });
        }}
      >
        {content}
      </Disclosure>
    );
  };
  const line = (value: string, muted = false) => (
    <Text
      style={{
        color: muted ? colors.foregroundMuted : colors.foreground,
        fontSize: 13,
        lineHeight: 18,
      }}
    >
      {value}
    </Text>
  );
  const detail = (label: string, value: ReactNode) => (
    <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
      <Text style={{ width: 62, paddingTop: 2, color: colors.foregroundMuted, fontSize: 12 }}>
        {label}
      </Text>
      <View style={{ flex: 1, minWidth: 0 }}>
        {typeof value === "string" ? line(value) : value}
      </View>
    </View>
  );
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <View style={{ padding: 12, gap: 4, borderBottomWidth: 1, borderColor: colors.border }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Icon
            name={
              attention ? "TriangleAlert" : task?.state === "COMPLETE" ? "CircleCheck" : "Workflow"
            }
            size={16}
            color={attention ? colors.statusWarning : colors.foregroundMuted}
          />
          <Text
            accessibilityRole="header"
            style={{
              flex: 1,
              color: attention ? colors.statusWarning : colors.foreground,
              fontWeight: "600",
              fontSize: 15,
            }}
          >
            {liveTitle}
          </Text>
          <CompactAction
            theme={props.theme}
            label="Status aktualisieren"
            icon="RefreshCw"
            iconOnly
            disabled={query.isFetching}
            onPress={() => {
              void query.refetch();
            }}
          />
        </View>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
          {worker
            ? `Worker ${workerLabel[worker.status]}${Number.isFinite(activityMinutes) ? ` · Aktivität vor ${Math.max(0, activityMinutes)} min` : ""} · `
            : ""}
          {state ? `Stand ${new Date(state.at).toLocaleTimeString()}` : "Verbindung wird geprüft"}
        </Text>
        {controls && state && (
          <SettingsSwitch
            label="Auto-Routing"
            value={state.automation !== "off"}
            disabled={mutation.isPending}
            onValueChange={(value) => mutation.mutate(value)}
          />
        )}
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} style={{ flex: 1 }}>
        {!state && query.isPending && <Loading />}
        {mutation.isError && (
          <Text style={{ color: colors.statusDanger }}>{errorLabel(mutation.error)}</Text>
        )}
        {query.isError && (
          <Text style={{ color: colors.statusWarning }}>
            {state
              ? "Stand veraltet. Aktualisieren, um die Verbindung erneut zu prüfen."
              : errorLabel(query.error)}
          </Text>
        )}
        {state?.timelineAvailable === false && (
          <Text style={{ color: colors.statusWarning }}>
            Chat-Status nicht verfügbar; angezeigt ist der gespeicherte Stand.
          </Text>
        )}
        {state?.runner === "failed" && (
          <Text style={{ color: colors.statusDanger }}>
            Controller-Start fehlgeschlagen. Technische Details unten prüfen.
          </Text>
        )}
        {state?.automation === "uncertain" && (
          <Text style={{ color: colors.statusWarning }}>
            Aktivierung unklar. Hauptchat vor erneutem Einschalten prüfen.
          </Text>
        )}
        {state?.dispatchPaused &&
          line("Neue Starts sind global pausiert. Laufende Arbeit bleibt überwacht.")}
        {state?.writeAuthorization?.allowed === false &&
          line(
            `Neue Schreibstarts gesperrt: ${reasonLabel[state.writeAuthorization.reason] ?? state.writeAuthorization.reason}`,
          )}
        {!resolvedAgentId && !!state?.mainAgents?.length && (
          <View style={{ gap: 4 }}>
            {line("Mehrere Hauptchats: gewünschten Chat öffnen.", true)}
            {state.mainAgents.map((value) => (
              <CompactAction
                key={value.agentId}
                theme={props.theme}
                label={`Hauptchat ${value.agentId.slice(0, 8)} · ${automationLabel[value.state as keyof typeof automationLabel] ?? value.state}`}
                icon="ArrowUpRight"
                onPress={() => props.navigation?.openAgent({ agentId: value.agentId })}
              />
            ))}
          </View>
        )}
        {attention && (
          <View
            style={{
              padding: 10,
              gap: 6,
              borderWidth: 1,
              borderColor: colors.statusWarning,
              borderRadius: 8,
            }}
          >
            {line(
              reconcile
                ? "Der gespeicherte Controllerzustand und der ruhende Worker müssen abgeglichen werden. Dies ist kein bestätigter Abschluss."
                : task.errorKind
                  ? (reasonLabel[task.errorKind] ?? task.errorKind)
                  : taskLabel(task, phaseLabel),
            )}
            {workerId && (
              <CompactAction
                theme={props.theme}
                label="Im Worker prüfen"
                icon="ArrowUpRight"
                onPress={() => props.navigation?.openAgent({ agentId: workerId })}
              />
            )}
          </View>
        )}
        {!!state?.tasks.length &&
          (state.historyLimited
            ? line(`${done} verifiziert · begrenzte Historie`, true)
            : state.tasks.length > 1 && (
                <View style={{ gap: 6 }}>
                  {line(`${done} von ${state.tasks.length} Aufgaben verifiziert`, true)}
                  <View
                    accessibilityRole="progressbar"
                    accessibilityLabel="Verifizierte Aufgaben"
                    accessibilityValue={{ min: 0, max: state.tasks.length, now: done }}
                    style={{
                      height: 4,
                      backgroundColor: colors.border,
                      borderRadius: 2,
                      overflow: "hidden",
                    }}
                  >
                    <View
                      style={{
                        width: `${(done / state.tasks.length) * 100}%`,
                        height: 4,
                        backgroundColor: colors.statusSuccess,
                      }}
                    />
                  </View>
                </View>
              ))}
        {task && (
          <View style={{ gap: 10 }}>
            <Text
              accessibilityRole="header"
              style={{ color: colors.foreground, fontWeight: "600", fontSize: 14, lineHeight: 20 }}
            >
              {task.objective ?? task.taskId.replaceAll("-", " ")}
            </Text>
            {line(`${task.taskId} · ${task.classification?.complexity ?? task.role}`, true)}
            <View style={{ flexDirection: "row", gap: 6 }}>
              {["Umsetzung", "Checks", "Review"].map((label, index) => (
                <View key={label} style={{ flex: 1, gap: 5 }}>
                  <View
                    style={{
                      height: 3,
                      borderRadius: 2,
                      backgroundColor:
                        phases[index] === "done"
                          ? colors.statusSuccess
                          : phases[index] === "active"
                            ? colors.accent
                            : colors.border,
                    }}
                  />
                  <View style={{ flexDirection: "row", gap: 3, alignItems: "center" }}>
                    {phases[index] === "done" && (
                      <Icon name="Check" size={12} color={colors.statusSuccess} />
                    )}
                    <Text
                      style={{
                        color:
                          phases[index] === "active" ? colors.foreground : colors.foregroundMuted,
                        fontWeight: phases[index] === "active" ? "600" : "400",
                        fontSize: 12,
                      }}
                    >
                      {label}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
            {detail(
              "Hauptchat",
              main?.title ?? resolvedAgentId?.slice(0, 8) ?? "Workspace-Übersicht",
            )}
            {detail(
              task.attemptState === "VERIFY" && task.review?.agentId ? "Reviewer" : "Worker",
              workerId ? (
                <CompactAction
                  theme={props.theme}
                  label={worker?.title ?? "Worker öffnen"}
                  icon="ArrowUpRight"
                  onPress={() => props.navigation?.openAgent({ agentId: workerId })}
                />
              ) : (
                "Noch nicht gestartet"
              ),
            )}
            {detail(
              "Modell",
              task.route
                ? `${task.route.model} · ${task.route.reasoning || "ohne Effort"}`
                : "Wird beim Start gewählt",
            )}
            {task.routing &&
              detail(
                "Warum",
                task.routing.reason === "quality-data-budget-then-priority"
                  ? "Erste passende Route deiner Reihenfolge"
                  : (reasonLabel[task.routing.reason] ?? task.routing.reason),
              )}
            {detail(
              "Build",
              task.checks
                ? task.checks.build === 0
                  ? "Bestanden"
                  : `Fehler (${task.checks.build})`
                : "Ausstehend · nach Prozessruhe",
            )}
            {detail(
              "Tests",
              task.checks
                ? task.checks.test === 0
                  ? "Bestanden"
                  : `Fehler (${task.checks.test})`
                : "Ausstehend",
            )}
            {detail(
              "Git-Diff",
              task.checks
                ? task.checks.diff === 0 && !task.checks.scopeViolations && !task.checks.changed
                  ? "Bestanden"
                  : "Prüfung fehlgeschlagen"
                : "Ausstehend",
            )}
            {detail(
              "Review",
              task.review
                ? `${phaseLabel[task.review.state] ?? task.review.state} · ${task.review.model}`
                : "Ausstehend · nach den Checks",
            )}
            {task.events[0] &&
              line(
                `${new Date(task.events[0].at).toLocaleTimeString()} · ${phaseLabel[task.events[0].kind] ?? task.events[0].kind}`,
                true,
              )}
            {fold(
              `checks:${task.key}`,
              "Prüfdetails",
              <>
                {task.checks ? (
                  <>
                    {(["Build", "Tests", "Git-Diff"] as const).map((label, index) => (
                      <SettingsRow
                        key={label}
                        label={label}
                        hint={
                          [task.checks!.build, task.checks!.test, task.checks!.diff][index] === 0
                            ? "Bestanden"
                            : `Fehlercode ${[task.checks!.build, task.checks!.test, task.checks!.diff][index]}`
                        }
                      />
                    ))}
                    {line(
                      `Scope-Verletzungen: ${task.checks.scopeViolations}${task.checks.changed ? " · Stand während der Prüfung geändert" : ""}`,
                    )}
                  </>
                ) : (
                  line("Build, Tests und Diff beginnen erst nach bestätigter Prozessruhe.")
                )}
                {line(
                  task.review
                    ? `Review: ${phaseLabel[task.review.state] ?? task.review.state} · ${task.review.model} · ${task.review.reasoning}`
                    : "Unabhängiges Review ausstehend.",
                )}
              </>,
              !!task.checks && !checksPassed(task),
            )}
            {fold(
              `routing:${task.key}`,
              "Decisions & Routenwahl",
              <>
                {task.classification &&
                  line(
                    `Aufgabenklasse: ${task.classification.complexity} · ${task.classification.source}\n${task.classification.reason}`,
                  )}
                {task.classification &&
                  line(
                    `Zusatzbedarf: ${[task.classification.additionalPlanning && "Planung", task.classification.advisorNeeded && "Advisor", task.classification.shouldSplit && "Aufteilung", task.classification.extraReviewRecommended && "zusätzliches Review"].filter(Boolean).join(", ") || "keiner"}`,
                    true,
                  )}
                {line(
                  "Decisions bewertet den Workflowbedarf. Das Modell folgt deiner gespeicherten Priorität.",
                  true,
                )}
                {task.routing && line(reasonLabel[task.routing.reason] ?? task.routing.reason)}
                {task.routing?.skipped?.map((route) => (
                  <SettingsRow
                    key={route.routeId}
                    label={route.routeId}
                    hint={reasonLabel[route.reason] ?? route.reason}
                  />
                ))}
              </>,
            )}
            {fold(
              `history:${task.key}`,
              "Letzte Ereignisse",
              task.events.length
                ? task.events.map((event) => (
                    <SettingsRow
                      key={event.sequence}
                      label={new Date(event.at).toLocaleTimeString()}
                      hint={phaseLabel[event.kind] ?? event.kind}
                    />
                  ))
                : line("Noch keine gespeicherten Ereignisse.", true),
            )}
          </View>
        )}
        {state?.tasks.length === 0 &&
          line(
            resolvedAgentId
              ? "Auto-Routing einschalten und deinen Auftrag über „Auftrag / Nachricht“ absenden. Der Hauptagent registriert die Arbeitspakete."
              : "Öffne die Codex-Hauptsession dieses Workspace und dort die Orchestrator-Sidebar.",
          )}
        {state &&
          state.tasks.length > 1 &&
          fold(
            "tasks",
            `Weitere Aufgaben · ${state.tasks.length - 1}`,
            <>
              {state.tasks
                .filter((value) => value.key !== task?.key)
                .map((value) => (
                  <SettingsAction
                    key={value.key}
                    label={value.taskId}
                    hint={taskLabel(value, phaseLabel)}
                    actionLabel="Anzeigen"
                    onPress={() => setSelected(value.key)}
                  />
                ))}
            </>,
          )}
        {resolvedAgentId &&
          fold(
            "decisions-history",
            "Decisions: Input & Ergebnis",
            <DecisionsHistory {...props} agentId={resolvedAgentId} />,
          )}
        {controls &&
          state?.automation === "ready" &&
          state.orchestrationVersion === 3 &&
          fold(
            "input",
            "Auftrag / Nachricht",
            <>
              {line(
                "Dieser Eingang bestätigt deine Nachricht für die automatische Verarbeitung.",
                true,
              )}
              <SettingsInput
                key={messageId}
                label="Nachricht"
                initialValue={text}
                onChangeText={setText}
              />
              <SettingsAction
                label="An diesen Hauptchat senden"
                actionLabel="Absenden"
                disabled={!text.trim() || inputMutation.isPending}
                onPress={() => inputMutation.mutate()}
              />
              {inputMutation.isError && (
                <>
                  <Text style={{ color: colors.statusWarning }}>
                    Übermittlung unklar. Chat prüfen; erneutes Absenden sendet nicht blind doppelt.
                  </Text>
                  <SettingsAction
                    label="Unklaren Sendeversuch verwerfen"
                    hint="Sperrt diesen Eingang auch bei verspäteter Zustellung. Danach bewusst neu absenden. Laufende Writer bleiben geschützt."
                    actionLabel="Verwerfen"
                    disabled={abandonMutation.isPending}
                    onPress={() => abandonMutation.mutate()}
                  />
                </>
              )}
            </>,
            !state.tasks.length || state.writeAuthorization?.allowed === false,
          )}
        {state &&
          fold(
            "technical",
            "Technische Details",
            <>
              {line(
                `${runnerLabel[state.runner]} · Auto-Routing ${automationLabel[state.automation]}`,
              )}
              {state.repositoryScope && line(`Workspace: ${state.repositoryScope.directory}`, true)}
              {state.intake &&
                line(
                  `Intake: ${state.intake.intent} · ${state.intake.source} · ${state.intake.origin}\n${state.intake.reason}`,
                  true,
                )}
              {state.writeAuthorization &&
                line(
                  `Neue Schreibstarts: ${state.writeAuthorization.allowed ? "freigegeben" : "gesperrt"}\n${reasonLabel[state.writeAuthorization.reason] ?? state.writeAuthorization.reason}`,
                  true,
                )}
            </>,
            state.runner === "failed",
          )}
      </ScrollView>
    </View>
  );
}
export function AgentStatus(props: PluginAgentPanelProps) {
  const agent = useAgent(props.params.agentId, (value) => ({
    cwd: value.cwd,
    provider: value.provider,
  }));
  return agent ? (
    <StatusBody
      {...props}
      directory={agent.cwd}
      agentId={props.params.agentId}
      controls={agent.provider.split("/")[0] === "codex"}
    />
  ) : (
    <Loading />
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
