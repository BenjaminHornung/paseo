import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import {
  Loading,
  ScrollView,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  type SettingsInputHandle,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import {
  loadSettings,
  saveSettings,
  saveCredential,
  pauseDispatch,
  testDecisions,
  roles,
  type ControllerConfig,
  type DecisionSettings,
  type Role,
  type Route,
  type SettingsView,
} from "../shared/settings";
import { createProfileRoute, reasoningOptions, routeLabel } from "../shared/routes";

type Tab = "routes" | "decisions" | "keys";
const defaults: DecisionSettings = {
  enabled: false,
  model: "gpt-6-luna",
  roles: [],
  dataScopes: ["public", "personal"],
  minConfidence: 0.75,
  timeoutMs: 10000,
  monthlyBudgetMicroUsd: 5000000,
  maxCallMicroUsd: 50000,
  fundsConfirmed: false,
  validUntil: "",
  projectId: "",
};
const tabs: { value: Tab; label: string }[] = [
  { value: "routes", label: "Rollen & Modelle" },
  { value: "decisions", label: "Decisions" },
  { value: "keys", label: "Keys & Budgets" },
];
const roleLabels: Record<Role, string> = {
  planner: "Planung",
  advisor: "Beratung",
  "implement-simple": "Kleine Implementierung",
  "implement-normal": "Normale Implementierung",
  "implement-complex": "Komplexe Implementierung",
  reviewer: "Unabhängiges Review",
};
const scopeLabels: Record<string, string> = {
  public: "Öffentlich",
  personal: "Privat",
  company: "Firma",
  restricted: "Eingeschränkt",
};
const efforts = reasoningOptions;
const usd = (value: number) => String(value / 1000000);
const safeError = (error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("SETTINGS_CONFLICT"))
    return "In einem anderen Fenster geändert. Dein Entwurf bleibt erhalten; vor dem Überschreiben neu laden.";
  if (message.includes("PI_CREDENTIALS_BUSY"))
    return "Pi aktualisiert gerade seine Zugangsdaten. Bitte gleich erneut versuchen.";
  if (message.includes("DECISIONS_KEY_MISSING"))
    return "Zuerst unter Keys & Budgets den separaten Decisions-Key speichern.";
  const code =
    typeof error === "object" && error !== null && "safeCode" in error
      ? String(error.safeCode)
      : /^[A-Z0-9_]{1,70}$/.test(message)
        ? message
        : "UNKNOWN";
  return `Aktion fehlgeschlagen (${/^[A-Z0-9_-]{1,50}$/.test(code) ? code : "UNKNOWN"}). Bitte erneut versuchen oder Einstellungen neu laden.`;
};

