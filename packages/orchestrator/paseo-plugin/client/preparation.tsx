import { ExistingPreparationForm } from "./existing-preparation";
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
import { useState } from "react";
import { Text, View } from "react-native";
import { prepareSession, type PreparationInput } from "../shared/preparation";

export function PrepareSession(props: PluginScreenProps) {
  if (props.params.agentId) {
    return <ExistingPreparationForm key={`${props.host.id}:${props.params.agentId}`} {...props} />;
  }
  return (
    <PreparationForm
      key={`${props.host.id}:${props.params.projectId ?? ""}:${props.params.workspaceId ?? ""}`}
      {...props}
    />
  );
}
function PreparationForm({ theme, layout, navigation, host, params }: PluginScreenProps) {
  const paseo = usePaseo();
  const prepare = useRpc(prepareSession);
  const [projectId, setProjectId] = useState(params.projectId ?? "");
  const [workspaceId, setWorkspaceId] = useState(params.workspaceId ?? "");
  const [modelId, setModelId] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [modeId, setModeId] = useState("");
  const [autoRouting, setAutoRouting] = useState(true);
  const [dataScope, setDataScope] = useState<PreparationInput["dataScope"]>("company");
  const [request, setRequest] = useState<PreparationInput>();
  const projects = useQuery({
    queryKey: ["orchestrator-projects", host.id],
    retry: false,
    queryFn: async () =>
      (await paseo.projects.list()).projects.filter((project) =>
        /^C:[\\/]IFI_SourceCode(?:[\\/]|$)/i.test(project.projectRootPath),
      ),
  });
  const project = projects.data?.find((value) => value.projectId === projectId);
  const workspaces = useQuery({
    queryKey: ["orchestrator-workspaces", host.id, projectId],
    enabled: !!project,
    retry: false,
    queryFn: async () => {
      const page = await paseo.workspaces.list({ filter: { projectId }, page: { limit: 100 } });
      const entries = [...page.entries];
      let cursor = page.pageInfo.nextCursor;
      while (cursor) {
        const next = await paseo.workspaces.list({
          filter: { projectId },
          page: { limit: 100, cursor },
        });
        entries.push(...next.entries);
        cursor = next.pageInfo.nextCursor;
      }
      return entries;
    },
  });
  const workspace = workspaces.data?.find((value) => value.id === workspaceId);
  const directory = workspaceId ? workspace?.workspaceDirectory : project?.projectRootPath;
  const catalog = useQuery({
    queryKey: ["orchestrator-main-catalog", host.id, directory],
    enabled: !!directory,
    retry: false,
    queryFn: () => paseo.providers.waitForReady({ cwd: directory! }),
  });
  const provider = catalog.data?.entries.find((value) => value.provider === "codex");
  const models = provider?.models?.filter((value) => value.isSelectable !== false) ?? [];
  const model =
    models.find((value) => value.id === modelId) ??
    models.find((value) => value.id === "gpt-6.1-sol") ??
    models[0];
  const efforts = model?.thinkingOptions ?? [];
  const effort =
    efforts.find((value) => value.id === reasoning) ??
    efforts.find((value) => value.id === "medium") ??
    efforts[0];
  const mutation = useMutation({
    mutationFn: (input: PreparationInput) => prepare(input),
    retry: false,
    onSuccess: (result) => navigation?.openAgent({ agentId: result.agentId, serverId: host.id }),
  });
  const frozen = !!request;
  const available = !!navigation && !!project && !!directory && !!model && !mutation.isPending;
  const start = () => {
    if (!available) return;
    const input = request ?? {
      requestId: `prepare-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      projectId,
      workspaceId: workspaceId || undefined,
      model: model.id,
      reasoning: effort?.id ?? "",
      modeId: modeId || undefined,
      autoRouting,
      dataScope,
    };
    setRequest(input);
    mutation.mutate(input);
  };
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 16 : 24 }}
    >
      <View style={{ width: "100%", maxWidth: 760, alignSelf: "center", gap: 16 }}>
        <SettingsSection
          title="Orchestrator-Session vorbereiten"
          info="Projekt und Workspace wählen und dort einen leeren Hauptchat mit Auto-Routing öffnen. Die Vorbereitung sendet keinen Prompt und startet keinen Modell-Turn."
        >
          <SettingsCard>
            <SettingsSelect
              label="Projekt"
              value={projectId}
              disabled={frozen || !projects.data}
              options={[
                { value: "", label: "Projekt auswählen" },
                ...(projects.data ?? []).map((value) => ({
                  value: value.projectId,
                  label: value.projectCustomName ?? value.projectDisplayName,
                })),
              ]}
              onValueChange={(value) => {
                setProjectId(value);
                setWorkspaceId("");
                setModelId("");
                setReasoning("");
                setModeId("");
              }}
            />
            <SettingsSelect
              label="Workspace"
              value={workspaceId}
              disabled={frozen || !workspaces.data}
              options={[
                { value: "", label: "Neuen Workspace in diesem Projekt anlegen" },
                ...(workspaces.data ?? []).map((value) => ({
                  value: value.id,
                  label: value.title ?? value.name,
                })),
              ]}
              onValueChange={(value) => {
                setWorkspaceId(value);
                setModelId("");
                setReasoning("");
                setModeId("");
              }}
            />
            {directory && <SettingsRow label="Verzeichnis" hint={directory} />}
            <SettingsSelect
              label="Hauptagent"
              hint="Sol Medium eignet sich als Ausgangspunkt. Die Worker-Routen bleiben in deinen Routing-Einstellungen."
              value={model?.id ?? ""}
              disabled={frozen || !models.length}
              options={models.map((value) => ({ value: value.id, label: value.label }))}
              onValueChange={(value) => {
                setModelId(value);
                setReasoning("");
              }}
            />
            <SettingsSelect
              label="Reasoning"
              value={effort?.id ?? ""}
              disabled={frozen || !efforts.length}
              options={
                efforts.length
                  ? efforts.map((value) => ({ value: value.id, label: value.label }))
                  : [{ value: "", label: "Vom Modell vorgegeben" }]
              }
              onValueChange={setReasoning}
            />
            <SettingsSelect
              label="Berechtigungsmodus"
              value={modeId}
              disabled={frozen || !provider}
              options={[
                { value: "", label: "Paseo-Standard" },
                ...(provider?.modes ?? []).map((value) => ({
                  value: value.id,
                  label: value.label,
                })),
              ]}
              onValueChange={setModeId}
            />
            <SettingsSwitch
              label="Auto-Routing vorbereiten"
              value={autoRouting}
              disabled={frozen}
              hint="Gilt nur für den neuen Hauptchat. Die Automatik wartet auf deinen Arbeitsauftrag. Berechtigungen und Abschlussprüfungen bleiben wirksam."
              onValueChange={setAutoRouting}
            />
            <SettingsSelect
              label="Datenschutzklasse"
              value={dataScope}
              disabled={frozen}
              options={[
                { value: "company", label: "Firmenprojekt" },
                { value: "personal", label: "Privat" },
                { value: "public", label: "Ausschließlich öffentliche Testdaten" },
                { value: "restricted", label: "Eingeschränkt" },
              ]}
              onValueChange={(value) => setDataScope(value as PreparationInput["dataScope"])}
            />
          </SettingsCard>
          {(projects.isPending ||
            (project && (workspaces.isPending || (directory && catalog.isPending)))) && <Loading />}
          {(projects.isError || workspaces.isError || catalog.isError) && (
            <SettingsAction
              label="Projekt-, Workspace- oder Modellkatalog konnte nicht geladen werden."
              actionLabel="Erneut laden"
              onPress={() => {
                void projects.refetch();
                if (project) void workspaces.refetch();
                if (directory) void catalog.refetch();
              }}
            />
          )}
          {projects.data?.length === 0 && (
            <Text style={{ color: theme.colors.foregroundMuted }}>
              Auf diesem Host ist noch kein Projekt unter C:\IFI_SourceCode registriert. Füge es
              zuerst in Paseo hinzu.
            </Text>
          )}
          {!navigation && (
            <Text style={{ color: theme.colors.statusWarning }}>
              Diese Paseo-Oberfläche unterstützt das Öffnen des Chats noch nicht. Es wurde keine
              Session erstellt.
            </Text>
          )}
          {mutation.isError && (
            <Text style={{ color: theme.colors.statusDanger }}>
              Vorbereitung noch nicht bestätigt. Erneut versuchen verwendet dieselbe Session und
              sendet weiterhin keinen Prompt. Bei noch laufender Initialisierung kurz warten.
            </Text>
          )}
          {mutation.data ? (
            <SettingsAction
              label={
                mutation.data.automation === "ready"
                  ? "Hauptchat bereit · Auto-Routing ein"
                  : "Hauptchat angelegt"
              }
              actionLabel="Chat öffnen"
              onPress={() =>
                navigation?.openAgent({ agentId: mutation.data!.agentId, serverId: host.id })
              }
            />
          ) : (
            <SettingsAction
              label={
                mutation.isPending
                  ? "Session wird vorbereitet …"
                  : "Bereit für deinen ersten Arbeitsauftrag"
              }
              actionLabel={
                mutation.isPending
                  ? "Wird vorbereitet …"
                  : mutation.isError
                    ? "Vorbereitung erneut prüfen"
                    : "Session vorbereiten"
              }
              disabled={!available}
              onPress={start}
            />
          )}
        </SettingsSection>
      </View>
    </ScrollView>
  );
}
