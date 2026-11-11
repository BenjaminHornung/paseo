import type { TaskStatus } from "./status.ts";

interface DecisionDetail {
  id: string;
  source: string;
  result: string | null;
  response: string | null;
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
  const detail = input.detail?.id === input.latestId ? input.detail : undefined;
  if (!detail || detail.source === "pending")
    return { status: "Decision ausstehend.", summary: "" };
  let status = "Kein bestätigtes Modellergebnis";
  if (detail.source === "fallback") status = "Lokaler Controller-Fallback";
  else if (detail.source === "operator-confirmed") status = "Manuell bestätigtes Ergebnis";
  else if (detail.source === "decisions" && detail.response && detail.result)
    status = "Decision-Ergebnis";
  let summary = "";
  if (detail.result) {
    try {
      const value = JSON.parse(detail.result);
      const labels: Record<string, string> = {
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
      };
      const classification = value.intent ?? value.complexity;
      if (typeof classification === "string") summary = labels[classification] ?? classification;
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
