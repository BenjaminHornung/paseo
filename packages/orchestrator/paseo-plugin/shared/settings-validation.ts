import type { ControllerConfig, Route } from "./settings.ts";
import { reasoningOptions } from "./routes.ts";
import { workCategorySchema, type WorkCategory } from "./work-categories.ts";

/** Field key to a concrete German message. An empty record means the config can be saved. */
export type SettingsErrors = Record<string, string>;

const isDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validDay = (value: string) => Number.isFinite(Date.parse(value));
const claudeProviders = new Set(["claude", "claude-private"]);

function rangeError(
  errors: SettingsErrors,
  key: string,
  value: number,
  min: number,
  max: number,
  message: string,
  integer = false,
) {
  if (!Number.isFinite(value)) errors[key] = "Bitte eine Zahl eingeben.";
  else if (integer && !Number.isInteger(value))
    errors[key] = `Nur ganze Zahlen erlaubt. ${message}`;
  else if (value < min || value > max) errors[key] = message;
}

function routeErrors(errors: SettingsErrors, r: Route, config: ControllerConfig) {
  const at = (field: string) => `route:${r.id}:${field}`;
  if (r.name !== undefined && (!r.name.trim() || r.name.trim().length > 120))
    errors[at("name")] = "Der Routenname darf nicht leer und höchstens 120 Zeichen lang sein.";
  rangeError(errors, at("tier"), r.tier, 1, 3, "Die Qualitätsstufe muss 1, 2 oder 3 sein.", true);
  rangeError(
    errors,
    at("maxConcurrent"),
    r.maxConcurrent,
    1,
    10,
    "Parallel sind 1 bis 10 Aufträge erlaubt.",
    true,
  );
  if (!reasoningOptions.includes(r.reasoning))
    errors[at("reasoning")] = "Diese Reasoning-Stufe ist unbekannt.";
  else if (!claudeProviders.has(r.provider) && ["", "off", "ultracode"].includes(r.reasoning))
    errors[at("reasoning")] =
      "Für diesen Provider muss eine konkrete Reasoning-Stufe (low bis max) gewählt sein.";
  if (!r.capabilities.length)
    errors[at("capabilities")] = "Mindestens Programmieren oder Textaufgaben muss aktiv sein.";
  if (r.maxTaskMicroUsd !== undefined && !(r.maxTaskMicroUsd >= 10000))
    errors[at("maxTaskMicroUsd")] = "Das Tasklimit muss mindestens 0,01 USD betragen.";
  if (r.enabled && r.access === "openai-api" && !config.apiEnabled)
    errors[at("enabled")] =
      "API-Routen brauchen den aktivierten API-Coding-Worker (Tab Rollen & Modelle).";
}

function decisionErrors(errors: SettingsErrors, config: ControllerConfig, keyPresent: boolean) {
  const d = config.decisions;
  if (!d) return;
  rangeError(
    errors,
    "decisions.minConfidence",
    d.minConfidence,
    0.5,
    1,
    "Die Mindestkonfidenz muss zwischen 0,5 und 1 liegen.",
  );
  rangeError(
    errors,
    "decisions.timeoutMs",
    d.timeoutMs,
    1000,
    30000,
    "Das Timeout muss zwischen 1 und 30 Sekunden liegen.",
  );
  rangeError(
    errors,
    "decisions.maxCallMicroUsd",
    d.maxCallMicroUsd,
    1000,
    50000,
    "Das Maximum pro Aufruf muss zwischen 0,001 und 0,05 USD liegen.",
  );
  const cap = Math.min(5000000, config.budgets.decisions);
  rangeError(
    errors,
    "decisions.monthlyBudgetMicroUsd",
    d.monthlyBudgetMicroUsd,
    0,
    cap,
    `Das Decisions-Monatsbudget darf höchstens ${cap / 1000000} USD betragen (maximal 5 USD und nicht mehr als das Controller-Budget „decisions“).`,
  );
  if (!d.enabled) return;
  if (!keyPresent)
    errors["decisions.enabled"] = "Zuerst unter Keys & Budgets den Decisions-Key speichern.";
  if (!d.fundsConfirmed)
    errors["decisions.fundsConfirmed"] =
      "Decisions braucht die Bestätigung, dass Guthaben vorhanden ist.";
  if (!isDate(d.validUntil))
    errors["decisions.validUntil"] = "Bitte ein gültiges Datum im Format JJJJ-MM-TT eingeben.";
}

