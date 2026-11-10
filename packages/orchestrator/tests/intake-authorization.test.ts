import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { editAutomation, taskDispatchAllowed } from "../src/automation.ts";
import {
  intakeIdentity,
  packageIdentity,
  type Assessment,
  type Classifier,
  type IntakeFacts,
  type IntakeResult,
  type PackageFacts,
  type PackageResult,
} from "../src/assessments.ts";
import { Engine } from "../src/engine.ts";
import { approveLowConfidenceIntake, assertTaskAssessment, currentIntake } from "../src/intake.ts";
import {
  canonicalPath,
  configSchema,
  contractSchema,
  hash,
  type Config,
  type Contract,
} from "../src/contracts.ts";
import { PaseoProvider, type Snapshot } from "../src/provider.ts";
import { settingsOperation } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import { CredentialVault } from "../src/secrets.ts";

function gitExecutable(): string {
  const command =
    process.platform === "win32"
      ? path.join(process.env.SystemRoot ?? "C:/Windows", "System32/where.exe")
      : "/usr/bin/which";
  return execFileSync(command, ["git"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
}
function runGit(executable: string, args: string[], cwd: string): string {
  try {
    return execFileSync(executable, args, { cwd, encoding: "utf8" }).trim();
  } catch (error) {
    const diagnostic = (error as NodeJS.ErrnoException & { stderr?: Buffer }).stderr
      ?.toString()
      .trim();
    throw Error(diagnostic || `Git command failed: ${args.join(" ")}`, { cause: error });
  }
}

function insertAssessment<T extends IntakeResult | PackageResult>(
  store: Store,
  assessment: Assessment<T>,
  facts: IntakeFacts | PackageFacts,
  ownerId: string,
): void {
  store.db
    .prepare(`INSERT INTO assessments(id,kind,owner_id,facts_hash,facts_json,result_json,state,created_ms)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET result_json=excluded.result_json,state='SETTLED'`)
    .run(
      assessment.id,
      assessment.kind,
      ownerId,
      assessment.factsHash,
      JSON.stringify(facts),
      JSON.stringify(assessment),
      "SETTLED",
      Date.now(),
    );
}

class FixtureClassifier implements Classifier {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  async classifyIntake(facts: IntakeFacts, _config: Config): Promise<Assessment<IntakeResult>> {
    const id = intakeIdentity(facts),
      existing = this.store.db.prepare("SELECT result_json FROM assessments WHERE id=?").get(id) as
        | { result_json: string | null }
        | undefined;
    if (existing?.result_json) return JSON.parse(existing.result_json) as Assessment<IntakeResult>;
    const text = facts.text.toLowerCase();
    if (text.includes("low-confidence approval")) {
      const assessment: Assessment<IntakeResult> = {
        id,
        kind: "intake",
        factsHash: hash(facts),
        version: "fixture-v1",
        source: "fallback",
        reason: "DECISIONS_LOW_CONFIDENCE",
        result: {
          intent: "other",
          needExplorer: false,
          needPlanner: true,
          needAdvisor: false,
          needImplementation: false,
          extraReviewRecommended: false,
        },
        answers: [
          { name: "intent", value: "approval", confidence: 0.2 },
          { name: "needImplementation", value: true, confidence: 0.2 },
        ],
      };
      insertAssessment(this.store, assessment, facts, facts.mainAgentId);
      return assessment;
    }
    const intent = text.includes("change")
      ? "change-request"
      : text.includes("approve")
        ? "approval"
        : text.includes("status")
          ? "status"
          : "new-task";
    const result: IntakeResult = {
      intent,
      needExplorer: false,
      needPlanner: false,
      needAdvisor: false,
      needImplementation: ["new-task", "change-request", "approval"].includes(intent),
      extraReviewRecommended: false,
    };
    const assessment: Assessment<IntakeResult> = {
      id,
      kind: "intake",
      factsHash: hash(facts),
      version: "fixture-v1",
      source: "decisions",
      reason: "MOCK_CLASSIFIER",
      result,
    };
    insertAssessment(this.store, assessment, facts, facts.mainAgentId);
    return assessment;
  }
  async classifyPackage(facts: PackageFacts, _config: Config): Promise<Assessment<PackageResult>> {
    const id = packageIdentity(facts),
      existing = this.store.db.prepare("SELECT result_json FROM assessments WHERE id=?").get(id) as
        | { result_json: string | null }
        | undefined;
    if (existing?.result_json) return JSON.parse(existing.result_json) as Assessment<PackageResult>;
    const result: PackageResult = {
      complexity: "normal",
      additionalPlanning: false,
      advisorNeeded: false,
      shouldSplit: false,
      extraReviewRecommended: false,
    };
    const assessment: Assessment<PackageResult> = {
      id,
      kind: "package",
      factsHash: hash(facts),
      version: "fixture-v1",
      source: "decisions",
      reason: "MOCK_CLASSIFIER",
      result,
    };
    insertAssessment(this.store, assessment, facts, facts.mainAgentId);
    return assessment;
  }
}

test("automatic intake preserves authorization, audits high-risk approval, and waits for settled amendments", async (t) => {
  const root = mkdtempSync(path.join(process.cwd(), ".intake-test-"));
  let closeRiskStore = () => {};
  t.after(() => {
    closeRiskStore();
    rmSync(root, { recursive: true, force: true });
  });
  const git = gitExecutable(),
    repo = path.join(root, "repo"),
    worktree = path.join(root, "repo-worktree"),
    vaultRoot = path.join(root, "controller");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  mkdirSync(vaultRoot, { recursive: true });
  writeFileSync(path.join(repo, "src", "base.ts"), "export const base = true;\n");
  runGit(git, ["init", "-b", "main"], repo);
  runGit(git, ["config", "user.name", "Paseo test"], repo);
  runGit(git, ["config", "user.email", "paseo-test@example.invalid"], repo);
  runGit(git, ["add", "."], repo);
  runGit(git, ["commit", "-m", "fixture"], repo);
  runGit(git, ["worktree", "add", "-b", "feature/intake-sequence", worktree, "HEAD"], repo);
  const baseCommit = runGit(git, ["rev-parse", "HEAD"], worktree);
  const riskWorktree = path.join(root, "risk-worktree");
  runGit(
    git,
    ["worktree", "add", "-b", "feature/high-risk-owner-approval", riskWorktree, baseCommit],
    repo,
  );
  const agentId = "main-agent";
  const route = {
    id: "test-codex",
    access: "codex-pro200" as const,
    provider: "codex" as const,
    model: "gpt-6-luna",
    revision: "fixture",
    reasoning: "high" as const,
    tier: 3 as const,
    enabled: true,
    maxConcurrent: 1,
    dataScopes: ["public" as const],
    capabilities: ["code" as const],
  };
  const config = configSchema.parse({
    schemaVersion: 1,
    orchestrationVersion: 3,
    daemonUrl: "ws://127.0.0.1:3010/ws",
    gitExecutable: git,
    maxWorkflows: 2,
    maxRework: 1,
    apiEnabled: false,
    liveDispatchApproved: false,
    budgets: { decisions: 0, implementation: 0, "premium-api": 0, emergency: 0 },
    roleRoutes: {
      planner: ["test-codex"],
      advisor: ["test-codex"],
      "implement-simple": ["test-codex"],
      "implement-normal": ["test-codex"],
      "implement-complex": ["test-codex"],
      reviewer: ["test-codex"],
    },
    routes: [route],
  });
  const configFile = path.join(root, "controller.json"),
    database = path.join(root, "controller.sqlite");
  writeFileSync(configFile, JSON.stringify(config));
  const messages: { id: string; text: string; timestamp: string }[] = [];
  let backgroundActive: boolean | null = false;
  let savedSessionId: string | null = null;
  let providerSessionId = "fixture-session";
  const client = {
    agents: {
      ref: (id: string) => ({
        id,
        refresh: async () => ({
          agent: {
            id,
            cwd: repo,
            provider: "codex/codex",
            status: "idle",
            activeTurn: false,
            pendingPermissions: [],
            runtimeInfo: { sessionId: savedSessionId },
            labels: { orchestratorScope: "public" },
          },
        }),
        timeline: {
          refetch: async () => ({
            entries: messages.map((message, index) => ({
              timestamp: message.timestamp,
              seqStart: index + 1,
              seqEnd: index + 1,
              item: {
                type: "user_message",
                clientMessageId: message.id,
                messageId: message.id,
                text: message.text,
              },
            })),
            error: false,
            gap: false,
            hasOlder: false,
            hasNewer: false,
            startCursor: { epoch: "fixture-session", seq: 1 },
            endCursor: { epoch: "fixture-session", seq: messages.length },
          }),
        },
        backgroundWork: {
          refresh: async () => ({
            agentId: id,
            providerSessionId,
            observationId: "fresh-session-identity",
            coverage: "codex_background_terminals",
            queriedProviderSessionIds: [providerSessionId],
            items: [],
            providerSubagents: [],
          }),
        },
      }),
    },
  };
  const fakeProvider = {
    client,
    connect: async () => {},
    close: async () => {},
    discover: async () => [
      {
        provider: "codex",
        status: "ready",
        supportsBackgroundWorkRefresh: true,
        models: [{ id: route.model, thinking: ["high"] }],
        modes: [],
      },
    ],
    refresh: async (id: string): Promise<Snapshot> => ({
      id,
      cwd: worktree,
      provider: "codex",
      model: route.model,
      status: "idle",
      turnComplete: true,
      foregroundActive: false,
      backgroundActive,
      contextFraction: null,
      usage: {
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        billedMicroUsd: null,
      },
      reasoning: route.reasoning,
      modeId: null,
    }),
    foregroundEvidence: async () => ({ complete: true, traceHash: "e".repeat(64), toolCount: 1 }),
  } as unknown as PaseoProvider;
  const options = {
    file: configFile,
    database,
    vault: new CredentialVault(vaultRoot),
    providerFactory: () => fakeProvider,
    classifierFactory: (store: Store) => new FixtureClassifier(store),
    workspaceForMain: async () => ({
      id: "fixture-workspace",
      directory: repo,
      mainAgentId: agentId,
    }),
  };
  editAutomation(
    agentId,
    () => ({
      agentId,
      directory: canonicalPath(repo),
      state: "off",
      requestId: "",
      protocolVersion: 3,
      workerPlacement: "source-workspace",
      taskKeys: [],
      wakeCount: 0,
      wakeBaseline: {},
    }),
    vaultRoot,
  );
  await settingsOperation(
    {
      operation: "auto-state",
      agentId,
      directory: repo,
      state: "arming",
      requestId: "activation-one",
    },
    options,
  );
  await settingsOperation(
    {
      operation: "auto-state",
      agentId,
      directory: repo,
      state: "ready",
      requestId: "activation-one",
    },
    options,
  );
  const emptyCheckpoint = new Store(database);
  assert.equal(
    (
      emptyCheckpoint.db
        .prepare("SELECT message_id FROM main_checkpoints WHERE agent_id=?")
        .get(agentId) as { message_id: string }
    ).message_id,
    "empty:fixture-session",
  );
  emptyCheckpoint.close();
  providerSessionId = "different-session";
  await assert.rejects(
    () => settingsOperation({ operation: "auto-intake", agentId, directory: repo }, options),
    /INTAKE_HISTORY_SESSION_CHANGED/,
  );
  providerSessionId = "fixture-session";
  const registerInput = async (id: string, text: string) => {
    messages.push({ id, text, timestamp: new Date(Date.now() + messages.length).toISOString() });
    await settingsOperation(
      { operation: "auto-input", agentId, directory: repo, messageId: id, text },
      options,
    );
  };
  const taskRequest = (taskId: string, prompt: string): Contract =>
    contractSchema.parse({
      workflowId: "followup",
      taskId,
      repository: repo,
      worktree,
      baseCommit,
      dataScope: "public",
      role: "implement-normal",
      prompt,
      acceptance: [`Implement ${prompt}`],
      allowedPaths: ["src"],
      requiredCapabilities: ["code"],
      minTier: 2,
      mutation: true,
      highRisk: false,
      uiChanged: false,
      estimatedMicroUsd: 0,
      checks: { build: [process.execPath, "--version"], test: [process.execPath, "--version"] },
    });
  const highRiskRequest = (taskId: string, prompt: string): Contract =>
    contractSchema.parse({
      ...taskRequest(taskId, prompt),
      worktree: riskWorktree,
      role: "implement-complex",
      minTier: 3,
      highRisk: true,
      ownerApproved: true,
    });

  await registerInput("original-input-0001", "new task: implement the initial objective");
  const originalResult = (await settingsOperation(
    {
      operation: "auto-task",
      agentId,
      directory: repo,
      contract: taskRequest("initial", "initial objective"),
    },
    options,
  )) as { key: string; state: string };
  assert.equal(originalResult.state, "READY");
  const store = new Store(database);
  const originalTask = store.task(originalResult.key)!;
  const originalContract = contractSchema.parse(JSON.parse(originalTask.contract_json));
  writeFileSync(
    path.join(worktree, "src", "prior-change.ts"),
    "export const priorChange = true;\n",
  );
  store.db
    .prepare(`INSERT INTO attempts(id,task_key,sequence,status,route_json,agent_id,fence,session_key,created_ms,result_hash,error_kind)
    VALUES(?,?,1,'NEEDS_CONFIRMATION',?,?,1,'fixture-session',?,NULL,NULL)`)
    .run(
      "fixture-attempt",
      originalResult.key,
      JSON.stringify(route),
      "fixture-worker",
      Date.now(),
    );
  store.db
    .prepare(
      "INSERT INTO leases(worktree,attempt_id,fence,state,heartbeat_ms) VALUES(?,?,1,'SUSPECT',?)",
    )
    .run(originalContract.worktree, "fixture-attempt", Date.now());
  store.db
    .prepare("UPDATE tasks SET state='NEEDS_CONFIRMATION' WHERE key=?")
    .run(originalResult.key);
  store.close();

  await registerInput("status-input-000001", "status");
  await settingsOperation(
    { operation: "auto-state", agentId, directory: repo, state: "off", requestId: "" },
    options,
  );
  await settingsOperation(
    {
      operation: "auto-state",
      agentId,
      directory: repo,
      state: "arming",
      requestId: "activation-two",
    },
    options,
  );
  await settingsOperation(
    {
      operation: "auto-state",
      agentId,
      directory: repo,
      state: "ready",
      requestId: "activation-two",
    },
    options,
  );
  const pendingStatus = (await settingsOperation(
    { operation: "status", directory: repo, agentId },
    options,
  )) as { writeAuthorization: { allowed: boolean; reason: string } };
  assert.deepEqual(pendingStatus.writeAuthorization, { allowed: false, reason: "INTAKE_PENDING" });
  const informational = (await settingsOperation(
    {
      operation: "auto-task",
      agentId,
      directory: repo,
      contract: taskRequest("ignored-status", "status"),
    },
    options,
  )) as { state: string; reason: string };
  assert.deepEqual(informational, { state: "NO_TASK", reason: "INFORMATIONAL_FOLLOW_UP" });
  const afterStatus = new Store(database);
  const authorized = afterStatus.db
    .prepare("SELECT work_intake_id FROM main_checkpoints WHERE agent_id=?")
    .get(agentId) as { work_intake_id: string };
  assert.equal(authorized.work_intake_id, originalContract.intakeId);
  assert.equal(afterStatus.task(originalResult.key)?.state, "NEEDS_CONFIRMATION");
  assert.doesNotThrow(() => assertTaskAssessment(afterStatus, config, originalContract));
  afterStatus.close();

  await registerInput("approval-input-0001", "approve the existing task");
  const approval = (await settingsOperation(
    {
      operation: "auto-task",
      agentId,
      directory: repo,
      contract: taskRequest("ignored-approval", "approve"),
    },
    options,
  )) as { key: string; state: string };
  assert.deepEqual(approval, { key: originalResult.key, state: "APPROVAL_LINKED" });
  const afterApproval = new Store(database);
  assert.doesNotThrow(() => assertTaskAssessment(afterApproval, config, originalContract));
  assert.equal(
    (
      afterApproval.db
        .prepare("SELECT COUNT(*) AS count FROM events WHERE kind LIKE 'TASK_APPROVAL_LINK:%'")
        .get() as { count: number }
    ).count,
    1,
  );
  afterApproval.close();

  await registerInput("change-input-000001", "change request: add a second acceptance item");
  const amendmentInput = taskRequest("amended", "amended objective");
  backgroundActive = true;
  const waiting = (await settingsOperation(
    { operation: "auto-task", agentId, directory: repo, contract: amendmentInput },
    options,
  )) as { state: string; reason: string };
  assert.deepEqual(waiting, { state: "WAITING", reason: "AMENDMENT_WAITING_BACKGROUND_WORK" });
  const beforeRelease = new Store(database);
  assert.equal(beforeRelease.task(originalResult.key)?.state, "NEEDS_CONFIRMATION");
  assert.equal(beforeRelease.latest(originalResult.key)?.status, "NEEDS_CONFIRMATION");
  assert.equal(
    (
      beforeRelease.db
        .prepare("SELECT state FROM leases WHERE worktree=?")
        .get(originalContract.worktree) as { state: string }
    ).state,
    "SUSPECT",
  );
  beforeRelease.close();

  backgroundActive = false;
  const amended = (await settingsOperation(
    { operation: "auto-task", agentId, directory: repo, contract: amendmentInput },
    options,
  )) as { key: string; state: string };
  assert.equal(amended.state, "READY", JSON.stringify(amended));
  const afterAmendment = new Store(database);
  const oldTask = afterAmendment.task(originalResult.key)!;
  const oldAttempt = afterAmendment.latest(originalResult.key)!;
  const oldLease = afterAmendment.db
    .prepare("SELECT state FROM leases WHERE worktree=?")
    .get(originalContract.worktree) as { state: string };
  assert.equal(oldTask.state, "SUPERSEDED");
  assert.equal(oldAttempt.status, "FAILED");
  assert.equal(oldAttempt.error_kind, "task-amended");
  assert.equal(oldLease.state, "RELEASED");
  assert.equal(afterAmendment.task(amended.key)?.state, "READY");
  assert.equal(
    (afterAmendment.db.prepare("SELECT COUNT(*) AS count FROM circuits").get() as { count: number })
      .count,
    0,
  );
  assert.throws(
    () => assertTaskAssessment(afterAmendment, config, originalContract),
    /INTAKE_SUPERSEDED/,
  );
  assert.doesNotThrow(() =>
    assertTaskAssessment(
      afterAmendment,
      config,
      contractSchema.parse(JSON.parse(afterAmendment.task(amended.key)!.contract_json)),
    ),
  );
  assert.equal(
    (
      afterAmendment.db
        .prepare(
          "SELECT COUNT(*) AS count FROM events WHERE kind LIKE 'TASK_SUPERSEDED_BY_AMENDMENT:%'",
        )
        .get() as { count: number }
    ).count,
    1,
  );
  afterAmendment.close();

  await registerInput("high-risk-input-0001", "new task: update the high-risk policy");
  const highRiskResult = (await settingsOperation(
    {
      operation: "auto-task",
      agentId,
      directory: repo,
      contract: highRiskRequest("high-risk-one", "update the high-risk policy"),
    },
    options,
  )) as { key: string; state: string };
  assert.equal(highRiskResult.state, "READY");
  const riskStore = new Store(database),
    riskEngine = new Engine(riskStore, config, fakeProvider, undefined, undefined, (key) =>
      taskDispatchAllowed(key, vaultRoot),
    );
  closeRiskStore = () => riskStore.close();
  const highRiskTask = riskStore.task(highRiskResult.key)!;
  const highRiskContract = contractSchema.parse(JSON.parse(highRiskTask.contract_json));
  assert.equal(highRiskContract.highRisk, true);
  const unapprovedPlan = await riskEngine.plan(highRiskResult.key);
  assert.deepEqual(unapprovedPlan, {
    action: "wait",
    reason: "owner-approval-required",
  });
  assert.equal(highRiskContract.ownerApproved, false);

  await registerInput(
    "high-risk-approval-0001",
    "low-confidence approval for the high-risk policy task",
  );
  const waitingForOperatorApproval = (await settingsOperation(
    {
      operation: "auto-task",
      agentId,
      directory: repo,
      contract: highRiskRequest("ignored-low-confidence-approval", "approve"),
    },
    options,
  )) as { state: string; reason: string };
  assert.deepEqual(waitingForOperatorApproval, {
    state: "WAITING",
    reason: "INTAKE_IMPLEMENTATION_NOT_AUTHORIZED",
  });
  const lowConfidenceApprovalRow = riskStore.db
    .prepare(
      "SELECT id FROM assessments WHERE owner_id=? AND kind='intake' AND json_extract(facts_json,'$.messageId')=?",
    )
    .get(agentId, "high-risk-approval-0001") as { id: string };
  approveLowConfidenceIntake(
    riskStore,
    agentId,
    lowConfidenceApprovalRow.id,
    "high-risk-approval-0001",
    "fixture operator confirmed the human approval",
  );
  const effectiveApproval = currentIntake(riskStore, agentId, false);
  assert.equal(effectiveApproval.source, "operator-confirmed");
  assert.equal(effectiveApproval.result.intent, "approval");
  const riskApproval = (await settingsOperation(
    {
      operation: "auto-task",
      agentId,
      directory: repo,
      contract: highRiskRequest("ignored-high-risk-approval", "approve"),
    },
    options,
  )) as { key: string; state: string };
  assert.deepEqual(riskApproval, { key: highRiskResult.key, state: "APPROVAL_LINKED" });
  const approvalLinkRow = riskStore.db
    .prepare(
      "SELECT kind FROM events WHERE kind LIKE 'TASK_APPROVAL_LINK:%' ORDER BY sequence DESC LIMIT 1",
    )
    .get() as { kind: string };
  const approvalLink = JSON.parse(approvalLinkRow.kind.slice("TASK_APPROVAL_LINK:".length)) as {
    taskKey: string;
    contractHash: string;
    originalIntakeId: string;
    packageAssessmentId: string;
    packageId: string;
  };
  assert.equal(approvalLink.taskKey, highRiskResult.key);
  assert.equal(approvalLink.contractHash, highRiskTask.contract_hash);
  assert.equal(approvalLink.originalIntakeId, highRiskContract.intakeId);
  assert.equal(approvalLink.packageAssessmentId, highRiskContract.packageAssessmentId);
  assert.equal(approvalLink.packageId, `${highRiskContract.workflowId}/${highRiskContract.taskId}`);
  const approvedPlan = await riskEngine.plan(highRiskResult.key);
  assert.equal(approvedPlan.action, "start", JSON.stringify(approvedPlan));

  const seedVerification = (taskKey: string, attemptId: string) => {
    const task = riskStore.task(taskKey)!;
    const contract = contractSchema.parse(JSON.parse(task.contract_json));
    const diffHash = riskEngine.git.snapshot(contract).diffHash;
    const implementationAgentId = `implementation-${attemptId}`;
    const reviewerAgentId = `reviewer-${attemptId}`;
    const reviewResult = { diffHash, pass: true, unresolvedIssues: 0 };
    const checkResult = {
      build: { exit: 0, logHash: hash("build-ok"), quiescent: true },
      test: { exit: 0, logHash: hash("test-ok"), quiescent: true },
      diffHash,
      scopeViolations: 0,
      diffCheckExit: 0,
      changed: false,
    };
    riskStore.db
      .prepare(`INSERT INTO attempts(id,task_key,sequence,status,route_json,agent_id,fence,session_key,created_ms,result_hash,error_kind)
      VALUES(?,?,1,'VERIFY',?,?,1,?,?,NULL,NULL)`)
      .run(
        attemptId,
        taskKey,
        JSON.stringify(route),
        implementationAgentId,
        riskEngine.sessionKey(contract, route),
        Date.now(),
      );
    riskStore.db
      .prepare(`INSERT INTO leases(worktree,attempt_id,fence,state,heartbeat_ms) VALUES(?,?,1,'HELD',?)
      ON CONFLICT(worktree) DO UPDATE SET attempt_id=excluded.attempt_id,fence=excluded.fence,state=excluded.state,heartbeat_ms=excluded.heartbeat_ms`)
      .run(contract.worktree, attemptId, Date.now());
    riskStore.db
      .prepare("INSERT INTO review_runs VALUES(?,?,?,?,?,?,?)")
      .run(
        attemptId,
        `review-${attemptId}`,
        JSON.stringify(route),
        reviewerAgentId,
        "DONE",
        diffHash,
        JSON.stringify(reviewResult),
      );
    riskStore.db
      .prepare("INSERT INTO turn_checks VALUES(?,?,?)")
      .run(attemptId, diffHash, JSON.stringify(checkResult));
    return { contract, diffHash, implementationAgentId, reviewerAgentId };
  };
  const approvedProof = seedVerification(highRiskResult.key, "high-risk-approved-proof");
  const approvedVerification = riskEngine.verify("high-risk-approved-proof", {
    diffHash: approvedProof.diffHash,
    reviewedDiffHash: approvedProof.diffHash,
    implementationAgentId: approvedProof.implementationAgentId,
    reviewerAgentId: approvedProof.reviewerAgentId,
    buildExit: 0,
    testExit: 0,
    reviewPass: true,
    visualAcceptance: false,
    ownerApproved: false,
    scopeViolations: 0,
    unresolvedIssues: 0,
    artifacts: [configFile],
  });
  assert.equal(approvedVerification.ok, true, JSON.stringify(approvedVerification));

  await registerInput("high-risk-input-0002", "new task: update a second high-risk policy");
  const secondRiskResult = (await settingsOperation(
    {
      operation: "auto-task",
      agentId,
      directory: repo,
      contract: highRiskRequest("high-risk-two", "update a second high-risk policy"),
    },
    options,
  )) as { key: string; state: string };
  assert.equal(secondRiskResult.state, "READY");
  const secondRiskTask = riskStore.task(secondRiskResult.key)!;
  const secondRiskContract = contractSchema.parse(JSON.parse(secondRiskTask.contract_json));
  assert.notEqual(approvalLink.taskKey, secondRiskResult.key);
  assert.notEqual(approvalLink.contractHash, secondRiskTask.contract_hash);
  assert.notEqual(approvalLink.originalIntakeId, secondRiskContract.intakeId);
  assert.notEqual(approvalLink.packageAssessmentId, secondRiskContract.packageAssessmentId);
  assert.deepEqual(await riskEngine.plan(secondRiskResult.key), {
    action: "wait",
    reason: "owner-approval-required",
  });
  const unapprovedProof = seedVerification(secondRiskResult.key, "high-risk-unapproved-proof");
  const unapprovedVerification = riskEngine.verify("high-risk-unapproved-proof", {
    diffHash: unapprovedProof.diffHash,
    reviewedDiffHash: unapprovedProof.diffHash,
    implementationAgentId: unapprovedProof.implementationAgentId,
    reviewerAgentId: unapprovedProof.reviewerAgentId,
    buildExit: 0,
    testExit: 0,
    reviewPass: true,
    visualAcceptance: false,
    ownerApproved: true,
    scopeViolations: 0,
    unresolvedIssues: 0,
    artifacts: [configFile],
  });
  assert.equal(unapprovedVerification.ok, false);
  assert.ok(unapprovedVerification.reasons.includes("approval-required"));
  riskStore.close();
  closeRiskStore = () => {};
});
