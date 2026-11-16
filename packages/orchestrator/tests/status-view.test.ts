import { strict as assert } from "node:assert";
import { test } from "node:test";
import { removeRoute } from "../paseo-plugin/shared/routes.ts";
import type { ControllerConfig, Route } from "../paseo-plugin/shared/settings.ts";
import { validateSettings } from "../paseo-plugin/shared/settings-validation.ts";
import { decisionRows, decisionView } from "../paseo-plugin/shared/status-view.ts";

test("latest decision shows the effective result and never substitutes an older result", () => {
  const detail = {
    id: "new",
    source: "decisions",
    response: "saved response",
    result: JSON.stringify({ intent: "new-task", needImplementation: true }),
  };
  assert.deepEqual(decisionView({ latestId: "new", detail, loading: false, error: false }), {
    status: "Decision-Ergebnis",
    summary: "Neuer Auftrag · Umsetzung",
  });
  assert.deepEqual(decisionView({ latestId: "newer", detail, loading: false, error: false }), {
    status: "Decision ausstehend.",
    summary: "",
  });
});

test("fallback, pending and errors cannot appear as a successful model decision", () => {
  const detail = {
    id: "new",
    source: "fallback",
    response: null,
    result: JSON.stringify({ complexity: "unknown" }),
  };
  assert.deepEqual(decisionView({ latestId: "new", detail, loading: false, error: false }), {
    status: "Lokaler Controller-Fallback",
    summary: "Unbekannt",
  });
  assert.deepEqual(
    decisionView({
      latestId: "new",
      detail: { ...detail, source: "pending" },
      loading: false,
      error: false,
    }),
    { status: "Decision ausstehend.", summary: "" },
  );
  assert.deepEqual(decisionView({ latestId: "new", detail, loading: false, error: true }), {
    status: "Decision konnte nicht geladen werden.",
    summary: "",
  });
});

const answers = [
  { name: "intent", type: "choice", choice: "new-task", confidence: 0.51 },
  { name: "needPlanner", type: "choice", choice: false, confidence: 0.98 },
  { name: "needImplementation", type: "choice", choice: true, confidence: 0.44 },
  { name: "needAdvisor", type: "refusal" },
];

test("rows keep the model answer apart from the effective controller value", () => {
  const detail = {
    id: "new",
    source: "fallback",
    response: null,
    diagnostics: JSON.stringify({ answers }),
    result: JSON.stringify({
      intent: "other",
      needPlanner: true,
      needImplementation: false,
      needAdvisor: false,
    }),
  };
  const rows = decisionRows({ latestId: "new", detail, loading: false, error: false });
  const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
  assert.deepEqual(
    [byLabel.Planer.model, byLabel.Planer.effective, byLabel.Planer.used, byLabel.Planer.changed],
    ["Nein", "Ja", true, true],
  );
  assert.deepEqual(
    [
      byLabel.Implementierung.model,
      byLabel.Implementierung.effective,
      byLabel.Implementierung.used,
    ],
    ["Ja", "Nein", false],
  );
  assert.equal(byLabel.Implementierung.confidence, 0.44);
  assert.deepEqual(
    [byLabel.Intention.model, byLabel.Intention.effective, byLabel.Intention.changed],
    ["Neuer Auftrag", "Sonstiges", true],
  );
  // A refusal is neither a Nein nor a comparable override.
  assert.deepEqual([byLabel.Advisor.model, byLabel.Advisor.changed], ["Verweigert", false]);
});

test("rows of identical answers are unchanged, and stale or pending details have none", () => {
  const detail = {
    id: "new",
    source: "decisions",
    response: JSON.stringify({ answers: [answers[2]] }),
    result: JSON.stringify({ needImplementation: true }),
  };
  const [row] = decisionRows({ latestId: "new", detail, loading: false, error: false });
  assert.deepEqual([row.used, row.changed], [true, false]);
  assert.deepEqual(decisionRows({ latestId: "newer", detail, loading: false, error: false }), []);
  assert.deepEqual(
    decisionRows({
      latestId: "new",
      detail: { ...detail, source: "pending" },
      loading: false,
      error: false,
    }),
    [],
  );
});

