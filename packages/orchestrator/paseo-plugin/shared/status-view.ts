import type { TaskStatus } from "./status.ts";

interface DecisionDetail {
  id: string;
  source: string;
  result: string | null;
  response: string | null;
  diagnostics?: string | null;
}

export const answerLabels: Record<string, string> = {
  intent: "Intention",
  needExplorer: "Recherche",
  needPlanner: "Planer",
  needAdvisor: "Advisor",
  needImplementation: "Implementierung",
  extraReviewRecommended: "Zusätzliches Review",
  complexity: "Komplexität",
  workKind: "Arbeitsart",
  additionalPlanning: "Weitere Planung",
  advisorNeeded: "Advisor",
  shouldSplit: "Paket aufteilen",
  preserveExistingWork: "Bestehenden Auftrag fortsetzen",
};
const valueLabels: Record<string, string> = {
  question: "Frage",
  status: "Status",
  "new-task": "Neuer Auftrag",
  "change-request": "Änderung",
  "review-request": "Review",
  approval: "Freigabe",
  cancel: "Abbruch",
  other: "Sonstiges",
  simple: "Einfach",
  normal: "Normal",
  complex: "Komplex",
  unknown: "Unbekannt",
  ui: "UI",
  general: "Allgemein",
};

/** The stored model answers exactly as the details modal shows them; undefined if none are usable. */
export function storedAnswers(detail: DecisionDetail): unknown[] | undefined {
  const raw = detail.response ?? detail.diagnostics;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    const answers = Array.isArray(parsed) ? parsed : parsed?.answers;
    return Array.isArray(answers) ? answers : undefined;
  } catch {
    return undefined;
  }
}

export function describeAnswer(answer: unknown) {
  const record = (answer ?? {}) as Record<string, unknown>;
  return {
    name: typeof record.name === "string" ? record.name : "Unbenannte Frage",
    refused: record.type === "refusal",
    value: record.choice ?? record.value,
    confidence: typeof record.confidence === "number" ? record.confidence : undefined,
  };
}

function currentDetail(input: {
  latestId?: string;
  detail?: DecisionDetail;
  loading: boolean;
  error: boolean;
}): DecisionDetail | undefined {
  if (input.error || input.loading || !input.latestId) return undefined;
  const detail = input.detail?.id === input.latestId ? input.detail : undefined;
  return detail?.source === "pending" ? undefined : detail;
}

export interface DecisionRow {
  key: string;
  label: string;
  /** What the model answered; `refused`/`missing` are never rendered as Nein. */
  model: string;
  confidence?: number;
  /** The controller value actually in force; undefined when the record has none for this question. */
  effective?: string;
  /** An effective Ja: this role/step is really used. */
  used: boolean;
  /** Both values are comparable and differ. */
  changed: boolean;
}

const yesNo = (value: boolean): string => (value ? "Ja" : "Nein");
const display = (value: unknown): string =>
  typeof value === "boolean" ? yesNo(value) : (valueLabels[String(value)] ?? String(value));

function modelText(refused: boolean, value: unknown): string {
  if (refused) return "Verweigert";
  return value === undefined ? "Keine Angabe" : display(value);
}

/** Model answers next to the effective controller values for the latest decision only. */
export function decisionRows(input: {
  latestId?: string;
  detail?: DecisionDetail;
  loading: boolean;
  error: boolean;
}): DecisionRow[] {
  const detail = currentDetail(input);
  const answers = detail && storedAnswers(detail);
  if (!detail) return [];
  let effective: Record<string, unknown> = {};
  try {
    effective = detail.result ? (JSON.parse(detail.result) ?? {}) : {};
  } catch {
    effective = {};
  }
  const answered = new Set<string>();
  const rows = (answers ?? []).map((answer, index) => {
    const { name, refused, value, confidence } = describeAnswer(answer);
    answered.add(name);
    const final = effective[name];
    const comparable = !refused && value !== undefined && final !== undefined;
    return {
      key: `${name}-${index}`,
      label: answerLabels[name] ?? name,
      model: modelText(refused, value),
      confidence,
      effective: final === undefined ? undefined : display(final),
      used: final === true,
      changed: comparable && value !== final,
    };
  });
  // Effective choices without a named model answer (e.g. a nameless refusal) stay visible.
  const unanswered = Object.keys(effective).filter(
    (name) => name in answerLabels && !answered.has(name),
  );
  return [
    ...rows,
    ...unanswered.map((name) => ({
      key: `${name}-effective`,
      label: answerLabels[name],
      model: "Keine Angabe",
      effective: display(effective[name]),
      used: effective[name] === true,
      changed: false,
    })),
  ];
}

