import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { canonicalPath, hash, localPath, type Contract, type RuntimeRoute } from "./contracts.ts";
import { appRoot, atomicWrite, withSettingsLock } from "./settings-files.ts";
import { Store, type TaskRow } from "./store.ts";
import { currentIntake, currentMainInput } from "./intake.ts";
import { readPackageAssessment } from "./main-interpretation.ts";

const mainSchema = z.object({
  agentId: z.string().min(1),
  directory: z.string().min(1),
  protocolVersion: z.union([z.literal(2), z.literal(3)]).optional(),
  workerPlacement: z.enum(["main-workspace", "source-workspace"]).optional(),
  state: z.enum(["off", "arming", "ready", "uncertain"]),
  requestId: z.string(),
  taskKeys: z.array(z.string()).max(1000),
  wakeCount: z.number().int().nonnegative().default(0),
  wakeBaseline: z.record(z.string(), z.string()).default({}),
  wake: z
    .object({
      fingerprint: z.string(),
      messageId: z.string(),
      state: z.enum(["sending", "sent", "uncertain"]),
    })
    .optional(),
});
const automationSchema = z.object({ mains: z.array(mainSchema).max(100) });
export type AutomationMain = z.infer<typeof mainSchema>;

export function readAutomation(root = appRoot): { mains: AutomationMain[] } {
  const file = path.join(root, "state/automation.json");
  return existsSync(file)
    ? automationSchema.parse(JSON.parse(readFileSync(file, "utf8")))
    : { mains: [] };
}
export function editAutomation(
  agentId: string,
  edit: (prior: AutomationMain | undefined) => AutomationMain,
  root = appRoot,
): AutomationMain {
  return withSettingsLock(root, () => {
    const data = readAutomation(root),
      prior = data.mains.find((main) => main.agentId === agentId);
    const next = mainSchema.parse(edit(prior));
    if (next.agentId !== agentId) throw Error("AUTOMATION_IDENTITY_CHANGED");
    data.mains = [...data.mains.filter((main) => main.agentId !== agentId), next];
    automationSchema.parse(data);
    atomicWrite(path.join(root, "state/automation.json"), JSON.stringify(data));
    return next;
  });
}
export function automaticTaskKeys(root = appRoot): string[] {
  return readAutomation(root)
    .mains.filter(
      (main) =>
        main.state === "ready" &&
        main.wake?.state !== "sending" &&
        main.wake?.state !== "uncertain",
    )
    .flatMap((main) => main.taskKeys);
}
export function taskDispatchAllowed(key: string, root = appRoot): boolean {
  return !key.startsWith("auto-") || automaticTaskKeys(root).includes(key);
}
export function requireAutomaticMain(
  agentId: string,
  directory: string,
  root = appRoot,
): AutomationMain {
  const main = readAutomation(root).mains.find((main) => main.agentId === agentId);
  if (
    !main ||
    main.state !== "ready" ||
    main.wake?.state === "sending" ||
    main.wake?.state === "uncertain" ||
    canonicalPath(main.directory) !== canonicalPath(localPath(directory))
  )
    throw Error("AUTOMATION_NOT_READY");
  return main;
}
export function automaticWorkflowId(agentId: string, workflowId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(workflowId)) throw Error("AUTOMATION_WORKFLOW_ID_INVALID");
  return `auto-${hash(agentId).slice(0, 12)}-${workflowId}`;
}
export function mainForRequest(requestKey: string, root = appRoot): string | undefined {
  const owners = readAutomation(root).mains.filter((main) =>
    main.taskKeys.some((key) => requestKey.startsWith(`${key}/`)),
  );
  if (owners.length > 1) throw Error("AUTOMATION_PARENT_AMBIGUOUS");
  return owners[0]?.agentId;
}
export function claimMainWake(
  agentId: string,
  activationId: string,
  fingerprint: string,
  messageId: string,
  root = appRoot,
): boolean {
  let claimed = false;
  editAutomation(
    agentId,
    (main) => {
      if (!main || main.state !== "ready" || main.requestId !== activationId)
        throw Error("AUTOMATION_NOT_READY");
      if (main.wake?.state === "sending" || main.wake?.state === "uncertain")
        return { ...main, state: "uncertain" };
      if (main.wake?.fingerprint === fingerprint) return main;
      claimed = true;
      return {
        ...main,
        wakeCount: main.wakeCount + 1,
        wake: { fingerprint, messageId, state: "sending" },
      };
    },
    root,
  );
  return claimed;
}
export function settleMainWake(agentId: string, messageId: string, sent: boolean, root = appRoot) {
  return editAutomation(
    agentId,
    (main) => {
      if (!main || main.wake?.messageId !== messageId) throw Error("AUTOMATION_WAKE_CHANGED");
      return {
        ...main,
        state: !sent && main.state === "ready" ? "uncertain" : main.state,
        wake: { ...main.wake, state: sent ? "sent" : "uncertain" },
      };
    },
    root,
  );
}
export function mainProgress(store: Store, main: AutomationMain) {
  const changes = main.taskKeys.flatMap((key) => {
    const task = store.task(key);
    if (
      !task ||
      !["COMPLETE", "REWORK", "BLOCKED", "FAILED", "NEEDS_CONFIRMATION", "PERMISSION"].includes(
        task.state,
      )
    )
      return [];
    const attempt = store.latest(key);
    const review = attempt
      ? (store.db.prepare("SELECT state FROM review_runs WHERE attempt_id=?").get(attempt.id) as
          | { state: string }
          | undefined)
      : undefined;
    const activitySequence = taskActivitySequence(store, attempt?.id);
    const item = {
      key,
      state: task.state,
      agentId: attempt?.agent_id ?? null,
      review: review?.state ?? null,
      activitySequence,
    };
    return main.wakeBaseline[key] ===
      JSON.stringify([item.state, item.agentId, item.review, item.activitySequence])
      ? []
      : [item];
  });
  // The fingerprint covers every assigned task, independent of UI/history limits.
  return { fingerprint: hash(changes), changes: changes.slice(0, 20), total: changes.length };
}
// Dispatch/continuation boundaries identify new work. Provider RUNNING snapshots
// are deliberately excluded: a flaky connection must not manufacture new wakes.
export function taskActivitySequence(store: Store, attemptId?: string): number {
  if (!attemptId) return 0;
  return (
    store.db
      .prepare(`SELECT COALESCE(MAX(sequence),0) AS sequence FROM events WHERE attempt_id=?
    AND kind IN ('SEND_BEGIN','AGENT_BOUND','CONTINUATION_BEGIN','OPERATOR_SAME_WRITER_MXC_RECOVERY','OPERATOR_BUILD_ENVIRONMENT_READY')`)
      .get(attemptId) as { sequence: number }
  ).sequence;
}