test("a nameless refusal cannot hide the effective roles the controller selected", () => {
  const detail = {
    id: "new",
    source: "fallback",
    response: null,
    diagnostics: JSON.stringify({ answers: [{ type: "refusal", name: null }] }),
    result: JSON.stringify({ intent: "other", needPlanner: true, preserveExistingWork: true }),
  };
  const rows = decisionRows({ latestId: "new", detail, loading: false, error: false });
  const planner = rows.find((row) => row.label === "Planer");
  assert.deepEqual(
    [planner?.model, planner?.effective, planner?.used],
    ["Keine Angabe", "Ja", true],
  );
  assert.equal(planner?.changed, false);
  assert.equal(rows.find((row) => row.label === "Bestehenden Auftrag fortsetzen")?.used, true);
});

const route = (id: string): Route => ({
  id,
  access: "codex-pro200",
  provider: "codex",
  model: "m",
  revision: "r",
  reasoning: "high",
  tier: 2,
  enabled: true,
  maxConcurrent: 1,
  capabilities: ["code"],
});
const settings = (): ControllerConfig => ({
  schemaVersion: 1,
  daemonUrl: "ws://127.0.0.1:1/ws",
  gitExecutable: "git",
  maxWorkflows: 2,
  maxRework: 2,
  apiEnabled: false,
  liveDispatchApproved: false,
  roleRoutes: {
    planner: ["a", "b"],
    advisor: ["a"],
    "implement-simple": ["a"],
    "implement-normal": ["a"],
    "implement-complex": ["a"],
    reviewer: ["a"],
    ui: ["a"],
  },
  workCategories: [{ id: "db", label: "DB", description: "Datenbank", routeIds: ["a"] }],
  routes: [route("a"), route("b")],
  budgets: { decisions: 0, implementation: 0, "premium-api": 0, emergency: 0 },
});

test("deleting a referenced route removes references and falls back to the next route", () => {
  const next = removeRoute(settings(), "a");
  assert.deepEqual(
    next.routes.map((r) => r.id),
    ["b"],
  );
  assert.deepEqual(next.roleRoutes?.planner, ["b"]);
  assert.deepEqual(next.roleRoutes?.reviewer, ["b"]);
  assert.equal(next.roleRoutes?.ui, undefined, "UI falls back to default routing");
  assert.deepEqual(next.workCategories?.[0].routeIds, ["b"]);
  assert.deepEqual(validateSettings(next, { decisionsKeyPresent: false }), {});
  assert.equal(removeRoute(next, "b"), next, "the last route cannot be deleted");
});

test("validation reports concrete messages per field and accepts a valid config", () => {
  assert.deepEqual(validateSettings(settings(), { decisionsKeyPresent: false }), {});
  const bad = settings();
  bad.maxRework = 5;
  bad.routes[0].maxConcurrent = Number.NaN;
  bad.decisions = {
    enabled: true,
    model: "gpt-6-luna",
    roles: [],
    minConfidence: 0.8,
    timeoutMs: 10000,
    monthlyBudgetMicroUsd: 5000000,
    maxCallMicroUsd: 1000,
    fundsConfirmed: false,
    validUntil: "",
    projectId: "",
  };
  const errors = validateSettings(bad, { decisionsKeyPresent: false });
  assert.match(errors.maxRework, /0 bis 2/);
  assert.match(errors["route:a:maxConcurrent"], /Zahl/);
  assert.match(errors["decisions.monthlyBudgetMicroUsd"], /höchstens 0 USD/);
  assert.match(errors["decisions.enabled"], /Key/);
  assert.match(errors["decisions.fundsConfirmed"], /Guthaben/);
  assert.match(errors["decisions.validUntil"], /JJJJ-MM-TT/);
});

test("assigning a route to UI or a category never invalidates an otherwise valid config", () => {
  const config = settings();
  config.roleRoutes = { ...config.roleRoutes!, ui: ["b", "a"] };
  assert.deepEqual(validateSettings(config, { decisionsKeyPresent: false }), {});
});
