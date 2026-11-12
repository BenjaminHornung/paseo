import { useCallback, useEffect, useMemo, useState } from "react";
import { View, type ViewStyle } from "react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import {
  roles,
  routingCategories,
  type ControllerConfig,
  type RoutingCategory,
} from "../shared/settings";
import { createWorkCategory, type WorkCategory } from "../shared/work-categories";
import { routeLabel } from "../shared/routes";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { CompactAction } from "./compact-action";

const roleLabels: Record<RoutingCategory, string> = {
  planner: "Planung",
  advisor: "Beratung",
  "implement-simple": "Kleine Implementierung",
  "implement-normal": "Normale Implementierung",
  "implement-complex": "Komplexe Implementierung",
  reviewer: "Unabhängiges Review",
  ui: "UI-Implementierung",
};
type Change = (update: (config: ControllerConfig) => ControllerConfig) => void;
const emptyPreference: string[] = [];
const routeActionsStyle: ViewStyle = {
  flexDirection: "row",
  flexWrap: "wrap",
  gap: 4,
  alignItems: "center",
};

function NewWorkCategory({ config, onChange }: { config: ControllerConfig; onChange: Change }) {
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [routeId, setRouteId] = useState("");
  const [generation, setGeneration] = useState(0);
  const options = useMemo(
    () => [
      { value: "", label: "Route auswählen" },
      ...config.routes.map((route) => ({ value: route.id, label: routeLabel(route) })),
    ],
    [config.routes],
  );
  const create = useCallback(() => {
    const category = createWorkCategory(label, description, routeId, config.workCategories ?? []);
    onChange((current) => ({
      ...current,
      workCategories: [...(current.workCategories ?? []), category],
    }));
    setLabel("");
    setDescription("");
    setRouteId("");
    setGeneration((value) => value + 1);
  }, [label, description, routeId, config.workCategories, onChange]);
  return (
    <SettingsSection
      title="Arbeitskategorie anlegen"
      info="Zum Beispiel Datenbank oder UI. Name und Beschreibung helfen dem Hauptagenten und Decisions bei der Einordnung; die Modellreihenfolge gilt unabhängig von der Komplexität."
    >
      <SettingsCard>
        <SettingsInput
          key={`name-${generation}`}
          label="Neue Kategorie"
          initialValue=""
          onChangeText={setLabel}
        />
        <SettingsInput
          key={`description-${generation}`}
          label="Neue Beschreibung"
          initialValue=""
          onChangeText={setDescription}
        />
        <SettingsSelect
          label="Primäre Route"
          value={routeId}
          options={options}
          onValueChange={setRouteId}
        />
        <SettingsAction
          label="Neue Arbeitskategorie"
          actionLabel="Kategorie anlegen"
          disabled={
            !label.trim() ||
            !description.trim() ||
            !routeId ||
            label.length > 120 ||
            description.length > 1000
          }
          onPress={create}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function CategoryDetails({
  category,
  generation,
  update,
  remove,
}: {
  category: WorkCategory;
  generation: number;
  update: (patch: Partial<WorkCategory>) => void;
  remove: () => void;
}) {
  const updateLabel = useCallback((label: string) => update({ label }), [update]);
  const updateDescription = useCallback((description: string) => update({ description }), [update]);
  return (
    <>
      <SettingsInput
        key={`${generation}:${category.id}:label`}
        label="Kategoriename"
        initialValue={category.label}
        onChangeText={updateLabel}
      />
      <SettingsInput
        key={`${generation}:${category.id}:description`}
        label="Beschreibung"
        initialValue={category.description}
        onChangeText={updateDescription}
      />
      <SettingsAction
        label="Kategorie und ihre Modellzuordnung entfernen"
        actionLabel="Kategorie löschen"
        onPress={remove}
      />
    </>
  );
}

function PreferenceRow({
  config,
  preference,
  required,
  setPreference,
  id,
  index,
  theme,
}: {
  config: ControllerConfig;
  preference: string[];
  required: boolean;
  setPreference: (ids: string[]) => void;
  id: string;
  index: number;
  theme: PluginSurfaceProps["theme"];
}) {
  const move = useCallback(
    (offset: number) => {
      const next = [...preference];
      [next[index], next[index + offset]] = [next[index + offset], next[index]];
      setPreference(next);
    },
    [preference, index, setPreference],
  );
  const up = useCallback(() => move(-1), [move]);
  const down = useCallback(() => move(1), [move]);
  const remove = useCallback(
    () => setPreference(preference.filter((value) => value !== id)),
    [setPreference, preference, id],
  );
  return (
    <SettingsRow
      label={`${index + 1}. ${index === 0 ? "Primär" : "Fallback"}`}
      hint={routeLabel(config.routes.find((route) => route.id === id)!)}
    >
      <View style={routeActionsStyle}>
        <CompactAction label="Nach oben" theme={theme} disabled={index === 0} onPress={up} />
        <CompactAction
          label="Nach unten"
          theme={theme}
          disabled={index === preference.length - 1}
          onPress={down}
        />
        <CompactAction
          label="Entfernen"
          theme={theme}
          disabled={required && preference.length === 1}
          onPress={remove}
        />
      </View>
    </SettingsRow>
  );
}

function PreferenceOrder({
  config,
  preference,
  required,
  setPreference,
  theme,
}: {
  config: ControllerConfig;
  preference: string[];
  required: boolean;
  setPreference: (ids: string[]) => void;
  theme: PluginSurfaceProps["theme"];
}) {
  const options = useMemo(
    () => [
      { label: "Route auswählen", value: "" },
      ...config.routes
        .filter((route) => !preference.includes(route.id))
        .map((route) => ({ value: route.id, label: routeLabel(route) })),
    ],
    [config.routes, preference],
  );
  const add = useCallback(
    (id: string) => {
      if (id) setPreference([...preference, id]);
    },
    [preference, setPreference],
  );
  return (
    <>
      {preference.map((id, index) => (
        <PreferenceRow
          key={id}
          config={config}
          preference={preference}
          required={required}
          setPreference={setPreference}
          id={id}
          index={index}
          theme={theme}
        />
      ))}
      <SettingsSelect label="Route hinzufügen" value="" options={options} onValueChange={add} />
    </>
  );
}

export function RoutingPreferences({
  config,
  onChange,
  generation,
  theme,
}: {
  config: ControllerConfig;
  onChange: Change;
  generation: number;
  theme: PluginSurfaceProps["theme"];
}) {
  const [selection, setSelection] = useState("planner");
  const category = config.workCategories?.find((item) => `category:${item.id}` === selection);
  const role = routingCategories.find((value) => value === selection) ?? "planner";
  useEffect(() => {
    if (selection.startsWith("category:") && !category) setSelection("planner");
  }, [selection, category]);
  const preference = category?.routeIds ?? config.roleRoutes?.[role] ?? emptyPreference;
  const updateCategory = useCallback(
    (patch: Partial<WorkCategory>) =>
      onChange((current) => ({
        ...current,
        workCategories: current.workCategories?.map((item) =>
          item.id === category?.id ? { ...item, ...patch } : item,
        ),
      })),
    [onChange, category?.id],
  );
  const setPreference = useCallback(
    (ids: string[]) => {
      if (category) {
        updateCategory({ routeIds: ids });
        return;
      }
      onChange((current) => ({
        ...current,
        roleRoutes: {
          ...current.roleRoutes,
          ...(Object.fromEntries(
            roles.map((value) => [value, current.roleRoutes?.[value] ?? []]),
          ) as Record<Exclude<RoutingCategory, "ui">, string[]>),
          [role]: role === "ui" && !ids.length ? undefined : ids,
        },
      }));
    },
    [category, updateCategory, onChange, role],
  );
  const removeCategory = useCallback(() => {
    onChange((current) => ({
      ...current,
      workCategories: current.workCategories?.filter((item) => item.id !== category?.id),
    }));
    setSelection("planner");
  }, [onChange, category?.id]);
  const options = useMemo(
    () => [
      ...routingCategories.map((value) => ({ value, label: roleLabels[value] })),
      ...(config.workCategories ?? []).map((item) => ({
        value: `category:${item.id}`,
        label: item.label,
      })),
    ],
    [config.workCategories],
  );
  return (
    <>
      <SettingsSection
        title="Reihenfolge je Rolle & Arbeitsart"
        info="Die erste Route ist primär; weitere werden in dieser Reihenfolge als Fallback verwendet. Laufende Aufträge behalten ihre gespeicherte Konfiguration."
      >
        <SettingsCard>
          <SettingsSelect
            label="Rolle oder Arbeitsart"
            value={category ? selection : role}
            options={options}
            onValueChange={setSelection}
          />
          {category && (
            <CategoryDetails
              category={category}
              generation={generation}
              update={updateCategory}
              remove={removeCategory}
            />
          )}
          {role === "ui" && !category && (
            <SettingsRow
              label={preference.length ? "Eigene UI-Reihenfolge" : "Standardrouting aktiv"}
              hint="Ohne Zuordnung gilt die Implementierungsklasse. Eine ausdrücklich gewählte eigene Kategorie hat Vorrang. Qualitätsstufe, Repository-Grenzen und Budget gelten weiterhin."
            />
          )}
          <PreferenceOrder
            config={config}
            preference={preference}
            required={!!category}
            setPreference={setPreference}
            theme={theme}
          />
        </SettingsCard>
      </SettingsSection>
      <NewWorkCategory config={config} onChange={onChange} />
    </>
  );
}
