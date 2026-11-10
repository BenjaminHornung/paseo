import type { TaskStatus } from "./status";

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