export function decisionView(input: {
  latestId?: string;
  detail?: DecisionDetail;
  loading: boolean;
  error: boolean;
}): { status: string; summary: string } {
  if (input.error) return { status: "Decision konnte nicht geladen werden.", summary: "" };
  if (input.loading) return { status: "Decision wird geladen …", summary: "" };
  if (!input.latestId) return { status: "Noch keine Decision vorhanden.", summary: "" };
  const detail = currentDetail(input);
  if (!detail) return { status: "Decision ausstehend.", summary: "" };
  let status = "Kein bestätigtes Modellergebnis";
  if (detail.source === "fallback") status = "Lokaler Controller-Fallback";
  else if (detail.source === "main") status = "Vom Hauptagenten eingeordnet";
  else if (detail.source === "operator-confirmed") status = "Manuell bestätigtes Ergebnis";
  else if (detail.source === "decisions" && detail.response && detail.result)
    status = "Decision-Ergebnis";
  let summary = "";
  if (detail.result) {
    try {
      const value = JSON.parse(detail.result);
      const classification = value.intent ?? value.complexity;
      if (typeof classification === "string")
        summary = valueLabels[classification] ?? classification;
      summary = [valueLabels[value.workKind], summary].filter(Boolean).join(" · ");
      const actions = [
        ["needExplorer", "Recherche"],
        ["needPlanner", "Planung"],
        ["additionalPlanning", "Planung"],
        ["needAdvisor", "Advisor"],
        ["advisorNeeded", "Advisor"],
        ["needImplementation", "Umsetzung"],
        ["shouldSplit", "Aufteilen"],
        ["extraReviewRecommended", "Zusätzliches Review"],
      ]
        .filter(([key]) => value[key] === true)
        .map(([, label]) => label);
      if (actions.length) summary += (summary ? " · " : "") + [...new Set(actions)].join(", ");
    } catch {
      summary = "";
    }
  }
  return { status, summary };
}

export function checksPassed(task: TaskStatus): boolean {
  const checks = task.checks;
  return (
    !!checks &&
    checks.build === 0 &&
    checks.test === 0 &&
    checks.diff === 0 &&
    checks.scopeViolations === 0 &&
    !checks.changed
  );
}

export function needsAttention(task: TaskStatus): boolean {
  return (
    ["NEEDS_CONFIRMATION", "PERMISSION", "UNKNOWN", "BLOCKED", "FAILED"].includes(task.state) ||
    ["NEEDS_CONFIRMATION", "PERMISSION", "UNKNOWN"].includes(task.attemptState ?? "")
  );
}

export function currentTask(tasks: TaskStatus[]): TaskStatus | undefined {
  return (
    tasks.find(needsAttention) ??
    tasks.find(
      (task) =>
        task.state !== "COMPLETE" &&
        (!["READY", "BLOCKED"].includes(task.state) || task.attemptState === "VERIFY"),
    ) ??
    tasks.find((task) => task.state !== "COMPLETE") ??
    tasks[0]
  );
}

export function taskLabel(task: TaskStatus, phaseLabel: Readonly<Record<string, string>>): string {
  if (
    task.state === "NEEDS_CONFIRMATION" &&
    task.completionReason === "process-coverage-unavailable"
  )
    return "Worker-Turn beendet · Prozessnachweis fehlt";
  if (
    task.state === "NEEDS_CONFIRMATION" &&
    task.events.some((event) => event.kind === "VISUAL_ACCEPTANCE_REQUIRED")
  ) {
    return phaseLabel.VISUAL_ACCEPTANCE_REQUIRED;
  }
  const label = phaseLabel[task.state] ?? task.state;
  return task.attemptState === "VERIFY" && !["VERIFY", "COMPLETE"].includes(task.state)
    ? `Review · ${label}`
    : label;
}

export function workerNeedsReconciliation(
  task: TaskStatus,
  worker: { status: string; lastActivityAt: string } | null | undefined,
  now: number,
): boolean {
  return (
    !!worker &&
    worker.status === "idle" &&
    ["RUNNING", "SENDING"].includes(task.state) &&
    Number.isFinite(Date.parse(worker.lastActivityAt)) &&
    now - Date.parse(worker.lastActivityAt) > 120000
  );
}

// A completed turn is not verified work. Old checks cannot advance a rework attempt.
export function taskPhases(task: TaskStatus): ("waiting" | "active" | "done")[] {
  if (task.state === "COMPLETE") return ["done", "done", "done"];
  if (task.state === "READY" || ["INTENT", "SENDING"].includes(task.attemptState ?? ""))
    return ["waiting", "waiting", "waiting"];
  if (task.state === "REWORK" || task.attemptState !== "VERIFY")
    return ["active", "waiting", "waiting"];
  return checksPassed(task) ? ["done", "done", "active"] : ["done", "active", "waiting"];
}
