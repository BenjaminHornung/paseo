import { z } from "zod";
import { decisionHistory } from "./decision-history.ts";
import { randomUUID } from "node:crypto";
import {
  configSchema,
  contractSchema,
  continuationRepairSchema,
  defaultDecisionSettings,
  hash,
  canonicalPath,
  localPath,
  type Config,
  type Contract,
  type RuntimeRoute,
} from "./contracts.ts";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { appRoot, configPath, readConfig, saveConfig, statePath } from "./settings-files.ts";
import { CredentialVault } from "./secrets.ts";
import { Decisions } from "./decisions.ts";
import { PaseoProvider } from "./provider.ts";
import { Store } from "./store.ts";
import { routePreference } from "../starter/src/policy.ts";
import {
  automaticWorkflowId,
  claimMainWake,
  settleMainWake,
  editAutomation,
  mainProgress,
  readAutomation,
  requireAutomaticMain,
  taskActivitySequence,
  workflowStatus,
} from "./automation.ts";
import { Engine } from "./engine.ts";
import { Git } from "./git.ts";
import {
  abandonHumanInput,
  approveIntakeModelAnswer,
  captureHumanIntake,
  currentIntake,
  linkApprovalToOutstandingTask,
  markIntakeClassificationPending,
  recordInternalMessage,
  timelineCheckpointIndex,
} from "./intake.ts";
import {
  effectiveImplementation,
  packageFactsSchema,
  packageIdentity,
  preservesExistingWork,
  type Classifier,
  type PackageFacts,
} from "./assessments.ts";
import { researchWithSynthesis, researchRequestSchema } from "./research.ts";
import { processMonitorFile } from "./process-monitor.ts";
import { verifiedProviderSessionId } from "./completion.ts";
import { intakeConfirmationSchema } from "../paseo-plugin/shared/intake-confirmation.ts";
import {
  mainInputInterpretationSchema,
  mainPackageDeclarationSchema,
} from "../paseo-plugin/shared/main-interpretation.ts";
import { currentMainInput, interpretMainInput, observeMainInput } from "./intake.ts";
import { legacyWorkCategories } from "../paseo-plugin/shared/work-categories.ts";
import {
  declareMainPackage,
  effectivePackageAssessment,
  mainInputInterpretation,
} from "./main-interpretation.ts";

export const settingsRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("get") }),
  z.strictObject({ operation: z.literal("auto-list") }),
  z.strictObject({
    operation: z.literal("auto-interpret"),
    agentId: z.string(),
    directory: z.string(),
    interpretation: mainInputInterpretationSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal("intake-approve"),
    agentId: z.string(),
    directory: z.string(),
    assessmentId: z.string().regex(/^[a-f0-9]{64}$/),
    messageId: z.string().min(1),
    confirmation: intakeConfirmationSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal("auto-progress"),
    agentId: z.string(),
    directory: z.string(),
  }),
  z.strictObject({
    operation: z.literal("auto-continue"),
    agentId: z.string(),
    directory: z.string(),
    key: z.string(),
    repair: continuationRepairSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal("auto-inspect-task"),
    agentId: z.string(),
    directory: z.string(),
    key: z.string(),
  }),
  z.strictObject({
    operation: z.literal("auto-intake"),
    agentId: z.string(),
    directory: z.string(),
  }),
  z.strictObject({
    operation: z.literal("auto-turn"),
    agentId: z.string(),
    directory: z.string(),
    turnId: z.string().nullable(),
  }),
  z.strictObject({
    operation: z.literal("auto-input"),
    agentId: z.string(),
    directory: z.string(),
    messageId: z.string().min(16),
    text: z.string().min(1).max(12000),
  }),
  z.strictObject({
    operation: z.literal("auto-abandon-input"),
    agentId: z.string(),
    directory: z.string(),
    messageId: z.string().min(16),
  }),
  z.strictObject({
    operation: z.literal("auto-research"),
    agentId: z.string(),
    directory: z.string(),
    request: researchRequestSchema,
  }),
  z.strictObject({
    operation: z.literal("auto-wake"),
    agentId: z.string(),
    activationId: z.string(),
    fingerprint: z.string(),
    messageId: z.string(),
  }),
  z.strictObject({
    operation: z.literal("auto-wake-settle"),
    agentId: z.string(),
    messageId: z.string(),
    sent: z.boolean(),
  }),
  z.strictObject({
    operation: z.literal("status"),
    directory: z.string(),
    agentId: z.string().optional(),
  }),
  z.strictObject({
    operation: z.literal("decision-history"),
    directory: z.string(),
    agentId: z.string().optional(),
    assessmentId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    before: z.number().int().positive().optional(),
  }),
  z.strictObject({
    operation: z.literal("auto-state"),
    agentId: z.string(),
    directory: z.string(),
    state: z.enum(["off", "arming", "ready", "uncertain"]),
    requestId: z.string(),
  }),
  z.strictObject({
    operation: z.literal("auto-task"),
    agentId: z.string(),
    directory: z.string(),
    contract: contractSchema,
    packageInterpretation: mainPackageDeclarationSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal("auto-worktree"),
    agentId: z.string(),
    directory: z.string(),
    repository: z.string().optional(),
    slug: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  }),
  z.strictObject({
    operation: z.literal("save"),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    config: configSchema,
  }),
  z.strictObject({
    operation: z.literal("credential"),
    slot: z.enum(["normal", "decisions"]),
    revision: z.string().max(100),
    key: z.string().min(20).max(1024),
  }),
  z.strictObject({
    operation: z.literal("test-decisions"),
    nonce: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  }),
  z.strictObject({ operation: z.literal("pause"), paused: z.boolean() }),
  z.strictObject({
    operation: z.literal("launch-budget"),
    requestKey: z.string().min(1),
    agentId: z.string().min(1),
    cwd: z.string().min(1),
    controllerState: z.string().optional(),
    processMonitor: z.boolean().optional(),
  }),
]);
function freezePackageRouting(store: Store, config: Config, facts: PackageFacts): PackageFacts {
  const id = packageIdentity(facts);
  const prior = store.db
    .prepare("SELECT facts_json FROM assessments WHERE id=? AND kind='package'")
    .get(id) as { facts_json: string } | undefined;
  const identity = hash({
    workCategories: config.workCategories,
    roleRoutes: config.roleRoutes,
    routes: config.routes,
  });
  if (prior) {
    const frozen = packageFactsSchema.parse(JSON.parse(prior.facts_json));
    if (
      frozen.routingConfigIdentity &&
      frozen.routingConfigIdentity !== identity &&
      !store.db.prepare("SELECT 1 FROM task_assessments WHERE package_id=?").get(id)
    )
      throw Error("PACKAGE_ROUTING_CONFIG_CHANGED_USE_NEW_TASK");
    return packageFactsSchema.parse({
      ...facts,
      ...(frozen.workCategoryCatalog ? { workCategoryCatalog: frozen.workCategoryCatalog } : {}),
      ...(frozen.routingConfigIdentity
        ? { routingConfigIdentity: frozen.routingConfigIdentity }
        : {}),
    });
  }
  return packageFactsSchema.parse({
    ...facts,
    workCategoryCatalog: [
      ...legacyWorkCategories,
      ...(config.workCategories ?? []).map((category) => ({
        id: category.id,
        label: category.label,
        description: category.description,
      })),
    ],
    routingConfigIdentity: identity,
  });
}