// Project only known fields. Never send prompts, check output, provider errors,
// attestations or arbitrary event strings to a client or a model-visible row.
export function workflowStatus(store: Store, directory: string, agentId?: string, root = appRoot) {
  const selected = canonicalPath(localPath(directory));
  const mains = readAutomation(root).mains;
  const directoryMains = mains.filter((main) => canonicalPath(main.directory) === selected);
  const activeMains = directoryMains.filter((main) => main.state !== "off");
  const candidates = activeMains.length ? activeMains : directoryMains;
  if (!agentId) {
    if (candidates.length === 1) agentId = candidates[0].agentId;
  }
  const automation = mains.find((main) => main.agentId === agentId);
  if (automation && canonicalPath(automation.directory) !== selected)
    throw Error("AUTOMATION_DIRECTORY_MISMATCH");
  const assignedKeys = new Set<string>();
  for (const main of mains) {
    if (agentId && main.agentId !== agentId) continue;
    try {
      if (canonicalPath(main.directory) === selected)
        main.taskKeys.forEach((key) => assignedKeys.add(key));
    } catch {
      /* An unrelated removed workspace does not hide this workspace's status. */
    }
  }
  const rows = store.db
    .prepare("SELECT * FROM tasks ORDER BY rowid DESC LIMIT 1000")
    .all() as unknown as TaskRow[];
  const tasks = rows
    .flatMap((row) => {
      const c = JSON.parse(row.contract_json) as Contract;
      try {
        if (
          !assignedKeys.has(row.key) &&
          canonicalPath(c.repository) !== selected &&
          canonicalPath(c.worktree) !== selected
        )
          return [];
      } catch {
        return [];
      }
      const a = store.latest(row.key);
      const r = a ? (JSON.parse(a.route_json) as RuntimeRoute) : null;
      const review = a
        ? (store.db
            .prepare("SELECT state,agent_id,route_json FROM review_runs WHERE attempt_id=?")
            .get(a.id) as
            | { state: string; agent_id: string | null; route_json: string }
            | undefined)
        : undefined;
      const reviewer = review ? (JSON.parse(review.route_json) as RuntimeRoute) : undefined;
      const checks = a
        ? (store.db.prepare("SELECT result_json FROM turn_checks WHERE attempt_id=?").get(a.id) as
            | { result_json: string }
            | undefined)
        : undefined;
      const result = checks ? JSON.parse(checks.result_json) : null;
      const planning =
        a && c.role === "planner"
          ? (store.db.prepare("SELECT evidence_json FROM reviews WHERE attempt_id=?").get(a.id) as
              | { evidence_json: string }
              | undefined)
          : undefined;
      const plan = planning ? JSON.parse(planning.evidence_json).plan : undefined;
      const events = a
        ? (store.db
            .prepare(
              "SELECT MAX(sequence) AS sequence,MAX(at_ms) AS at_ms,kind FROM events WHERE attempt_id=? GROUP BY kind ORDER BY sequence DESC LIMIT 12",
            )
            .all(a.id) as { sequence: number; at_ms: number; kind: string }[])
        : [];
      const routing = a
        ? (store.db
            .prepare(
              "SELECT kind FROM events WHERE attempt_id=? AND kind LIKE 'ROUTING_DETAIL:%' ORDER BY sequence DESC LIMIT 1",
            )
            .get(a.id) as { kind: string } | undefined)
        : undefined;
      const detail = routing
        ? (JSON.parse(routing.kind.slice("ROUTING_DETAIL:".length)) as {
            reason: string;
            source: string;
            confidence?: number;
          })
        : null;
      const classified = c.packageAssessmentId
        ? (store.db
            .prepare("SELECT result_json FROM assessments WHERE id=?")
            .get(c.packageAssessmentId) as { result_json: string | null } | undefined)
        : undefined;
      const assessment =
        classified && c.packageAssessmentId
          ? readPackageAssessment(store, c.packageAssessmentId)
          : undefined;
      return [
        {
          key: row.key,
          taskId: c.taskId,
          role: c.role,
          state: row.state,
          objective: /(?:api.?key|password|secret|token|connection.?string)\s*[:=]/i.test(
            c.acceptance[0],
          )
            ? undefined
            : c.acceptance[0].slice(0, 300),
          attemptState: a?.status ?? null,
          agentId: a?.agent_id ?? null,
          errorKind: a?.error_kind ?? null,
          completionReason: a ? store.completionReason(a.id) : null,
          route: r
            ? { name: r.name ?? r.profileName ?? r.id, model: r.model, reasoning: r.reasoning }
            : null,
          routing: detail,
          review: review
            ? {
                state: review.state,
                agentId: review.agent_id,
                model: reviewer?.model ?? "",
                reasoning: reviewer?.reasoning ?? "",
              }
            : null,
          checks: result
            ? {
                build: result.build.exit,
                test: result.test.exit,
                diff: result.diffCheckExit,
                scopeViolations: result.scopeViolations,
                changed: result.changed,
              }
            : null,
          events: events
            .filter((event) => /^[A-Z_]{1,64}$/.test(event.kind))
            .map((event) => ({ sequence: event.sequence, at: event.at_ms, kind: event.kind })),
          automatic: assignedKeys.has(row.key),
          classification: assessment
            ? { ...assessment.result, source: assessment.source, reason: assessment.reason }
            : undefined,
          plan: plan ?? undefined,
        },
      ];
    })
    .slice(0, 40);
  const mainInput = agentId ? currentMainInput(store, agentId) : undefined;
  const row = mainInput
    ? (store.db
        .prepare("SELECT facts_json,result_json FROM assessments WHERE id=? AND kind='intake'")
        .get(mainInput.intakeId) as { facts_json: string; result_json: string | null } | undefined)
    : undefined;
  let assessment = row?.result_json ? JSON.parse(row.result_json) : undefined;
  if (agentId) {
    try {
      assessment = currentIntake(store, agentId, false);
    } catch {
      /* Show the persisted diagnostic while intake is pending. */
    }
  }
  const intake = assessment
    ? {
        ...assessment.result,
        source: assessment.source,
        reason: assessment.reason,
        origin: JSON.parse(row!.facts_json).origin,
      }
    : undefined;
  let writeAuthorization: { allowed: boolean; reason: string } | undefined;
  if (agentId) {
    try {
      if (automation?.state !== "ready") throw Error("AUTOMATION_NOT_READY");
      if (store.stopped()) throw Error("GLOBAL_DISPATCH_PAUSED");
      currentIntake(store, agentId, true);
      writeAuthorization = { allowed: true, reason: "AUTHORIZED_INPUT" };
    } catch (error) {
      writeAuthorization = {
        allowed: false,
        reason:
          error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
            ? error.message
            : "INTAKE_CLASSIFICATION_REQUIRED",
      };
    }
  }
  return {
    at: Date.now(),
    mainAgentId: agentId,
    mainAgents: candidates.map((main) => ({ agentId: main.agentId, state: main.state })),
    automation: automation?.state ?? "off",
    dispatchPaused: store.stopped(),
    tasks,
    intake,
    writeAuthorization,
    mainInput,
    repositoryScope: { directory: selected, includesDescendants: true },
    historyLimited: tasks.length === 40 || rows.length === 1000,
  };
}
