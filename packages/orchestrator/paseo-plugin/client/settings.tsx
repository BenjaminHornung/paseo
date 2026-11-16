import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
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
} from "@getpaseo/plugin/client/ui";
import { useCallback, useState } from "react";
import { View } from "react-native";
import type { ControllerConfig, DecisionSettings, Route } from "../shared/settings";
import { createProfileRoute, reasoningOptions, removeRoute, routeLabel } from "../shared/routes";
import type { SettingsErrors } from "../shared/settings-validation";
import { RoutingPreferences } from "./routing-preferences";
import { safeError, useSettingsState, type ReadySettings, type Tab } from "./settings-state";

const accessHints: Partial<Record<Route["access"], string>> = {
  "openai-api": "Luna über Pi; benötigt API-Freigabe und Taskbudget.",
  "claude-company-pro": "Firmen-Abo.",
  "claude-personal-pro": "Privates Abo; separates Konto.",
};
const defaults: DecisionSettings = {
  enabled: false,
  model: "gpt-6-luna",
  roles: [],
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
const efforts = reasoningOptions;
const usd = (value: number) => String(value / 1000000);
const info = (label: string, value: string) => <SettingsRow label={label} hint={value} />;
const numberField = (generation: number, errors: SettingsErrors, scope: string) =>
  function num(
    label: string,
    value: number,
    onChange: (n: number) => void,
    hint?: string,
    errorKey?: string,
  ) {
    return (
      <SettingsInput
        key={`${generation}:${scope}:${label}`}
        label={label}
        hint={hint}
        error={errorKey ? errors[errorKey] : undefined}
        initialValue={String(value)}
        onChangeText={(s) => onChange(s.trim() ? Number(s.replace(",", ".")) : NaN)}
      />
    );
  };
const fundingOf = (draft: ReadySettings["draft"]) =>
  draft.apiFunding ?? {
    confirmed: false,
    cycle: new Date().toISOString().slice(0, 7),
    availableMicroUsd: 0,
    validUntil: "",
  };

function ProfileRouteAdder({
  ctx,
  setRouteId,
}: {
  ctx: ReadySettings;
  setRouteId: (id: string) => void;
}) {
  const { draft, catalog, change, busy, setError } = ctx;
  const [newProfileId, setNewProfileId] = useState("");
  const addProfileRoute = () => {
    const profile = catalog.data?.profiles.find((x) => x.id === newProfileId);
    if (!profile) return;
    const providerId = profile.provider.split("/")[0];
    try {
      const entries = catalog.data?.providers.find((x) => x.provider === providerId)?.models ?? [];
      const added = createProfileRoute(profile, entries, draft.routes);
      change((c) => ({ ...c, routes: [...c.routes, added] }));
      setRouteId(added.id);
      setNewProfileId("");
    } catch (caughtError) {
      const code = caughtError instanceof Error ? caughtError.message : "";
      const messages: Record<string, string> = {
        PROFILE_PROVIDER_UNSUPPORTED: "Dieser Provider wird vom Orchestrator nicht unterstützt.",
        PROFILE_MODEL_UNAVAILABLE: "Das Modell dieses Profils ist beim Provider nicht verfügbar.",
        PROFILE_REASONING_UNSUPPORTED:
          "Die Reasoning-Stufe dieses Profils wird vom Modell nicht unterstützt.",
        PROFILE_FEATURE_UNSUPPORTED:
          "Das Profil enthält eine nicht unterstützte Feature-Einstellung.",
      };
      setError(messages[code] ?? "Die Profilroute konnte nicht angelegt werden.");
    }
  };
  return (
    <SettingsSection title="Profil als zusätzliche Route">
      <SettingsCard>
        <SettingsSelect
          label="Paseo Advanced-Profil"
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
  );
}

function RouteEditor({
  ctx,
  routeId,
  setRouteId,
}: {
  ctx: ReadySettings;
  routeId: string;
  setRouteId: (id: string) => void;
}) {
  const { draft, view, catalog, change, errors, generation, setError } = ctx;
  const route = draft.routes.find((r) => r.id === routeId) ?? draft.routes[0];
  const num = numberField(generation, errors, route.id);
  const circuit =
    view.circuits.find((circuit) => circuit.access === route.access) ??
    view.circuits.find((circuit) => circuit.access === `route:${route.id}`);
  const updateRoute = (patch: Partial<Route>) =>
    change((c) => ({
      ...c,
      routes: c.routes.map((r) => (r.id === route?.id ? { ...r, ...patch } : r)),
    }));
  const deleteRoute = useCallback(() => {
    change((c) => removeRoute(c, route.id));
    setRouteId("");
  }, [change, route.id, setRouteId]);
  const provider = catalog.data?.providers.find((p) => p.provider === route?.provider);
  const models = (provider?.models ?? []).filter(
    (m) =>
      m.isSelectable !== false &&
      (m.thinkingOptions?.some((t) => efforts.includes(t.id)) ||
        ((route?.provider === "claude" || route?.provider === "claude-private") &&
          !m.thinkingOptions?.length)),
  );
  const model = models.find((m) => m.id === route?.model);
  const profiles = (catalog.data?.profiles ?? []).filter(
    (p) => p.provider === route?.provider || p.provider.startsWith(`${route?.provider}/`),
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
  return (
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
              error={errors[`route:${route.id}:name`]}
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
              error={errors[`route:${route.id}:reasoning`]}
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
              hint={accessHints[route.access]}
              value={route.enabled}
              error={errors[`route:${route.id}:enabled`]}
              onValueChange={(v) => updateRoute({ enabled: v })}
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
                `route:${route.id}:maxTaskMicroUsd`,
              )}
            <SettingsSelect
              label="Qualitätsstufe"
              value={String(route.tier)}
              options={[
                { value: "1", label: "1 · Kleine Aufgaben" },
                { value: "2", label: "2 · Normale Implementierung" },
                { value: "3", label: "3 · Anspruchsvoll / Review" },
              ]}
              error={errors[`route:${route.id}:tier`]}
              onValueChange={(v) => updateRoute({ tier: Number(v) })}
            />
            {num(
              "Parallel je Route und Hauptsession",
              route.maxConcurrent,
              (n) => updateRoute({ maxConcurrent: n }),
              undefined,
              `route:${route.id}:maxConcurrent`,
            )}
            {["code", "text"].map((cap) => (
              <SettingsSwitch
                key={`${route.id}-${cap}`}
                label={cap === "code" ? "Programmieren" : "Textaufgaben"}
                value={route.capabilities.includes(cap)}
                error={errors[`route:${route.id}:capabilities`]}
                onValueChange={(v) =>
                  updateRoute({
                    capabilities: v
                      ? [...route.capabilities, cap]
                      : route.capabilities.filter((c) => c !== cap),
                  })
                }
              />
            ))}
            <SettingsAction
              label="Route löschen"
              hint={
                draft.routes.length < 2
                  ? "Die letzte Route kann nicht gelöscht werden."
                  : "Entfernt die Route auch aus allen Rollen und Arbeitskategorien; eine leere Zuordnung fällt auf die nächste verfügbare Route zurück."
              }
              actionLabel="Löschen"
              disabled={draft.routes.length < 2}
              onPress={deleteRoute}
            />
          </>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function RoutesTab({ ctx, theme }: { ctx: ReadySettings; theme: PluginSurfaceProps["theme"] }) {
  const { draft, change, errors, generation } = ctx;
  const [routeId, setRouteId] = useState("");
  const num = numberField(generation, errors, "flow");
  return (
    <>
      <SettingsSection title="Ablauf">
        <SettingsCard>
          {num(
            "Maximale Workflows pro Hauptsession",
            draft.maxWorkflows,
            (n) => change((c) => ({ ...c, maxWorkflows: n })),
            "1 bis 2; Provider-Kontingente gelten weiterhin pro Zugang.",
            "maxWorkflows",
          )}
          {num(
            "Maximale Nacharbeiten",
            draft.maxRework,
            (n) => change((c) => ({ ...c, maxRework: n })),
            "0 bis 2",
            "maxRework",
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
            error={errors["funding.confirmed"] || errors["funding.validUntil"]}
            onValueChange={(apiEnabled) => change((config) => ({ ...config, apiEnabled }))}
          />
        </SettingsCard>
      </SettingsSection>
      <RoutingPreferences
        config={draft}
        onChange={change}
        generation={generation}
        theme={theme}
        errors={errors}
      />
      <ProfileRouteAdder ctx={ctx} setRouteId={setRouteId} />
      <RouteEditor ctx={ctx} routeId={routeId} setRouteId={setRouteId} />
    </>
  );
}

function DecisionsTab({ ctx }: { ctx: ReadySettings }) {
  const { draft, change, errors, generation, busy, dirty, testMutation } = ctx;
  const num = numberField(generation, errors, "decisions");
  const decision = draft.decisions ?? defaults;
  const updateDecision = (patch: Partial<DecisionSettings>) =>
    change((c) => ({ ...c, decisions: { ...(c.decisions ?? defaults), ...patch } }));
  return (
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
          error={errors["decisions.enabled"]}
          onValueChange={(v) => updateDecision({ enabled: v })}
        />
        {info("Modell", "gpt-6-luna")}
        {info("Reasoning", "Von der Decisions API gesteuert; kein separater Effort-Parameter.")}
        {info(
          "Modellwahl",
          "Die Rollenprioritäten im Tab Rollen & Modelle gelten verbindlich. Alte Decisions-Rollenzuordnungen sind in v3 ohne Wirkung.",
        )}
        {num(
          "Mindestkonfidenz",
          decision.minConfidence,
          (n) => updateDecision({ minConfidence: n }),
          "0,5 bis 1 für Intention/Implementierungsfreigabe und Aufgabenklasse. Unklare Zusatzempfehlungen verwenden konservative Regeln; Pflichtreviews bleiben verbindlich.",
          "decisions.minConfidence",
        )}
        {num(
          "Timeout in Sekunden",
          decision.timeoutMs / 1000,
          (n) => updateDecision({ timeoutMs: Math.round(n * 1000) }),
          "1 bis 30",
          "decisions.timeoutMs",
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
  );
}

function KeysTab({ ctx }: { ctx: ReadySettings }) {
  const { draft, view, change, errors, generation, busy } = ctx;
  const { normalRef, decisionsRef, normalReady, decisionsReady, credentialMutation } = ctx;
  const { setNormalReady, setDecisionsReady } = ctx;
  const num = numberField(generation, errors, "keys");
  const decision = draft.decisions ?? defaults;
  const funding = fundingOf(draft);
  const updateFunding = (patch: Partial<typeof funding>) =>
    change((config) => ({ ...config, apiFunding: { ...funding, ...patch } }));
  const updateDecision = (patch: Partial<DecisionSettings>) =>
    change((c) => ({ ...c, decisions: { ...(c.decisions ?? defaults), ...patch } }));
  return (
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
                label={slot === "normal" ? "Normalen API-Key eingeben" : "Decisions-Key eingeben"}
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
            error={errors["funding.confirmed"]}
            onValueChange={(confirmed) => updateFunding({ confirmed })}
          />
          {num(
            "Verfügbare API-Credits in USD",
            funding.availableMicroUsd / 1000000,
            (value) => updateFunding({ availableMicroUsd: Math.round(value * 1000000) }),
            "Alle Budget-Buckets zusammen müssen innerhalb dieser Zuteilung bleiben.",
            "funding.available",
          )}
          <SettingsInput
            key={`api-cycle-${generation}`}
            label="Freigegebener UTC-Monat"
            hint="JJJJ-MM; neuer Monat benötigt erneute Guthabenbestätigung."
            initialValue={funding.cycle}
            error={errors["funding.cycle"]}
            onChangeText={(cycle) => updateFunding({ cycle })}
          />
          <SettingsInput
            key={`api-expiry-${generation}`}
            label="API-Freigabe gültig bis"
            hint="JJJJ-MM-TT"
            initialValue={funding.validUntil}
            error={errors["funding.validUntil"]}
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
            "decisions.monthlyBudgetMicroUsd",
          )}
          {num(
            "Maximum pro Aufruf in USD",
            decision.maxCallMicroUsd / 1000000,
            (n) => updateDecision({ maxCallMicroUsd: Math.round(n * 1000000) }),
            "0,001 bis 0,05 USD",
            "decisions.maxCallMicroUsd",
          )}
          <SettingsSwitch
            label="Guthaben bestätigt"
            value={decision.fundsConfirmed}
            error={errors["decisions.fundsConfirmed"]}
            onValueChange={(v) => updateDecision({ fundsConfirmed: v })}
          />
          <SettingsInput
            key={`expiry-${generation}`}
            label="Bestätigung gültig bis"
            hint="JJJJ-MM-TT; tatsächliches Ablaufdatum der freigegebenen Credits"
            initialValue={decision.validUntil}
            error={errors["decisions.validUntil"]}
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
            num(
              `${key} · USD`,
              draft.budgets[key] / 1000000,
              (n) =>
                change((c) => ({
                  ...c,
                  budgets: { ...c.budgets, [key]: Math.round(n * 1000000) },
                })),
              undefined,
              `budget:${key}`,
            ),
          )}
        </SettingsCard>
      </SettingsSection>
    </>
  );
}

export function OrchestratorSettings({
  theme,
  layout,
  initialTab,
}: PluginSurfaceProps & { initialTab: Tab }) {
  const state = useSettingsState(initialTab);
  const { view, draft, settings, tab, setTab, status, error, busy, reloadMutation } = state;
  const { pauseMutation } = state;
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
  const ready: ReadySettings = { ...state, view, draft };
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
          <SettingsRow label="Status" hint={status} error={error || undefined} />
          {info(
            "Wirksamkeit",
            "Änderungen werden automatisch gespeichert. Neue Workflows übernehmen die gespeicherten Werte; laufende Aufträge behalten ihre geprüfte Konfiguration.",
          )}
          <SettingsAction
            label="Vom Server neu laden"
            hint="Verwirft nicht gespeicherte Änderungen."
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
      </SettingsSection>
      {tab === "routes" && <RoutesTab ctx={ready} theme={theme} />}
      {tab === "decisions" && <DecisionsTab ctx={ready} />}
      {tab === "keys" && <KeysTab ctx={ready} />}
    </ScrollView>
  );
}