export function OrchestratorSettings({
  theme,
  layout,
  initialTab,
}: PluginSurfaceProps & { initialTab: Tab }) {
  const paseo = usePaseo();
  const load = useRpc(loadSettings),
    save = useRpc(saveSettings),
    credential = useRpc(saveCredential),
    pause = useRpc(pauseDispatch),
    test = useRpc(testDecisions);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [view, setView] = useState<SettingsView>();
  const [draft, setDraft] = useState<ControllerConfig>();
  const draftRef = useRef<ControllerConfig | undefined>(undefined);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [role, setRole] = useState<Role>("planner");
  const [routeId, setRouteId] = useState("");
  const [newProfileId, setNewProfileId] = useState("");
  const [generation, setGeneration] = useState(0);
  const normalRef = useRef<SettingsInputHandle>(null),
    decisionsRef = useRef<SettingsInputHandle>(null);
  const [normalReady, setNormalReady] = useState(false),
    [decisionsReady, setDecisionsReady] = useState(false);
  useEffect(() => {
    setNormalReady(false);
    setDecisionsReady(false);
    normalRef.current?.replaceText("");
    decisionsRef.current?.replaceText("");
  }, [tab]);
  const settings = useQuery({
    queryKey: ["orchestrator-settings"],
    queryFn: () => load({}),
    retry: false,
  });
  const catalog = useQuery({
    queryKey: ["orchestrator-catalog", view?.controllerRoot],
    enabled: !!view?.controllerRoot,
    queryFn: async () => {
      const [providers, config] = await Promise.all([
        paseo.providers.waitForReady({ cwd: view!.controllerRoot }),
        paseo.config.get(),
      ]);
      return { providers: providers.entries, profiles: config.config.agentProfiles ?? [] };
    },
    retry: false,
  });
  const accept = useCallback(
    (result: unknown, replaceDraft: boolean) => {
      const next = result as SettingsView;
      const replace = replaceDraft || !dirty;
      setView((previous) =>
        !replace && previous ? { ...next, revision: previous.revision } : next,
      );
      if (replace) {
        draftRef.current = next.config;
        setDraft(next.config);
        setDirty(false);
        setGeneration((v) => v + 1);
      }
      setError("");
    },
    [dirty],
  );
  useEffect(() => {
    if (settings.data && !view) accept(settings.data, true);
  }, [settings.data, view, accept]);
  const saveMutation = useMutation({
    mutationFn: (config: ControllerConfig) =>
      save({ revision: view!.revision, config: config as unknown as Record<string, unknown> }),
    onSuccess: (value, sent) => {
      if (draftRef.current === sent) accept(value, true);
      else {
        setView(value as unknown as SettingsView);
        setError("Weitere Änderungen sind noch nicht gespeichert.");
      }
    },
    onError: (e) => setError(safeError(e)),
  });
  const credentialMutation = useMutation({
    mutationFn: (slot: "normal" | "decisions") =>
      credential({
        slot,
        key:
          slot === "normal"
            ? (normalRef.current?.getText() ?? "")
            : (decisionsRef.current?.getText() ?? ""),
        revision: view!.credentials[slot].revision,
      }),
    onSuccess: (value, slot) => {
      if (slot === "normal") {
        setNormalReady(false);
        normalRef.current?.replaceText("");
      } else {
        setDecisionsReady(false);
        decisionsRef.current?.replaceText("");
      }
      accept(value, false);
    },
    onError: (e) => setError(safeError(e)),
  });
  const pauseMutation = useMutation({
    mutationFn: (paused: boolean) => pause({ paused }),
    onSuccess: (value) => accept(value, false),
    onError: (e) => setError(safeError(e)),
  });
  const testMutation = useMutation({
    mutationFn: () => test({ nonce: `${Date.now()}_${Math.random().toString(36).slice(2)}` }),
    onError: (e) => setError(safeError(e)),
  });
  const reloadMutation = useMutation({
    mutationFn: () => load({}),
    onSuccess: (value) => accept(value, true),
    onError: (e) => setError(safeError(e)),
  });
  const busy =
    saveMutation.isPending ||
    credentialMutation.isPending ||
    pauseMutation.isPending ||
    reloadMutation.isPending ||
    testMutation.isPending;
  const change = (fn: (current: ControllerConfig) => ControllerConfig) => {
    if (draftRef.current) {
      const next = fn(draftRef.current);
      draftRef.current = next;
      setDraft(next);
    }
    setDirty(true);
    setError("");
  };
  if (!view || !draft)
    return settings.isError ? (
      <SettingsSection title="Orchestrator">
        <SettingsAction
          label={safeError(settings.error)}
          actionLabel="Erneut laden"
          onPress={() => void settings.refetch()}
        />
      </SettingsSection>
    ) : (
      <Loading />
    );
  const decision = draft.decisions ?? defaults;
  const funding = draft.apiFunding ?? {
    confirmed: false,
    cycle: new Date().toISOString().slice(0, 7),
    availableMicroUsd: 0,
    validUntil: "",
  };
  const updateFunding = (patch: Partial<typeof funding>) =>
    change((config) => ({ ...config, apiFunding: { ...funding, ...patch } }));
  const updateDecision = (patch: Partial<DecisionSettings>) =>
    change((c) => ({ ...c, decisions: { ...(c.decisions ?? defaults), ...patch } }));
  const route = draft.routes.find((r) => r.id === routeId) ?? draft.routes[0];
  const circuit =
    view.circuits.find((circuit) => circuit.access === route.access) ??
    view.circuits.find((circuit) => circuit.access === `route:${route.id}`);
  const updateRoute = (patch: Partial<Route>) =>
    change((c) => ({
      ...c,
      routes: c.routes.map((r) => (r.id === route?.id ? { ...r, ...patch } : r)),
    }));
  const preference = draft.roleRoutes?.[role] ?? [];
  const setPreference = (ids: string[]) =>
    change((c) => ({
      ...c,
      roleRoutes: {
        ...(Object.fromEntries(roles.map((r) => [r, c.roleRoutes?.[r] ?? []])) as Record<
          Role,
          string[]
        >),
        [role]: ids,
      },
    }));
  const provider = catalog.data?.providers.find((p) => p.provider === route?.provider);
  const models = (provider?.models ?? []).filter(
    (m) =>
      m.isSelectable !== false &&
      (m.thinkingOptions?.some((t) => efforts.includes(t.id)) ||
        (route?.provider === "claude" && !m.thinkingOptions?.length)),
  );
  const model = models.find((m) => m.id === route?.model);
  const profiles = (catalog.data?.profiles ?? []).filter(
    (p) => p.provider === route?.provider || p.provider.startsWith(`${route?.provider}/`),
  );
  const addProfileRoute = () => {
    const profile = catalog.data?.profiles.find((p) => p.id === newProfileId);
    if (!profile) return;
    const providerId = profile.provider.split("/")[0];
    try {
      const entries = catalog.data?.providers.find((p) => p.provider === providerId)?.models ?? [];
      const added = createProfileRoute(profile, entries, draft.routes);
      change((c) => ({ ...c, routes: [...c.routes, added] }));
      setRouteId(added.id);
      setNewProfileId("");
    } catch {
      setError(
        "Das Profil enthält ein nicht verfügbares Modell oder eine nicht unterstützte Reasoning-Stufe.",
      );
    }
  };
  const invalid =
    draft.maxWorkflows < 1 ||
    draft.maxWorkflows > 2 ||
    draft.maxRework < 0 ||
    draft.maxRework > 2 ||
    !Number.isInteger(draft.maxWorkflows) ||
    !Number.isInteger(draft.maxRework) ||
    !Number.isFinite(decision.monthlyBudgetMicroUsd) ||
    decision.monthlyBudgetMicroUsd < 0 ||
    decision.monthlyBudgetMicroUsd > Math.min(5000000, draft.budgets.decisions) ||
    decision.maxCallMicroUsd < 1000 ||
    decision.maxCallMicroUsd > 50000 ||
    !Number.isFinite(decision.maxCallMicroUsd) ||
    decision.timeoutMs < 1000 ||
    decision.timeoutMs > 30000 ||
    !Number.isFinite(decision.timeoutMs) ||
    decision.minConfidence < 0.5 ||
    decision.minConfidence > 1 ||
    !Number.isFinite(decision.minConfidence) ||
    draft.routes.some(
      (r) =>
        (r.name !== undefined && (!r.name.trim() || r.name.trim().length > 120)) ||
        !Number.isInteger(r.tier) ||
        r.tier < 1 ||
        r.tier > 3 ||
        !Number.isInteger(r.maxConcurrent) ||
        r.maxConcurrent < 1 ||
        r.maxConcurrent > 10 ||
        !efforts.includes(r.reasoning) ||
        !r.dataScopes.length ||
        !r.capabilities.length,
    ) ||
    Object.values(draft.budgets).some((v) => !Number.isFinite(v) || v < 0) ||
    (decision.enabled &&
      (!decision.fundsConfirmed ||
        !/^\d{4}-\d{2}-\d{2}$/.test(decision.validUntil) ||
        !Number.isFinite(Date.parse(`${decision.validUntil}T00:00:00Z`)) ||
        new Date(`${decision.validUntil}T00:00:00Z`).toISOString().slice(0, 10) !==
          decision.validUntil));
  const num = (label: string, value: number, onChange: (n: number) => void, hint?: string) => (
    <SettingsInput
      key={`${generation}:${route.id}:${label}`}
      label={label}
      hint={hint}
      initialValue={String(value)}
      onChangeText={(s) => onChange(s.trim() ? Number(s.replace(",", ".")) : NaN)}
    />
  );
  const chooseEffort = (id: string, preferred = route.reasoning) => {
    const available =
      models
        .find((m) => m.id === id)
        ?.thinkingOptions?.map((t) => t.id)
        .filter((id) => efforts.includes(id)) ?? [];
    return available.includes(preferred)
      ? preferred
      : available.includes(route.tier === 3 ? "high" : "medium")
        ? route.tier === 3
          ? "high"
          : "medium"
        : (available[0] ?? "");
  };
  const info = (label: string, value: string) => <SettingsRow label={label} hint={value} />;
  return (
    <ScrollView
      style={{ backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 20 }}
    >
      <SettingsSection
        title="Konfiguration"
        info="Änderungen gelten für neue Workflows; laufende Agenten behalten ihre Konfiguration."
      >
        <SettingsCard>
          <SettingsSelect<Tab> label="Bereich" value={tab} options={tabs} onValueChange={setTab} />
          {info(
            "Status",
            busy ? "Aktion läuft" : dirty ? "Ungespeicherte Änderungen" : "Gespeichert",
          )}
          {info(
            "Wirksamkeit",
            "Neue Workflows übernehmen die gespeicherten Werte. Laufende Aufträge behalten ihre geprüfte Konfiguration.",
          )}
          <SettingsAction
            label={invalid ? "Eingaben prüfen" : "Konfiguration speichern"}
            hint={invalid ? "Grenzen oder Bestätigung für Decisions prüfen." : undefined}
            actionLabel="Speichern"
            disabled={!dirty || invalid || busy}
            onPress={() => saveMutation.mutate(draft)}
          />
          <SettingsAction
            label="Entwurf verwerfen und neu laden"
            actionLabel="Neu laden"
            disabled={busy}
            onPress={() => reloadMutation.mutate()}
          />
          <SettingsSwitch
            label="Neue Aufträge pausieren"
            hint={`Laufende Agenten bleiben aktiv. Aktive Versuche: ${view.activeAttempts}`}
            value={view.dispatchPaused}
            disabled={busy}
            onValueChange={(v) => pauseMutation.mutate(v)}
          />
        </SettingsCard>
        {!!error && (
          <Text accessibilityRole="alert" style={{ color: theme.colors.foreground }}>
            {error}
          </Text>
        )}
      </SettingsSection>
      {tab === "routes" && (
        <>
          <SettingsSection title="Ablauf">
            <SettingsCard>
              {num(
                "Maximale Workflows pro Hauptsession",
                draft.maxWorkflows,
                (n) => change((c) => ({ ...c, maxWorkflows: n })),
                "1 bis 2; Provider-Kontingente gelten weiterhin pro Zugang.",
              )}
              {num(
                "Maximale Nacharbeiten",
                draft.maxRework,
                (n) => change((c) => ({ ...c, maxRework: n })),
                "0 bis 2",
              )}
              <SettingsSwitch
                label="Live-Ausführung freigegeben"
                value={draft.liveDispatchApproved}
                onValueChange={(v) => change((c) => ({ ...c, liveDispatchApproved: v }))}
              />
              <SettingsSwitch
                label="API-Coding-Worker"
                hint="Separater Pi-Key; Guthabenfreigabe unter Keys & Budgets erforderlich."
                value={draft.apiEnabled}
                onValueChange={(apiEnabled) => change((config) => ({ ...config, apiEnabled }))}
              />
            </SettingsCard>
          </SettingsSection>
          <SettingsSection
            title="Reihenfolge je Rolle"
            info="Die erste Route ist primär; weitere werden in dieser Reihenfolge als Fallback verwendet."
          >
            <SettingsCard>
              <SettingsSelect<Role>
                label="Rolle"
                value={role}
                options={roles.map((value) => ({ value, label: roleLabels[value] }))}
                onValueChange={setRole}
              />
              {preference.map((id, index) => (
                <View key={id}>
                  {info(
                    `${index + 1}. ${index === 0 ? "Primär" : "Fallback"}`,
                    routeLabel(draft.routes.find((route) => route.id === id)!),
                  )}
                  <SettingsAction
                    label="Position"
                    actionLabel="Nach oben"
                    disabled={index === 0}
                    onPress={() => {
                      const p = [...preference];
                      [p[index - 1], p[index]] = [p[index], p[index - 1]];
                      setPreference(p);
                    }}
                  />
                  <SettingsAction
                    label="Position"
                    actionLabel="Nach unten"
                    disabled={index === preference.length - 1}
                    onPress={() => {
                      const p = [...preference];
                      [p[index + 1], p[index]] = [p[index], p[index + 1]];
                      setPreference(p);
                    }}
                  />
                  <SettingsAction
                    label="Zuordnung"
                    actionLabel="Entfernen"
                    onPress={() => setPreference(preference.filter((_, i) => i !== index))}
                  />
                </View>
              ))}
              <SettingsSelect
                label="Route hinzufügen"
                value=""
                options={[
                  { label: "Route auswählen", value: "" },
                  ...draft.routes
                    .filter((r) => !preference.includes(r.id))
                    .map((route) => ({ value: route.id, label: routeLabel(route) })),
                ]}
                onValueChange={(v) => {
                  if (v) setPreference([...preference, v]);
                }}
              />
            </SettingsCard>
          </SettingsSection>
          <SettingsSection title="Profil als zusätzliche Route">
            <SettingsCard>
              <SettingsSelect
                label="Paseo-Profil"
                value={newProfileId}
                options={[
                  { value: "", label: "Profil auswählen" },
                  ...(catalog.data?.profiles ?? []).map((p) => ({ value: p.id, label: p.name })),
                ]}
                disabled={!catalog.data}
                onValueChange={setNewProfileId}
              />
              <SettingsAction
                label="Neue Route vorbereiten"
                hint="Wird zunächst deaktiviert hinzugefügt. Danach Qualität prüfen und den Rollen zuordnen."
                actionLabel="Hinzufügen"
                disabled={!newProfileId || busy}
                onPress={addProfileRoute}
              />
            </SettingsCard>
          </SettingsSection>
          <SettingsSection
            title="Route bearbeiten"
            info={
              catalog.isError
                ? "Modellkatalog nicht verfügbar. Erneut laden, bevor Modell oder Profil geändert wird."
                : undefined
            }
          >
            <SettingsCard>
              <SettingsSelect
                label="Route"
                value={route?.id ?? ""}
                options={draft.routes.map((route) => ({
                  value: route.id,
                  label: routeLabel(route),
                }))}
                onValueChange={setRouteId}
              />
              {route && (
                <>
                  <SettingsInput
                    key={`route-name-${generation}-${route.id}`}
                    label="Routenname"
                    hint="Eigener Anzeigename; die interne ID und Rollenzuordnungen bleiben erhalten."
                    initialValue={route.name ?? routeLabel(route)}
                    onChangeText={(name) => updateRoute({ name })}
                  />
                  {info("Interne Route-ID", route.id)}
                  {info("Provider / Zugang", `${route.provider} / ${route.access}`)}
                  {info(
                    "Routenstatus",
                    !route.enabled
                      ? "Deaktiviert"
                      : circuit
                        ? `Pausiert: ${circuit.reason}${circuit.untilMs ? ` · bis ${new Date(circuit.untilMs).toLocaleString("de-DE")}` : " · erneute Freigabe erforderlich"}`
                        : "Aktiv",
                  )}
                  <SettingsSelect
                    label="Profil"
                    value={route.profileId ?? ""}
                    options={[
                      { label: "Kein Profil", value: "" },
                      ...profiles.map((p) => ({ value: p.id, label: p.name })),
                    ]}
                    disabled={!catalog.data}
                    onValueChange={(v) => {
                      const p = profiles.find((x) => x.id === v);
                      if (!p) {
                        updateRoute({ profileId: undefined, profileName: undefined });
                        return;
                      }
                      const profileModel =
                        p.model ??
                        (p.provider.includes("/")
                          ? p.provider.slice(p.provider.indexOf("/") + 1)
                          : undefined);
                      if (
                        (profileModel && !models.some((m) => m.id === profileModel)) ||
                        (p.modeId && !provider?.modes?.some((m) => m.id === p.modeId)) ||
                        (p.thinkingOptionId &&
                          (!efforts.includes(p.thinkingOptionId) ||
                            !models
                              .find((m) => m.id === (profileModel ?? route.model))
                              ?.thinkingOptions?.some((t) => t.id === p.thinkingOptionId)))
                      ) {
                        setError("Das Profil enthält nicht unterstützte Katalogwerte.");
                        return;
                      }
                      updateRoute({
                        profileId: p.id,
                        profileName: p.name,
                        ...(profileModel ? { model: profileModel } : {}),
                        modeId: p.modeId,
                        reasoning: chooseEffort(
                          profileModel ?? route.model,
                          p.thinkingOptionId ?? route.reasoning,
                        ),
                        featureValues: p.featureValues as Route["featureValues"],
                      });
                    }}
                  />
                  <SettingsSelect
                    label="Modell"
                    value={route.model}
                    options={models.map((m) => ({ value: m.id, label: m.label }))}
                    disabled={!models.length}
                    onValueChange={(v) =>
                      updateRoute({
                        model: v,
                        reasoning: chooseEffort(v),
                        profileId: undefined,
                        profileName: undefined,
                      })
                    }
                  />
                  <SettingsSelect
                    label="Reasoning"
                    value={route.reasoning}
                    options={
                      model?.thinkingOptions?.length
                        ? model.thinkingOptions
                            .filter((t) => efforts.includes(t.id))
                            .map((t) => ({ value: t.id, label: t.label }))
                        : [{ value: "", label: "Vom Modell vorgegeben" }]
                    }
                    disabled={!model || !model.thinkingOptions?.length}
                    onValueChange={(v) =>
                      updateRoute({ reasoning: v, profileId: undefined, profileName: undefined })
                    }
                  />
                  <SettingsSelect
                    label="Berechtigungsmodus"
                    hint="Unabhängig von Flex/Standard-Verarbeitung."
                    value={route.modeId ?? ""}
                    options={[
                      { value: "", label: "Standard" },
                      ...(provider?.modes ?? []).map((m) => ({ value: m.id, label: m.label })),
                    ]}
                    disabled={!provider}
                    onValueChange={(v) =>
                      updateRoute({
                        modeId: v || undefined,
                        profileId: undefined,
                        profileName: undefined,
                      })
                    }
                  />
                  {route.access === "openai-api" &&
                    info(
                      "Verarbeitung",
                      route.model.endsWith("-standard")
                        ? "Standard"
                        : "Flex; bei bestätigter Nichtverfügbarkeit wechselt diese Pi-Session zu Standard.",
                    )}
                  <SettingsSwitch
                    label="Route aktiviert"
                    hint={
                      route.access === "openai-api"
                        ? "Luna über Pi; benötigt API-Freigabe, Taskbudget und Repository-Grenze."
                        : route.access === "claude-company-pro"
                          ? "Firmen-Abo; nur innerhalb der explizit freigegebenen Repository-Grenzen."
                          : undefined
                    }
                    value={route.enabled}
                    onValueChange={(v) => updateRoute({ enabled: v })}
                  />
                  <SettingsInput
                    key={`roots-${generation}-${route.id}`}
                    label="Freigegebene Repository-Verzeichnisse"
                    hint="Absolute Pfade mit Semikolon trennen. Unterverzeichnisse sind eingeschlossen. Firmeninhalte an DeepSeek benötigen diese ausdrückliche Freigabe."
                    initialValue={(route.repositoryRoots ?? []).join("; ")}
                    onChangeText={(value) =>
                      updateRoute({
                        repositoryRoots: value
                          .split(";")
                          .map((root) => root.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                  {route.access === "openai-api" && (
                    <SettingsSwitch
                      label="Zusätzliches Limit pro API-Auftrag"
                      value={route.maxTaskMicroUsd !== undefined}
                      hint="Standard: nur das freigegebene API-Monatsbudget. Abo-Routen haben kein Dollarbudget."
                      onValueChange={(value) =>
                        updateRoute({ maxTaskMicroUsd: value ? 5000000 : undefined })
                      }
                    />
                  )}
                  {route.access === "openai-api" &&
                    route.maxTaskMicroUsd !== undefined &&
                    num(
                      "Optionales Tasklimit in USD",
                      route.maxTaskMicroUsd / 1000000,
                      (value) => updateRoute({ maxTaskMicroUsd: Math.round(value * 1000000) }),
                      "Nur bei bewusst gewünschter zusätzlicher Begrenzung; kein automatischer Modellwechsel bei Erreichen.",
                    )}
                  <SettingsSelect
                    label="Qualitätsstufe"
                    value={String(route.tier)}
                    options={[
                      { value: "1", label: "1 · Kleine Aufgaben" },
                      { value: "2", label: "2 · Normale Implementierung" },
                      { value: "3", label: "3 · Anspruchsvoll / Review" },
                    ]}
                    onValueChange={(v) => updateRoute({ tier: Number(v) })}
                  />
                  {num("Parallel je Route und Hauptsession", route.maxConcurrent, (n) =>
                    updateRoute({ maxConcurrent: n }),
                  )}
                  {Object.entries(scopeLabels).map(([scope, label]) => (
                    <SettingsSwitch
                      key={`${route.id}-${scope}`}
                      label={`Datenscope: ${label}`}
                      value={route.dataScopes.includes(scope)}
                      onValueChange={(v) =>
                        updateRoute({
                          dataScopes: v
                            ? [...route.dataScopes, scope]
                            : route.dataScopes.filter((s) => s !== scope),
                        })
                      }
                    />
                  ))}
                  {["code", "text"].map((cap) => (
                    <SettingsSwitch
                      key={`${route.id}-${cap}`}
                      label={cap === "code" ? "Programmieren" : "Textaufgaben"}
                      value={route.capabilities.includes(cap)}
                      onValueChange={(v) =>
                        updateRoute({
                          capabilities: v
                            ? [...route.capabilities, cap]
                            : route.capabilities.filter((c) => c !== cap),
                        })
                      }
                    />
                  ))}
                </>
              )}
            </SettingsCard>
          </SettingsSection>
        </>
      )}
      {tab === "decisions" && (
        <SettingsSection
          title="Decisions"
          info="Ein Test wird nur auf ausdrücklichen Klick ausgeführt und kann Kosten verursachen."
        >
          <SettingsCard>
            {info(
              "Einsatz",
              "V3: ein gebündeltes Intake je neuer Nachricht und eine Klassifizierung je Paketrevision. Decisions bestimmt Workflowbedarf und Aufgabenklasse, niemals Modell, Priorität oder Effort. Unklare Klassifizierung startet keinen Writer.",
            )}
            <SettingsSwitch
              label="Decisions aktivieren"
              value={decision.enabled}
              onValueChange={(v) => updateDecision({ enabled: v })}
            />
            {info("Modell", "gpt-6-luna")}
            {info("Reasoning", "Von der Decisions API gesteuert; kein separater Effort-Parameter.")}
            {info(
              "Modellwahl",
              "Die Rollenprioritäten im Tab Rollen & Modelle gelten verbindlich. Alte Decisions-Rollenzuordnungen sind in v3 ohne Wirkung.",
            )}
            {Object.entries(scopeLabels).map(([scope, label]) => (
              <SettingsSwitch
                key={`decision-${scope}`}
                label={`Datenscope: ${label}`}
                value={decision.dataScopes.includes(scope)}
                onValueChange={(v) =>
                  updateDecision({
                    dataScopes: v
                      ? [...decision.dataScopes, scope]
                      : decision.dataScopes.filter((s) => s !== scope),
                  })
                }
              />
            ))}
            {num(
              "Mindestkonfidenz",
              decision.minConfidence,
              (n) => updateDecision({ minConfidence: n }),
              "0,5 bis 1 für Intention/Implementierungsfreigabe und Aufgabenklasse. Unklare Zusatzempfehlungen verwenden konservative Regeln; Pflichtreviews bleiben verbindlich.",
            )}
            {num(
              "Timeout in Sekunden",
              decision.timeoutMs / 1000,
              (n) => updateDecision({ timeoutMs: Math.round(n * 1000) }),
              "1 bis 30",
            )}
            <SettingsAction
              label="Gespeicherten Decisions-Zugang testen"
              hint="Ein echter kleiner API-Aufruf; keine Coding-Agenten. Budgetfreigabe muss vorher gespeichert sein."
              actionLabel="Testen"
              disabled={busy || dirty}
              onPress={() => testMutation.mutate()}
            />
            {testMutation.data &&
              info(
                "Testergebnis",
                `${testMutation.data.status} · ${testMutation.data.reason} · ${testMutation.data.model} · reserviert: ${usd(testMutation.data.reservedMicroUsd)} USD`,
              )}
          </SettingsCard>
        </SettingsSection>
      )}
      {tab === "keys" && (
        <>
          <SettingsSection title="Keys" info="Keys werden nicht angezeigt oder vorausgefüllt.">
            <SettingsCard>
              {(["normal", "decisions"] as const).map((slot) => (
                <View key={slot}>
                  {info(
                    slot === "normal" ? "Normaler Key" : "Decisions-Key",
                    view.credentials[slot].source === "pi"
                      ? "Vorhandener Pi-Key wird verwendet."
                      : view.credentials[slot].present
                        ? "Gespeichert"
                        : "Nicht vorhanden",
                  )}
                  <SettingsInput
                    ref={slot === "normal" ? normalRef : decisionsRef}
                    label={
                      slot === "normal" ? "Normalen API-Key eingeben" : "Decisions-Key eingeben"
                    }
                    hint={
                      slot === "normal"
                        ? "Ändert den OpenAI-Zugang von Pi. Bestehende Pi-Sessions bei Bedarf neu laden."
                        : "Separates Decisions-Projekt mit eigenem Hard Limit."
                    }
                    secureTextEntry
                    onChangeText={(text) =>
                      slot === "normal"
                        ? setNormalReady(text.length >= 20)
                        : setDecisionsReady(text.length >= 20)
                    }
                  />
                  <SettingsAction
                    label="Key sicher speichern"
                    actionLabel="Key speichern"
                    disabled={busy || !(slot === "normal" ? normalReady : decisionsReady)}
                    onPress={() => credentialMutation.mutate(slot)}
                  />
                </View>
              ))}
            </SettingsCard>
          </SettingsSection>
          <SettingsSection title="API-Guthabenfreigabe">
            <SettingsCard>
              {view.apiUsage &&
                info(
                  "Konservativ reserviertes API-Budget",
                  `${view.apiUsage.cycle}: ${usd(view.apiUsage.committedMicroUsd)} USD · ${view.apiUsage.reservations} Task-Reservierungen. Keine exakte Abrechnung.`,
                )}
              <SettingsSwitch
                label="API-Guthaben bestätigt"
                value={funding.confirmed}
                onValueChange={(confirmed) => updateFunding({ confirmed })}
              />
              {num(
                "Verfügbare API-Credits in USD",
                funding.availableMicroUsd / 1000000,
                (value) => updateFunding({ availableMicroUsd: Math.round(value * 1000000) }),
                "Alle Budget-Buckets zusammen müssen innerhalb dieser Zuteilung bleiben.",
              )}
              <SettingsInput
                key={`api-cycle-${generation}`}
                label="Freigegebener UTC-Monat"
                hint="JJJJ-MM; neuer Monat benötigt erneute Guthabenbestätigung."
                initialValue={funding.cycle}
                onChangeText={(cycle) => updateFunding({ cycle })}
              />
              <SettingsInput
                key={`api-expiry-${generation}`}
                label="API-Freigabe gültig bis"
                hint="JJJJ-MM-TT"
                initialValue={funding.validUntil}
                onChangeText={(validUntil) => updateFunding({ validUntil })}
              />
            </SettingsCard>
          </SettingsSection>
          <SettingsSection title="Decisions-Budget">
            <SettingsCard>
              {num(
                "Monatsbudget in USD",
                decision.monthlyBudgetMicroUsd / 1000000,
                (n) => updateDecision({ monthlyBudgetMicroUsd: Math.round(n * 1000000) }),
                "Maximal 5 USD",
              )}
              {num(
                "Maximum pro Aufruf in USD",
                decision.maxCallMicroUsd / 1000000,
                (n) => updateDecision({ maxCallMicroUsd: Math.round(n * 1000000) }),
                "0,001 bis 0,05 USD",
              )}
              <SettingsSwitch
                label="Guthaben bestätigt"
                value={decision.fundsConfirmed}
                onValueChange={(v) => updateDecision({ fundsConfirmed: v })}
              />
              <SettingsInput
                key={`expiry-${generation}`}
                label="Bestätigung gültig bis"
                hint="JJJJ-MM-TT; tatsächliches Ablaufdatum der freigegebenen Credits"
                initialValue={decision.validUntil}
                onChangeText={(v) => updateDecision({ validUntil: v })}
              />
              <SettingsInput
                key={`project-${generation}`}
                label="Projekt-ID"
                hint="Optional; Projekt des Decisions-Keys"
                initialValue={decision.projectId}
                onChangeText={(v) => updateDecision({ projectId: v })}
              />
              {info(
                "Konservativ gebundenes Budget",
                `${view.usage.cycle}: ${usd(view.usage.committedMicroUsd)} USD · ${view.usage.calls} Aufrufe · ${view.usage.unknownCalls} ungeklärt. Keine exakte Abrechnungsanzeige.`,
              )}
            </SettingsCard>
          </SettingsSection>
          <SettingsSection title="Controller-Budgets">
            <SettingsCard>
              {(Object.keys(draft.budgets) as (keyof ControllerConfig["budgets"])[]).map((key) =>
                num(`${key} · USD`, draft.budgets[key] / 1000000, (n) =>
                  change((c) => ({
                    ...c,
                    budgets: { ...c.budgets, [key]: Math.round(n * 1000000) },
                  })),
                ),
              )}
            </SettingsCard>
          </SettingsSection>
        </>
      )}
    </ScrollView>
  );
}
