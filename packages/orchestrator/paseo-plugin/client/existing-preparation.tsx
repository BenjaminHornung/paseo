import { usePaseo, useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import {
  Loading,
  ScrollView,
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import {
  existingMainSelection,
  prepareSession,
  type PreparationInput,
} from "../shared/preparation";

const scopes = [
  { value: "company", label: "Firmenprojekt" },
  { value: "personal", label: "Privat" },
  { value: "public", label: "Ausschließlich öffentliche Testdaten" },
  { value: "restricted", label: "Eingeschränkt" },
];

export function ExistingPreparationForm({
  theme,
  layout,
  navigation,
  host,
  params,
}: PluginScreenProps) {
  const paseo = usePaseo();
  const { surface0, foregroundMuted, statusDanger } = theme.colors;
  const compact = layout.compact;
  const styles = useMemo(
    () => ({
      scroll: { flex: 1, backgroundColor: surface0 },
      content: { padding: compact ? 16 : 24 },
      container: { width: "100%" as const, maxWidth: 760, alignSelf: "center" as const, gap: 16 },
      muted: { color: foregroundMuted },
      error: { color: statusDanger },
    }),
    [surface0, foregroundMuted, statusDanger, compact],
  );
  const prepare = useRpc(prepareSession);
  const [dataScope, setDataScope] = useState<PreparationInput["dataScope"]>("company");
  const [autoRouting, setAutoRouting] = useState(true);
  const [request, setRequest] = useState<PreparationInput>();
  const target = useQuery({
    queryKey: ["orchestrator-preparation-target", host.id, params.agentId],
    retry: false,
    refetchInterval: 2000,
    queryFn: async () => (await paseo.agents.ref(params.agentId).refresh())?.agent,
  });
  const mutation = useMutation({
    mutationFn: (input: PreparationInput) => prepare(input),
    retry: false,
    onSuccess: (result) => navigation?.openAgent({ agentId: result.agentId, serverId: host.id }),
  });
  const start = useCallback(() => {
    const agent = target.data;
    if (!agent || agent.status !== "idle" || agent.activeTurn || agent.pendingPermissions.length)
      return;
    const input = request ?? {
      requestId: `prepare-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      agentId: params.agentId,
      projectId: params.projectId,
      workspaceId: params.workspaceId,
      ...existingMainSelection(agent),
      autoRouting,
      dataScope,
    };
    setRequest(input);
    mutation.mutate(input);
  }, [
    target.data,
    request,
    params.agentId,
    params.projectId,
    params.workspaceId,
    autoRouting,
    dataScope,
    mutation,
  ]);
  const changeScope = useCallback(
    (value: string) => setDataScope(value as PreparationInput["dataScope"]),
    [],
  );
  const refresh = useCallback(() => {
    void target.refetch();
  }, [target]);
  if (target.isPending) return <Loading />;
  if (!target.data || target.isError)
    return (
      <SettingsAction
        label="Hauptchat konnte nicht gelesen werden"
        actionLabel="Erneut laden"
        onPress={refresh}
      />
    );
  const agent = target.data;
  const selection = existingMainSelection(agent);
  const idle =
    agent.status === "idle" && !agent.activeTurn && agent.pendingPermissions.length === 0;
  const available =
    !!navigation && !!params.projectId && !!params.workspaceId && idle && !mutation.isPending;
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <View style={styles.container}>
        <SettingsSection
          title="Bestehenden Hauptchat vorbereiten"
          info="Identität, Verlauf und Modellauswahl bleiben erhalten. Die Aktion wartet auf einen ruhenden Chat. Auto-Routing stellt anschließend seine Orchestrator-Anweisungen zu; Sandbox und Berechtigungsmodus bleiben unverändert."
        >
          <SettingsCard>
            <SettingsRow label="Hauptchat" hint={agent.title ?? agent.id} />
            <SettingsRow label="Verzeichnis" hint={agent.cwd} />
            <SettingsRow label="Modell" hint={selection.model} />
            <SettingsRow label="Reasoning" hint={selection.reasoning || "Vom Modell vorgegeben"} />
            <SettingsSelect
              label="Datenschutzklasse"
              value={dataScope}
              options={scopes}
              onValueChange={changeScope}
              disabled={!!request}
            />
            <SettingsSwitch
              label="Auto-Routing vorbereiten"
              value={autoRouting}
              onValueChange={setAutoRouting}
              disabled={!!request}
            />
          </SettingsCard>
          {!idle && (
            <Text style={styles.muted}>Die Vorbereitung wartet, bis dieser Hauptchat ruht.</Text>
          )}
          {mutation.isError && (
            <Text style={styles.error}>
              Vorbereitung nicht bestätigt. Derselbe Versuch bleibt an diesen Chat gebunden; es wird
              kein Ersatzchat angelegt.
            </Text>
          )}
          <SettingsAction
            label="Diesen Hauptchat mit dem normalen Composer verbinden"
            actionLabel="Hauptchat vorbereiten"
            onPress={start}
            disabled={!available}
          />
        </SettingsSection>
      </View>
    </ScrollView>
  );
}