function fundingErrors(errors: SettingsErrors, config: ControllerConfig) {
  const f = config.apiFunding;
  if (f) {
    if (!/^\d{4}-\d{2}$/.test(f.cycle))
      errors["funding.cycle"] = "Bitte den Monat als JJJJ-MM eingeben.";
    if (!Number.isFinite(f.availableMicroUsd) || f.availableMicroUsd < 0)
      errors["funding.available"] = "Bitte einen Betrag ab 0 USD eingeben.";
  }
  if (!config.apiEnabled) return;
  if (!f?.confirmed)
    errors["funding.confirmed"] =
      "Der API-Coding-Worker braucht die bestätigte API-Guthabenfreigabe.";
  if (!f || !validDay(f.validUntil))
    errors["funding.validUntil"] = "Bitte ein gültiges Ablaufdatum im Format JJJJ-MM-TT eingeben.";
  const total = Object.values(config.budgets).reduce((sum, v) => sum + v, 0);
  if (f && total > f.availableMicroUsd)
    errors["funding.available"] =
      `Die Summe aller Controller-Budgets (${total / 1000000} USD) übersteigt die verfügbaren API-Credits.`;
}

function categoryProblem(category: WorkCategory): string {
  if (!category.label.trim()) return "Der Kategoriename darf nicht leer sein.";
  if (!category.description.trim()) return "Die Beschreibung darf nicht leer sein.";
  if (!category.routeIds.length) return "Mindestens eine Route zuordnen.";
  return "Name (max. 120), Beschreibung (max. 1000) und Routen ohne Duplikate prüfen.";
}

function referenceErrors(errors: SettingsErrors, config: ControllerConfig) {
  const known = new Set(config.routes.map((r) => r.id));
  for (const [role, ids] of Object.entries(config.roleRoutes ?? {})) {
    if (ids === undefined) continue;
    if (!ids.length && role !== "ui") errors[`role:${role}`] = "Mindestens eine Route zuordnen.";
    else if (ids.some((id) => !known.has(id)))
      errors[`role:${role}`] = "Die Zuordnung verweist auf eine nicht mehr vorhandene Route.";
  }
  const seen = new Set<string>();
  for (const category of config.workCategories ?? []) {
    const parsed = workCategorySchema.safeParse(category);
    if (!parsed.success) {
      errors[`category:${category.id}`] = categoryProblem(category);
    } else if (category.routeIds.some((id) => !known.has(id)))
      errors[`category:${category.id}`] =
        "Die Zuordnung verweist auf eine nicht mehr vorhandene Route.";
    if (seen.has(category.id)) errors[`category:${category.id}`] = "Doppelte Kategorie.";
    seen.add(category.id);
  }
}

export function validateSettings(
  config: ControllerConfig,
  options: { decisionsKeyPresent: boolean },
): SettingsErrors {
  const errors: SettingsErrors = {};
  rangeError(
    errors,
    "maxWorkflows",
    config.maxWorkflows,
    1,
    2,
    "Maximal 1 bis 2 Workflows erlaubt.",
    true,
  );
  rangeError(
    errors,
    "maxRework",
    config.maxRework,
    0,
    2,
    "Maximal 0 bis 2 Nacharbeiten erlaubt.",
    true,
  );
  for (const [key, value] of Object.entries(config.budgets))
    if (!Number.isFinite(value) || value < 0)
      errors[`budget:${key}`] = "Bitte einen Betrag ab 0 USD eingeben.";
  for (const route of config.routes) routeErrors(errors, route, config);
  decisionErrors(errors, config, options.decisionsKeyPresent);
  fundingErrors(errors, config);
  referenceErrors(errors, config);
  return errors;
}

/** First message plus a count, for the compact status line. */
export function summarizeErrors(errors: SettingsErrors): string {
  const messages = Object.values(errors);
  return messages.length > 1 ? `${messages[0]} (+${messages.length - 1} weitere)` : messages[0];
}