function automaticRepository(directory: string, repository: string, git: Git): string {
  const workspace = canonicalPath(localPath(directory)),
    selected = canonicalPath(localPath(repository));
  const relative = path.relative(workspace, selected);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    let sameRepository = false;
    try {
      const common = (cwd: string) =>
        canonicalPath(path.resolve(cwd, git.run(cwd, ["rev-parse", "--git-common-dir"])));
      sameRepository = git.isIsolatedWorkspace(workspace) && common(workspace) === common(selected);
    } catch {
      /* An unrelated or non-Git path is never authorized. */
    }
    if (!sameRepository) throw Error("AUTOMATION_REPOSITORY_MISMATCH");
  }
  try {
    if (canonicalPath(git.run(selected, ["rev-parse", "--show-toplevel"])) !== selected)
      throw Error("Repository root required");
    git.run(selected, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    throw Error("AUTOMATION_REPOSITORY_REQUIRED");
  }
  return selected;
}
function automaticWorktreePath(repository: string, agentId: string, slug: string): string {
  return path.join(
    localPath(path.dirname(repository)),
    ".worktrees",
    `${path.basename(repository)}-${hash(agentId).slice(0, 12)}-${slug}`,
  );
}
async function automaticTaskWorkspace(
  contract: Contract,
  mainWorkspace: NonNullable<Contract["workspace"]>,
  provider: PaseoProvider,
  git: Git,
): Promise<NonNullable<Contract["workspace"]>> {
  if (
    !contract.mutation ||
    canonicalPath(mainWorkspace.directory) === canonicalPath(contract.worktree)
  )
    return mainWorkspace;
  // Only the explicitly selected, main-owned worktree returned by the public
  // worktree operation may acquire a different workspace and provider cwd.
  git.validate(contract);
  if (!git.isIsolatedWorkspace(contract.worktree))
    throw Error("AUTOMATION_ISOLATED_WORKTREE_REQUIRED");
  const slug = git.run(contract.worktree, ["branch", "--show-current"]).slice("feature/".length);
  const expected = automaticWorktreePath(contract.repository, mainWorkspace.mainAgentId, slug);
  const relative = path.relative(
    localPath(path.dirname(contract.repository)),
    canonicalPath(contract.worktree),
  );
  if (
    !/^[a-zA-Z0-9_-]{1,40}$/.test(slug) ||
    !existsSync(expected) ||
    canonicalPath(expected) !== canonicalPath(contract.worktree) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw Error("AUTOMATION_WORKTREE_MISMATCH");
  const source = await provider.client.workspaces.open(contract.worktree);
  const current = await source.refresh();
  if (!current || canonicalPath(current.workspaceDirectory) !== canonicalPath(contract.worktree))
    throw Error("AUTOMATION_SOURCE_WORKSPACE_MISMATCH");
  return {
    id: source.id,
    directory: canonicalPath(contract.worktree),
    mainAgentId: mainWorkspace.mainAgentId,
  };
}
export function settingsView(store: Store, config: Config, vault = new CredentialVault()) {
  const cycle = new Date().toISOString().slice(0, 7);
  const apiUsage = store.db
    .prepare(
      "SELECT COALESCE(SUM(COALESCE(settled,reserved)),0) AS committedMicroUsd,COUNT(*) AS reservations FROM api_reservations WHERE cycle=? AND state!='RELEASED'",
    )
    .get(cycle);
  const roleRoutes =
    config.roleRoutes ??
    Object.fromEntries(
      [
        "planner",
        "advisor",
        "implement-simple",
        "implement-normal",
        "implement-complex",
        "reviewer",
      ].map((role) => [
        role,
        routePreference[role as keyof typeof routePreference].filter((id) =>
          config.routes.some((r) => r.id === id),
        ),
      ]),
    );
  return {
    revision: hash(config),
    config: { ...config, roleRoutes, decisions: config.decisions ?? defaultDecisionSettings() },
    controllerRoot: appRoot,
    credentials: { normal: vault.status("normal"), decisions: vault.status("decisions") },
    usage: new Decisions(store).usage(),
    apiUsage: { cycle, ...apiUsage },
    circuits: store.db
      .prepare(
        "SELECT access,reason,until_ms AS untilMs FROM circuits WHERE until_ms IS NULL OR until_ms>?",
      )
      .all(Date.now()),
    dispatchPaused: store.stopped(),
    activeAttempts: store.active().length,
  };
}
async function mainSettingsOperation(
  request: z.infer<typeof settingsRequestSchema>,
  context: {
    store: Store;
    config: Config;
    root: string;
    createProvider(daemonUrl: string): PaseoProvider;
  },
) {
  const { store, config, root, createProvider } = context;
  if (request.operation === "auto-list")
    return { ...readAutomation(root), daemonUrl: config.daemonUrl };
  if (request.operation === "auto-progress")
    return mainProgress(store, requireAutomaticMain(request.agentId, request.directory, root));
  if (request.operation !== "intake-approve") return;
  const main = requireAutomaticMain(request.agentId, request.directory, root);
  const provider = createProvider(config.daemonUrl);
  await provider.connect();
  try {
    // Confirmation checks public identity and the frozen input head; it never
    // captures new input or starts a Decisions request.
    await approveIntakeModelAnswer(store, provider.client, main, {
      ...request,
      reason: "User confirmed this model answer in the Decisions history",
    });
    return { approved: true, assessmentId: request.assessmentId };
  } finally {
    await provider.close();
  }
}

export async function settingsOperation(
  input: unknown,
  options: {
    file?: string;
    database?: string;
    vault?: CredentialVault;
    workspaceForMain?: (
      agentId: string,
      directory: string,
    ) => Promise<NonNullable<Contract["workspace"]>>;
    validateCatalog?: (config: Config) => Promise<void>;
    providerFactory?: (daemonUrl: string) => PaseoProvider;
    classifierFactory?: (store: Store) => Classifier;
  } = {},
): Promise<unknown> {
  const request = settingsRequestSchema.parse(input),
    file = options.file ?? configPath;
  const createProvider = (daemonUrl: string) =>
    options.providerFactory?.(daemonUrl) ?? new PaseoProvider(daemonUrl);
  let config = readConfig(file);
  let database = options.database ?? statePath;
  if (request.operation === "launch-budget") {
    const file = path.join(appRoot, "state/pi-budgets", `${hash(request.requestKey)}.json`);
    if (existsSync(file))
      database = localPath(JSON.parse(readFileSync(file, "utf8")).controllerState);
    else if (request.controllerState) database = localPath(request.controllerState);
    if (!existsSync(database)) throw Error("CONTROLLER_STATE_NOT_APPROVED");
    const relative = path.relative(
      canonicalPath(path.join(appRoot, "state")),
      canonicalPath(database),
    );
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      !/[.](?:sqlite|db)$/i.test(database)
    )
      throw Error("CONTROLLER_STATE_NOT_APPROVED");
  }
  const vault = options.vault ?? new CredentialVault(),
    store = new Store(database);
  try {
    const classifier = options.classifierFactory?.(store) ?? new Decisions(store);
    const mainOperation = await mainSettingsOperation(request, {
      store,
      config,
      root: vault.root,
      createProvider,
    });
    if (mainOperation !== undefined) return mainOperation;
    if (request.operation === "auto-continue" || request.operation === "auto-inspect-task") {
      const main = requireAutomaticMain(request.agentId, request.directory, vault.root);
      if (!main.taskKeys.includes(request.key)) throw Error("CONTINUATION_TASK_NOT_IN_MAIN");
      if (request.operation === "auto-inspect-task") {
        const task = store.task(request.key);
        if (!task) throw Error("CONTINUATION_TASK_NOT_IN_MAIN");
        const contract = contractSchema.parse(JSON.parse(task.contract_json)),
          attempt = store.latest(request.key);
        const git = new Git(config.gitExecutable, (c) => [
          ...store.scopePaths(c),
          ...store.peerAllowedPaths(c),
        ]);
        return {
          ...git.snapshot(contract),
          state: task.state,
          completionReason: attempt ? store.completionReason(attempt.id) : null,
        };
      }
      currentIntake(store, main.agentId, true);
      const provider = createProvider(config.daemonUrl);
      await provider.connect();
      try {
        return await new Engine(store, config, provider).continueExisting(
          request.key,
          request.repair,
        );
      } finally {
        await provider.close();
      }
    }
    if (request.operation === "auto-research") {
      const main = requireAutomaticMain(request.agentId, request.directory, vault.root);
      const intake = currentIntake(store, main.agentId, false);
      if (!["decisions", "main"].includes(intake.source) || !intake.result.needExplorer)
        throw Error("EXPLORER_NOT_REQUIRED");
      return await researchWithSynthesis(store, config, request.request, main.directory);
    }
    if (request.operation === "auto-interpret") {
      const main = requireAutomaticMain(request.agentId, request.directory, vault.root);
      const provider = createProvider(config.daemonUrl);
      await provider.connect();
      try {
        await observeMainInput(store, config, provider.client, main, classifier);
        const interpretation = request.interpretation
          ? interpretMainInput(store, config, main, request.interpretation)
          : undefined;
        return {
          input: currentMainInput(store, main.agentId),
          interpretation,
          workCategoryCatalog: [
            ...legacyWorkCategories,
            ...(config.workCategories ?? []).map((category) => ({
              id: category.id,
              label: category.label,
              description: category.description,
            })),
          ],
        };
      } finally {
        await provider.close();
      }
    }
    if (
      request.operation === "auto-intake" ||
      request.operation === "auto-input" ||
      request.operation === "auto-turn" ||
      request.operation === "auto-abandon-input"
    ) {
      const main = requireAutomaticMain(request.agentId, request.directory, vault.root);
      if (config.orchestrationVersion !== 3 || main.protocolVersion !== 3) return { version: 2 };
      const provider = createProvider(config.daemonUrl);
      await provider.connect();
      try {
        if (request.operation === "auto-input" || request.operation === "auto-abandon-input") {
          const snapshot = (await provider.client.agents.ref(main.agentId).refresh())?.agent;
          if (
            !snapshot ||
            canonicalPath(snapshot.cwd) !== main.directory ||
            snapshot.activeTurn ||
            snapshot.status !== "idle"
          )
            throw Error("AUTOMATION_MAIN_MUST_BE_IDLE");
          if (request.operation === "auto-abandon-input") {
            abandonHumanInput(store, main.agentId, request.messageId);
            return { version: 3, abandoned: true };
          }
          const kind = `human:${hash(request.text)}`;
          const old = store.db
            .prepare("SELECT kind FROM internal_messages WHERE agent_id=? AND message_id=?")
            .get(main.agentId, request.messageId) as { kind: string } | undefined;
          if (old && old.kind !== kind) throw Error("INPUT_IDENTITY_CHANGED");
          store.db
            .prepare("INSERT OR IGNORE INTO internal_messages VALUES(?,?,?)")
            .run(main.agentId, request.messageId, kind);
          if (!old)
            store.event(
              `HUMAN_INPUT_RECEIPT:${JSON.stringify({ agentId: main.agentId, messageId: request.messageId })}`,
            );
          return { version: 3, recorded: !old };
        }
        const assessment = await captureHumanIntake(
          store,
          config,
          provider.client,
          main,
          classifier,
        );
        if (assessment?.result.intent === "cancel") {
          const row = store.db
            .prepare("SELECT facts_json FROM assessments WHERE id=?")
            .get(assessment.id) as { facts_json: string };
          if (JSON.parse(row.facts_json).origin === "human") {
            editAutomation(main.agentId, (prior) => ({ ...prior!, state: "off" }), vault.root);
            store.event("USER_CANCELLED_NEW_STARTS");
            return { version: 3, assessment };
          }
        }
        if (request.operation === "auto-turn") {
          const timeline = await provider.client.agents
            .ref(main.agentId)
            .timeline.refetch({ direction: "tail", limit: 20 });
          const last = timeline.entries
            .map((entry) => entry.item)
            .findLast((item) => item.type === "user_message");
          const receipt =
            last?.type === "user_message"
              ? (store.db
                  .prepare("SELECT kind FROM internal_messages WHERE agent_id=? AND message_id=?")
                  .get(main.agentId, last.clientMessageId ?? last.messageId ?? "") as
                  | { kind: string }
                  | undefined)
              : undefined;
          const turnIdentity =
            request.turnId ??
            (last?.type === "user_message" ? (last.clientMessageId ?? last.messageId) : undefined);
          if (
            !timeline.error &&
            !timeline.gap &&
            turnIdentity &&
            receipt?.kind.startsWith("human:")
          )
            store.transaction(() => {
              if (
                store.db
                  .prepare("INSERT OR IGNORE INTO main_turns VALUES(?,?)")
                  .run(main.agentId, turnIdentity).changes
              )
                store.db
                  .prepare("UPDATE main_checkpoints SET turn_count=turn_count+1 WHERE agent_id=?")
                  .run(main.agentId);
            });
        }
        const checkpoint = store.db
          .prepare(
            "SELECT turn_count,reminder_count,work_intake_id,last_reminder_facts FROM main_checkpoints WHERE agent_id=?",
          )
          .get(main.agentId) as
          | {
              turn_count: number;
              reminder_count: number;
              work_intake_id: string | null;
              last_reminder_facts: string | null;
            }
          | undefined;
        const interval = config.reminderInterval ?? 8;
        let reminder: { messageId: string; text: string } | undefined;
        if (
          request.operation === "auto-intake" &&
          checkpoint?.work_intake_id &&
          checkpoint.turn_count >= (checkpoint.reminder_count + 1) * interval
        ) {
          const snapshot = (await provider.client.agents.ref(main.agentId).refresh())?.agent;
          const progress = mainProgress(store, main);
          if (
            snapshot?.status === "idle" &&
            !snapshot.activeTurn &&
            !snapshot.pendingPermissions.length
          )
            store.transaction(() => {
              const facts = hash(progress);
              const changed = store.db
                .prepare(
                  "UPDATE main_checkpoints SET reminder_count=reminder_count+1,last_reminder_facts=? WHERE agent_id=? AND reminder_count=?",
                )
                .run(facts, main.agentId, checkpoint.reminder_count).changes;
              if (changed && facts !== checkpoint.last_reminder_facts) {
                const messageId = randomUUID();
                recordInternalMessage(store, main.agentId, messageId, "reminder");
                reminder = {
                  messageId,
                  text: `Controller checkpoint: ${JSON.stringify(progress)}. Read current auto status before the next step. Only register authorized pending work; COMPLETE needs checks and exact-diff review. Unknown process state requires confirmation. Do not repeat completed work or reply to this reminder with another reminder.`,
                };
              }
            });
        }
        return { version: 3, assessment, reminder };
      } finally {
        await provider.close();
      }
    }
    if (request.operation === "auto-wake") {
      const claimed = claimMainWake(
        request.agentId,
        request.activationId,
        request.fingerprint,
        request.messageId,
        vault.root,
      );
      if (claimed) recordInternalMessage(store, request.agentId, request.messageId, "wake");
      return { claimed };
    }
    if (request.operation === "auto-wake-settle")
      return settleMainWake(request.agentId, request.messageId, request.sent, vault.root);
    if (request.operation === "status")
      return {
        ...workflowStatus(store, request.directory, request.agentId, vault.root),
        orchestrationVersion: config.orchestrationVersion ?? 2,
      };
    if (request.operation === "decision-history")
      return decisionHistory(
        store,
        request.directory,
        request.agentId,
        request.assessmentId,
        request.before,
        vault.root,
      );
    if (request.operation === "auto-state") {
      if (request.state === "arming" && request.requestId)
        recordInternalMessage(store, request.agentId, request.requestId, "activation");
      const directory = canonicalPath(localPath(request.directory));
      if (config.orchestrationVersion === 3 && request.state === "arming") {
        const checkpoint = store.db
          .prepare("SELECT message_id FROM main_checkpoints WHERE agent_id=?")
          .get(request.agentId) as { message_id: string | null } | undefined;
        const oldReceipts = store.db
          .prepare(`SELECT receipt.message_id FROM internal_messages receipt WHERE agent_id=? AND kind LIKE 'human:%'
          AND NOT EXISTS(SELECT 1 FROM assessments assessment WHERE assessment.owner_id=receipt.agent_id AND assessment.kind='intake'
            AND json_extract(assessment.facts_json,'$.messageId')=receipt.message_id AND assessment.result_json IS NOT NULL)`)
          .all(request.agentId) as { message_id: string }[];
        const provider = createProvider(config.daemonUrl);
        await provider.connect();
        try {
          const handle = provider.client.agents.ref(request.agentId),
            snapshot = (await handle.refresh())?.agent;
          if (
            !snapshot ||
            canonicalPath(snapshot.cwd) !== directory ||
            snapshot.status !== "idle" ||
            snapshot.activeTurn
          )
            throw Error("AUTOMATION_MAIN_MUST_BE_IDLE");
          const timeline = await handle.timeline.refetch({
            direction: "tail",
            limit: 200,
            projection: "projected",
          });
          if (timeline.error || timeline.gap) throw Error("INTAKE_HISTORY_INCOMPLETE");
          const last = timeline.entries
            .map((entry) => entry.item)
            .findLast(
              (item) =>
                item.type === "user_message" &&
                !store.db
                  .prepare(
                    "SELECT 1 FROM internal_messages WHERE agent_id=? AND message_id=? AND kind NOT LIKE 'human:%'",
                  )
                  .get(request.agentId, item.clientMessageId ?? item.messageId ?? ""),
            );
          const emptyHistory =
            !timeline.hasOlder &&
            !timeline.entries.some((entry) => entry.item.type === "user_message");
          let emptySessionId = snapshot.runtimeInfo?.sessionId ?? null;
          if (emptyHistory && !emptySessionId)
            emptySessionId = await verifiedProviderSessionId(handle);
          const baseline =
            last?.type === "user_message"
              ? (last.clientMessageId ?? last.messageId ?? null)
              : emptyHistory && emptySessionId
                ? `empty:${emptySessionId}`
                : timeline.endCursor
                  ? `cursor:${timeline.endCursor.epoch}:${timeline.endCursor.seq}`
                  : null;
          const boundary = timelineCheckpointIndex(
            timeline.entries,
            checkpoint?.message_id ?? null,
          );
          const unseenInput = timeline.entries.slice(boundary + 1).flatMap((entry) => {
            if (entry.item.type !== "user_message") return [];
            const messageId = entry.item.clientMessageId ?? entry.item.messageId;
            if (!messageId) return [];
            const receipted = store.db
              .prepare("SELECT 1 FROM internal_messages WHERE agent_id=? AND message_id=?")
              .get(request.agentId, messageId);
            const classified = store.db
              .prepare(
                "SELECT 1 FROM assessments WHERE owner_id=? AND kind='intake' AND json_extract(facts_json,'$.messageId')=? AND result_json IS NOT NULL",
              )
              .get(request.agentId, messageId);
            return !receipted && !classified ? [messageId] : [];
          });
          for (const messageId of unseenInput)
            markIntakeClassificationPending(store, request.agentId, messageId);
          if (!oldReceipts.length && !unseenInput.length)
            store.db
              .prepare(
                "INSERT INTO main_checkpoints(agent_id,message_id) VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET message_id=excluded.message_id,turn_count=0,reminder_count=0,last_reminder_facts=NULL",
              )
              .run(request.agentId, baseline);
        } finally {
          await provider.close();
        }
      }
      const previous = readAutomation(vault.root).mains.find(
        (main) => main.agentId === request.agentId,
      );
      const baseline =
        request.state === "arming" && previous
          ? previous.taskKeys.flatMap((key) => {
              const task = store.task(key);
              if (!task) return [];
              const a = store.latest(key);
              const review = a
                ? (store.db
                    .prepare("SELECT state FROM review_runs WHERE attempt_id=?")
                    .get(a.id) as { state: string } | undefined)
                : undefined;
              return [
                [
                  key,
                  JSON.stringify([
                    task.state,
                    a?.agent_id ?? null,
                    review?.state ?? null,
                    taskActivitySequence(store, a?.id),
                  ]),
                ],
              ];
            })
          : [];
      return editAutomation(
        request.agentId,
        (prior) => {
          if (prior && canonicalPath(prior.directory) !== directory)
            throw Error("AUTOMATION_DIRECTORY_MISMATCH");
          if (request.state === "arming" && prior && prior.state !== "off")
            throw Error("AUTOMATION_ALREADY_ENABLED");
          if (
            ["ready", "uncertain"].includes(request.state) &&
            (!prior || prior.state !== "arming" || prior.requestId !== request.requestId)
          )
            throw Error("AUTOMATION_ACTIVATION_CHANGED");
          return {
            agentId: request.agentId,
            directory,
            state: request.state,
            requestId: request.requestId,
            protocolVersion:
              request.state === "arming"
                ? (config.orchestrationVersion ?? 2)
                : (prior?.protocolVersion ?? 2),
            workerPlacement: prior?.workerPlacement,
            taskKeys: prior?.taskKeys ?? [],
            wakeCount: request.state === "arming" ? 0 : (prior?.wakeCount ?? 0),
            wakeBaseline:
              request.state === "arming"
                ? Object.fromEntries(baseline)
                : (prior?.wakeBaseline ?? {}),
            wake: request.state === "arming" ? undefined : prior?.wake,
          };
        },
        vault.root,
      );
    }
    if (request.operation === "auto-worktree" || request.operation === "auto-task") {
      const main = requireAutomaticMain(request.agentId, request.directory, vault.root);
      const provider = createProvider(config.daemonUrl);
      if (config.orchestrationVersion === 3) {
        if (main.protocolVersion !== 3) throw Error("V3_MAIN_RESTART_REQUIRED");
        const intakeProvider = createProvider(config.daemonUrl);
        await intakeProvider.connect();
        try {
          await captureHumanIntake(store, config, intakeProvider.client, main, classifier);
        } finally {
          await intakeProvider.close();
        }
      }
      const git = new Git(config.gitExecutable);
      if (request.operation === "auto-worktree") {
        if (config.orchestrationVersion === 3) {
          let permitted = false;
          try {
            permitted = currentIntake(store, request.agentId, true).result.needImplementation;
          } catch {
            const intake = currentIntake(store, request.agentId, false);
            permitted =
              ["decisions", "main"].includes(intake.source) &&
              (intake.result.needPlanner ||
                intake.result.needAdvisor ||
                intake.result.intent === "review-request");
          }
          if (!permitted) throw Error("INTAKE_WORKTREE_NOT_AUTHORIZED");
        }
        const repository = automaticRepository(
          request.directory,
          request.repository ?? request.directory,
          git,
        );
        if (git.isIsolatedWorkspace(request.directory))
          return { worktree: canonicalPath(request.directory), repository, reusedWorkspace: true };
        // Keep customer work beside its repository, not in controller state.
        // Existing contracts retain their original worktree and lease binding.
        const projectDirectory = localPath(path.dirname(repository));
        const worktreeDirectory = path.join(projectDirectory, ".worktrees");
        mkdirSync(worktreeDirectory, { recursive: true });
        const relative = path.relative(projectDirectory, localPath(worktreeDirectory));
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          throw Error("AUTOMATION_WORKTREE_ROOT_OUTSIDE_PROJECT");
        const destination = automaticWorktreePath(repository, request.agentId, request.slug);
        return { worktree: git.createWorktree(repository, destination, request.slug) };
      }
      const contract = {
        ...request.contract,
      };
      delete contract.amendsTaskKey;
      delete contract.amendsContractHash;
      delete contract.amendsDiffHash;
      contract.packageRevision = 1;
      if (contract.estimatedMicroUsd !== 0) throw Error("AUTOMATION_USE_CONFIGURED_TASK_BUDGET");
      const latestIntake =
        config.orchestrationVersion === 3
          ? currentIntake(store, request.agentId, false)
          : undefined;
      const continuingIntake =
        contract.mutation && latestIntake && preservesExistingWork(latestIntake)
          ? currentIntake(store, request.agentId, true)
          : undefined;
      if (
        config.orchestrationVersion === 3 &&
        contract.mutation &&
        latestIntake?.result.intent === "approval" &&
        latestIntake.result.needImplementation
      ) {
        const declaredTarget = mainInputInterpretation(store, latestIntake.id)?.target;
        // Approval selects a stored main-owned package. Its persisted workflow
        // ID is already namespaced; only legacy raw names need normalization.
        const storedWorkflow = main.taskKeys.some((key) =>
          key.startsWith(`${contract.workflowId}/`),
        );
        if (!storedWorkflow)
          contract.workflowId = automaticWorkflowId(request.agentId, contract.workflowId);
        if (
          declaredTarget &&
          (declaredTarget.taskKey !==
            `${contract.workflowId}/${contract.taskId}/${contract.role}` ||
            store.task(declaredTarget.taskKey)?.contract_hash !== declaredTarget.contractHash)
        )
          return { state: "WAITING", reason: "APPROVAL_TARGET_REQUIRED" };
        const target = linkApprovalToOutstandingTask(
          store,
          request.agentId,
          main.taskKeys,
          latestIntake,
          contract,
        );
        return target
          ? { key: target, state: "APPROVAL_LINKED" }
          : { state: "WAITING", reason: "APPROVAL_TARGET_REQUIRED" };
      }
      contract.workflowId = automaticWorkflowId(request.agentId, contract.workflowId);
      if (
        config.orchestrationVersion === 3 &&
        contract.mutation &&
        latestIntake &&
        continuingIntake &&
        main.taskKeys.some((key) => {
          const task = store.task(key);
          return task && JSON.parse(task.contract_json).intakeId === continuingIntake.id;
        })
      )
        return { state: "NO_TASK", reason: "INFORMATIONAL_FOLLOW_UP" };
      if (
        config.orchestrationVersion === 3 &&
        contract.mutation &&
        !latestIntake?.result.needImplementation &&
        !continuingIntake
      )
        return { state: "WAITING", reason: "INTAKE_IMPLEMENTATION_NOT_AUTHORIZED" };
      let amendmentTarget: string | undefined;
      if (
        config.orchestrationVersion === 3 &&
        contract.mutation &&
        latestIntake?.result.intent === "change-request"
      ) {
        const declaredTarget = mainInputInterpretation(store, latestIntake.id)?.target;
        const candidates = main.taskKeys.flatMap((taskKey) => {
          if (declaredTarget && declaredTarget.taskKey !== taskKey) return [];
          const task = store.task(taskKey);
          if (
            !task ||
            task.state !== "NEEDS_CONFIRMATION" ||
            task.contract_hash !== hash(JSON.parse(task.contract_json))
          )
            return [];
          const prior = contractSchema.parse(JSON.parse(task.contract_json));
          const owner = prior.intakeId
            ? (store.db
                .prepare("SELECT owner_id FROM assessments WHERE id=?")
                .get(prior.intakeId) as { owner_id: string } | undefined)
            : undefined;
          const attempt = store.latest(taskKey);
          return owner?.owner_id === request.agentId &&
            prior.mutation &&
            prior.role.startsWith("implement-") &&
            attempt?.status === "NEEDS_CONFIRMATION"
            ? [{ taskKey, task, prior }]
            : [];
        });
        if (candidates.length !== 1)
          return { state: "WAITING", reason: "AMENDMENT_WAITING_TARGET_REQUIRED" };
        const predecessor = candidates[0];
        if (
          declaredTarget &&
          (predecessor.task.contract_hash !== declaredTarget.contractHash ||
            git.snapshot(predecessor.prior).diffHash !== declaredTarget.diffHash)
        )
          return { state: "WAITING", reason: "MAIN_TARGET_BINDING_CHANGED" };
        if (contract.taskId === predecessor.prior.taskId)
          return { state: "WAITING", reason: "AMENDMENT_WAITING_NEW_TASK_ID_REQUIRED" };
        contract.workflowId = predecessor.prior.workflowId;
        contract.repository = predecessor.prior.repository;
        contract.worktree = predecessor.prior.worktree;
        contract.baseCommit = predecessor.prior.baseCommit;
        contract.packageRevision = (predecessor.prior.packageRevision ?? 1) + 1;
        contract.amendsTaskKey = predecessor.taskKey;
        contract.amendsContractHash = predecessor.task.contract_hash;
        try {
          contract.amendsDiffHash = new Git(config.gitExecutable).snapshot(
            predecessor.prior,
          ).diffHash;
        } catch {
          return { state: "WAITING", reason: "AMENDMENT_WAITING_DIFF_REVIEW" };
        }
        amendmentTarget = predecessor.taskKey;
      }
      contract.repository = automaticRepository(request.directory, contract.repository, git);
      contract.worktree = localPath(contract.worktree);
      const intake =
        config.orchestrationVersion === 3
          ? currentIntake(store, request.agentId, contract.mutation)
          : undefined;
      const intakeRow = intake
        ? (store.db.prepare("SELECT facts_json FROM assessments WHERE id=?").get(intake.id) as {
            facts_json: string;
          })
        : undefined;
      // Placement is derived from the registered main, never from a model-supplied ID.
      await provider.connect();
      try {
        if (options.workspaceForMain)
          contract.workspace = await options.workspaceForMain(request.agentId, request.directory);
        else {
          const agent = (await provider.client.agents.ref(request.agentId).refresh())?.agent;
          if (!agent?.workspaceId || canonicalPath(agent.cwd) !== canonicalPath(request.directory))
            throw Error("AUTOMATION_WORKSPACE_REQUIRED");
          const workspace = await provider.client.workspaces.ref(agent.workspaceId).refresh();
          if (
            !workspace ||
            canonicalPath(workspace.workspaceDirectory) !== canonicalPath(request.directory)
          )
            throw Error("AUTOMATION_WORKSPACE_MISMATCH");
          contract.workspace = {
            id: agent.workspaceId,
            directory: canonicalPath(request.directory),
            mainAgentId: request.agentId,
          };
        }
        if (
          contract.workspace.mainAgentId !== request.agentId ||
          canonicalPath(contract.workspace.directory) !== canonicalPath(request.directory)
        )
          throw Error("AUTOMATION_WORKSPACE_MISMATCH");
        if (main.workerPlacement === "source-workspace") delete contract.workspace;
        else
          contract.workspace = await automaticTaskWorkspace(
            contract,
            contract.workspace,
            provider,
            git,
          );
      } finally {
        await provider.close();
      }
      if (
        contract.mutation &&
        contract.workspace &&
        canonicalPath(contract.workspace.directory) !== canonicalPath(contract.worktree)
      )
        throw Error("SHARED_WORKSPACE_REQUIRES_SOURCE_DIRECTORY");
      if (contract.role === "reviewer") throw Error("AUTOMATION_REVIEW_IS_CONTROLLER_OWNED");
      if (intake && intakeRow) {
        // An unfinished Main proposal is not an authoritative package yet.
        // Validate before claiming advice/facts so the same unregistered package
        // can be completed after planning without rewriting immutable history.
        if (intake.source === "main" && contract.mutation && !request.packageInterpretation)
          return { state: "WAITING", reason: "MAIN_PACKAGE_INTERPRETATION_REQUIRED" };
        if (contract.mutation && request.packageInterpretation)
          effectiveImplementation(
            {
              ...request.packageInterpretation!,
              shouldSplit: false,
              extraReviewRecommended: false,
            },
            contract,
          );
        const facts = freezePackageRouting(
          store,
          config,
          packageFactsSchema.parse({
            mainAgentId: request.agentId,
            intakeId: intake.id,
            packageId: `${contract.workflowId}/${contract.taskId}`,
            packageRevision: contract.packageRevision ?? 1,
            ...(contract.amendsTaskKey
              ? {
                  amendsTaskKey: contract.amendsTaskKey,
                  amendsContractHash: contract.amendsContractHash,
                  amendsDiffHash: contract.amendsDiffHash,
                }
              : {}),
            repository: contract.repository,
            baseCommit: contract.baseCommit,
            goal: contract.prompt,
            originalRequest: JSON.parse(intakeRow.facts_json).text,
            acceptance: contract.acceptance,
            files: contract.allowedPaths,
            checks: contract.checks,
            mutation: contract.mutation,
            uiChanged: contract.uiChanged,
            interfaces: contract.interfaces ?? [],
            dependencies: contract.dependencies ?? [],
            unknowns: contract.unknowns ?? [],
            risks: [
              ...(contract.uiChanged ? ["UI_CHANGED"] : []),
              ...(contract.highRisk ? ["DECLARED_HIGH_RISK"] : []),
            ],
            evidence: (contract.references ?? [])
              .flatMap((id) => {
                const row = store.db
                  .prepare("SELECT result_json,expires_ms FROM research_requests WHERE id=?")
                  .get(id) as { result_json: string; expires_ms: number } | undefined;
                if (!row || row.expires_ms < Date.now()) return [];
                const result = JSON.parse(row.result_json);
                return result.evidence.map(
                  (entry: { id: string; revision: string; summary: string }) => ({
                    id: entry.id,
                    revision: entry.revision,
                    summary: entry.summary,
                  }),
                );
              })
              .slice(0, 30),
            priorFindings: [],
          }),
        );
        const selectedCategory = request.packageInterpretation?.workKind;
        if (
          selectedCategory &&
          !["ui", "general"].includes(selectedCategory) &&
          !facts.workCategoryCatalog?.some((category) => category.id === selectedCategory)
        )
          throw Error("MAIN_PACKAGE_CATEGORY_UNKNOWN");
        const advice = await classifier.classifyPackage(facts, config);
        if (request.packageInterpretation) {
          store.transaction(() =>
            declareMainPackage(store, {
              version: 1,
              packageAssessmentId: advice.id,
              factsHash: hash(facts),
              declaration: request.packageInterpretation!,
            }),
          );
        }
        const assessment = effectivePackageAssessment(store, advice);
        contract.intakeId = intake.id;
        contract.packageAssessmentId = assessment.id;
        if (contract.mutation) {
          Object.assign(contract, effectiveImplementation(assessment.result, contract));
          contract.ownerApproved = false;
        } else {
          contract.minTier = 1;
          contract.highRisk = false;
        }
      }
      const engine = new Engine(store, config, provider);
      const amendment = amendmentTarget
        ? await engine.addAmendment(contract, amendmentTarget)
        : undefined;
      if (amendment?.state === "WAITING") return amendment;
      const key = amendment?.state === "READY" ? amendment.key : engine.add(contract);
      if (config.orchestrationVersion === 3)
        store.db
          .prepare("INSERT OR IGNORE INTO task_assessments VALUES(?,?,?,?,?)")
          .run(key, contract.intakeId!, contract.packageAssessmentId!, contract.role, Date.now());
      editAutomation(
        request.agentId,
        (prior) => {
          if (!prior || prior.state !== "ready") throw Error("AUTOMATION_NOT_READY");
          return { ...prior, taskKeys: [...new Set([...prior.taskKeys, key])] };
        },
        vault.root,
      );
      return { key, state: "READY" };
    }
    if (request.operation === "launch-budget") {
      const original = store.attempt(request.requestKey);
      if (original.agent_id && original.agent_id !== request.agentId)
        throw Error("BUDGET_AGENT_MISMATCH");
      const current = store
        .active()
        .filter(
          (attempt) =>
            attempt.agent_id === request.agentId &&
            [
              "INTENT",
              "SENDING",
              "RUNNING",
              "PERMISSION",
              "UNKNOWN",
              "NEEDS_CONFIRMATION",
              "WAITING_PROCESSES",
            ].includes(attempt.status),
        );
      if (current.length > 1) throw Error("BUDGET_MULTIPLE_BOUND_ATTEMPTS");
      const attempt = current[0] ?? original;
      if (attempt.task_key !== original.task_key || attempt.session_key !== original.session_key)
        throw Error("BUDGET_SESSION_IDENTITY_MISMATCH");
      const contract = contractSchema.parse(
        JSON.parse(store.task(attempt.task_key)!.contract_json),
      );
      if (
        canonicalPath(contract.workspace?.directory ?? contract.worktree) !==
        canonicalPath(request.cwd)
      )
        throw Error("BUDGET_WORKTREE_MISMATCH");
      const route = JSON.parse(attempt.route_json) as RuntimeRoute;
      const monitor = request.processMonitor
        ? {
            processMonitorFile: processMonitorFile(request.requestKey),
            worktree: contract.worktree,
            allowedPaths: store.scopePaths(contract),
          }
        : {};
      if (route.access !== "openai-api") return monitor;
      const file = path.join(appRoot, "state/pi-budgets", `${hash(attempt.id)}.json`);
      if (!existsSync(file) || !Number.isSafeInteger(JSON.parse(readFileSync(file, "utf8")).limit))
        throw Error("BUDGET_LEDGER_MISSING");
      if (JSON.parse(readFileSync(file, "utf8")).closed) throw Error("API_TASK_CLOSED");
      store.event("PI_BUDGET_REBOUND", attempt.id);
      return { budgetFile: file, ...monitor };
    }
    if (request.operation === "save") {
      if (
        request.config.daemonUrl !== config.daemonUrl ||
        request.config.gitExecutable !== config.gitExecutable
      )
        throw Error("CONTROLLER_IDENTITY_READ_ONLY");
      if (/sk-[a-zA-Z0-9_-]{16,}/.test(JSON.stringify(request.config)))
        throw Error("SECRETS_NOT_CONFIG_VALUES");
      const next = configSchema.parse(request.config);
      if (next.decisions?.enabled && !vault.status("decisions").present)
        throw Error("DECISIONS_KEY_MISSING");
      if (options.validateCatalog) await options.validateCatalog(next);
      else {
        const provider = createProvider(config.daemonUrl);
        await provider.connect();
        try {
          const providers = await provider.discover(appRoot, true);
          for (const route of next.routes.filter((r) => r.enabled)) {
            const p = providers.find((p) => p.provider === route.provider && p.status === "ready");
            if (
              !p?.models.some(
                (m) =>
                  m.id === route.model &&
                  (m.thinking.length
                    ? m.thinking.includes(route.reasoning)
                    : route.reasoning === ""),
              ) ||
              (route.modeId && !p.modes.includes(route.modeId))
            )
              throw Error("ROUTE_NOT_SUPPORTED");
          }
        } finally {
          await provider.close();
        }
      }
      for (const route of next.routes) {
        const prior = config.routes.find((r) => r.id === route.id);
        if (
          !prior ||
          hash({ ...prior, revision: "", name: undefined }) !==
            hash({ ...route, revision: "", name: undefined })
        )
          route.revision = `settings-snapshot:${hash({ ...route, revision: "", name: undefined })}`;
        else route.revision = prior.revision;
      }
      config = saveConfig(next, request.revision, file, vault.root);
    } else if (request.operation === "credential") {
      vault.save(request.slot, request.key, request.revision);
    } else if (request.operation === "pause") store.stop(request.paused);
    else if (request.operation === "test-decisions") {
      const result = await new Decisions(store, {
        credential: () => vault.read("decisions"),
        credentialRevision: () => vault.status("decisions").revision,
      }).classifyIntake(
        {
          mainAgentId: "connection-test",
          messageId: request.nonce,
          messageRevision: 1,
          factsRevision: 1,
          origin: "human",
          directory: appRoot,
          text: "Wie ist der aktuelle Status? Nur eine Statusfrage, keine Implementierung.",
          knownFacts: [],
        },
        config,
      );
      const reservation = store.db
        .prepare("SELECT reserved FROM decision_calls WHERE key=?")
        .get(hash({ id: result.id, version: result.version })) as { reserved: number } | undefined;
      return {
        status:
          result.source === "decisions"
            ? "ok"
            : result.reason.startsWith("DECISIONS_HTTP_") ||
                result.reason === "DECISIONS_OUTCOME_UNKNOWN"
              ? "failed"
              : "blocked",
        reason: result.reason,
        model: "gpt-6-luna",
        reservedMicroUsd: reservation?.reserved ?? 0,
      };
    }
    return settingsView(store, config, vault);
  } finally {
    store.close();
  }
}
