import { advisoryHint, advisoryOn, softCode } from "./advisory.ts";
import type { Config, Contract } from "./contracts.ts";
import type { Assessment, IntakeResult } from "./assessments.ts";
import { workflowStatus as originalWorkflowStatus } from "./automation.ts";
import {
  assertTaskAssessment as strictAssertTaskAssessment,
  currentIntake as strictCurrentIntake,
  hasAuditedOwnerApproval as strictHasAuditedOwnerApproval,
  latestDecidedIntake,
} from "./intake.ts";
import { appRoot } from "./settings-files.ts";
import type { Store } from "./store.ts";

// Facade for baseline-bound callers: they keep their identifiers and import from here.
// The original functions stay untouched and strict; this file only adds the advisory layer.
// Every soft code below is a gate that is skipped in advisory mode and recorded as a hint.
// Hard codes are not listed and rethrow unchanged, also with the switch on.

const softTaskGates = new Set([
  "INTAKE_SUPERSEDED",
  "APPROVAL_TARGET_REQUIRED",
  "INTAKE_IMPLEMENTATION_NOT_AUTHORIZED",
  "INTAKE_ROLE_NOT_AUTHORIZED",
  "PLANNER_NOT_REQUIRED",
  "ADVISOR_NOT_REQUIRED",
  "MAIN_INPUT_INTERPRETATION_REQUIRED",
  "INTAKE_HUMAN_ORIGIN_UNCONFIRMED_USE_PLUGIN_INPUT",
  "PACKAGE_CLASS_AND_TIER_MISMATCH",
  "PACKAGE_WORK_KIND_MISMATCH",
]);
const softIntakeGates = new Set([
  "INTAKE_SUPERSEDED",
  "APPROVAL_TARGET_REQUIRED",
  "INTAKE_IMPLEMENTATION_NOT_AUTHORIZED",
  "MAIN_INPUT_INTERPRETATION_REQUIRED",
  "INTAKE_HUMAN_ORIGIN_UNCONFIRMED_USE_PLUGIN_INPUT",
]);

function taskKeyOf(contract: Contract): string {
  return `${contract.workflowId}/${contract.taskId}/${contract.role}`;
}

function hintCode(kind: string): string {
  if (kind.startsWith("COMPLETION_CHECK:advisory-"))
    return kind.slice("COMPLETION_CHECK:".length).toUpperCase().replaceAll("-", "_");
  // Failure rows are `${prefix}:${CODE}:${hourBucket}`; only the code leaves the process.
  const failure = /^(TICK_FAILED|RECOVER_FAILED):([A-Z][A-Z0-9_]{1,70}):\d+$/.exec(kind);
  if (failure) return `${failure[1]}:${failure[2]}`;
  try {
    const parsed = JSON.parse(kind.slice("ADVISORY_HINT:".length)) as { code?: unknown };
    return typeof parsed.code === "string" && /^[A-Z][A-Z0-9_]{1,70}$/.test(parsed.code)
      ? parsed.code
      : "UNCLASSIFIED";
  } catch {
    return "UNCLASSIFIED";
  }
}

// Projects only the hint code and sequence, never the raw event kind or its data.
// The window keeps the scan bounded on large event logs; hints older than it are not shown.
function advisoryHints(store: Store) {
  const rows = store.db
    .prepare(
      "SELECT sequence,at_ms,kind FROM events WHERE (kind LIKE 'ADVISORY_HINT:%' OR kind LIKE 'COMPLETION_CHECK:advisory-%' OR kind LIKE 'TICK_FAILED:%' OR kind LIKE 'RECOVER_FAILED:%') AND sequence > (SELECT MAX(sequence) FROM events) - 5000 ORDER BY sequence DESC LIMIT 20",
    )
    .all() as { sequence: number; at_ms: number; kind: string }[];
  return rows.map((row) => ({
    sequence: row.sequence,
    at: row.at_ms,
    code: hintCode(row.kind),
  }));
}

export function workflowStatus(store: Store, directory: string, agentId?: string, root = appRoot) {
  const status = originalWorkflowStatus(store, directory, agentId, root);
  if (!advisoryOn()) return { ...status, advisory: { enabled: false, hints: [] } };
  return { ...status, advisory: { enabled: true, hints: advisoryHints(store) } };
}

export function assertTaskAssessment(store: Store, config: Config, contract: Contract): void {
  try {
    strictAssertTaskAssessment(store, config, contract);
  } catch (error) {
    const gate = softCode(error);
    if (!advisoryOn() || !softTaskGates.has(gate)) throw error;
    advisoryHint(store, "TASK_GATE_SKIPPED", { gate, task: taskKeyOf(contract) });
  }
}

function decidedIntakeOrUndefined(store: Store, agentId: string, forMutation: boolean) {
  try {
    return latestDecidedIntake(store, agentId, forMutation);
  } catch {
    return undefined;
  }
}

export function currentIntake(
  store: Store,
  agentId: string,
  forMutation: boolean,
): Assessment<IntakeResult> {
  try {
    return strictCurrentIntake(store, agentId, forMutation);
  } catch (error) {
    const gate = softCode(error);
    if (!advisoryOn() || !softIntakeGates.has(gate)) throw error;
    const fallback = decidedIntakeOrUndefined(store, agentId, forMutation);
    if (!fallback) throw error;
    advisoryHint(store, "INTAKE_GATE_SKIPPED", { gate, main: agentId });
    return fallback;
  }
}

export function hasAuditedOwnerApproval(store: Store, contract: Contract): boolean {
  if (strictHasAuditedOwnerApproval(store, contract)) return true;
  if (!contract.mutation || !contract.highRisk || !advisoryOn()) return false;
  advisoryHint(store, "OWNER_APPROVAL_SKIPPED", { task: taskKeyOf(contract) });
  return true;
}
