import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { createPaseoApi, type PaseoAgentTimelineRefetchOptions } from "@getpaseo/client";
import { AgentTimelineEntryPayloadSchema } from "@getpaseo/protocol/messages";
import {
  editAutomation,
  readAutomation,
  taskDispatchAllowed,
  workflowStatus,
} from "../src/automation.ts";
import {
  intakeIdentity,
  intakeFactsSchema,
  packageIdentity,
  packageFactsSchema,
  type Assessment,
  type Classifier,
  type IntakeFacts,
  type IntakeResult,
  type PackageFacts,
  type PackageResult,
} from "../src/assessments.ts";
import { Engine } from "../src/engine.ts";
import {
  approveLowConfidenceIntake,
  approveIntakeModelAnswer,
  assertTaskAssessment,
  currentIntake,
  markIntakeClassificationPending,
} from "../src/intake.ts";
import { recordInternalMessageOrigins, rememberIntakeIdentity } from "../src/intake-identity.ts";
import {
  canonicalPath,
  configSchema,
  contractSchema,
  defaultDecisionSettings,
  routeSchema,
  hash,
  type Config,
  type Contract,
} from "../src/contracts.ts";
import { PaseoProvider, type Snapshot } from "../src/provider.ts";
import { settingsOperation, settingsView } from "../src/settings.ts";
import { readConfig } from "../src/settings-files.ts";
import { Store } from "../src/store.ts";
import { CredentialVault } from "../src/secrets.ts";
import { decisionHistory } from "../src/decision-history.ts";
import { Decisions } from "../src/decisions.ts";
import { createProfileRoute } from "../paseo-plugin/shared/routes.ts";
import { syncProfiles } from "../src/profiles.ts";

function followupDecisions(
  store: Store,
  options: {
    preserveConfidence?: number;
    intentConfidence?: number;
    intent?: string;
    needImplementation?: boolean;
    implementationConfidence?: number;
    onRequest?: () => void;
    beforeResponse?: Promise<void>;
  } = {},
): Decisions {
  return new Decisions(store, {
    credential: () => "synthetic-unit-credential",
    credentialRevision: () => "fixture",
    fetcher: async (_url, init) => {
      options.onRequest?.();
      await options.beforeResponse;
      const request = JSON.parse(String(init?.body));
      assert.equal(
        Object.hasOwn(JSON.parse(request.input), "dataScope"),
        false,
        "ignored legacy privacy metadata is not sent for model classification",
      );
      return new Response(
        JSON.stringify({
          model: "gpt-6-luna",
          answers: request.questions.map(
            (question: { name: string; choices: { value: string | boolean }[] }) => {
              let choice: string | boolean = question.name === "preserveExistingWork";
              if (question.name === "intent") choice = options.intent ?? "question";
              if (question.name === "needImplementation")
                choice = options.needImplementation ?? false;
              let confidence = 0.94;
              if (question.name === "intent") confidence = options.intentConfidence ?? 0.47;
              if (question.name === "needImplementation")
                confidence = options.implementationConfidence ?? 0.94;
              if (question.name === "preserveExistingWork")
                confidence = options.preserveConfidence ?? 0.94;
              return {
                type: "choice",
                name: question.name,
                choice,
                confidence,
                probabilities: question.choices.map((option) => ({
                  value: option.value,
                  probability:
                    option.value === choice ? 0.54 : 0.46 / (question.choices.length - 1),
                })),
              };
            },
          ),
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          },
        }),
      );
    },
  });
}

// Regression: an already authorized objective was blocked by an unrelated
// low-confidence intent, requiring another operator click after every question.
// Existing cases use confident fixture intents and never exercise Decisions here.
test("uncertain conversational intent preserves only the unchanged authorized work", async (t) => {
  const changedFacts: Record<string, Partial<IntakeFacts>> = {
    "legacy-data-classification": { dataScope: "restricted" },
    directory: { directory: path.dirname(process.cwd()) },
    origin: { origin: "unverified" },
  };
  const config = configSchema.parse({
    ...JSON.parse(readFileSync("config/controller.local.example.json", "utf8")),
    budgets: { decisions: 1000000, implementation: 0, "premium-api": 0, emergency: 0 },
    decisions: {
      ...defaultDecisionSettings(),
      enabled: true,
      fundsConfirmed: true,
      monthlyBudgetMicroUsd: 1000000,
      validUntil: "2099-01-01T00:00:00Z",
      dataScopes: ["public", "company"],
    },
  });
  for (const boundary of [
    "unchanged",
    "operator-confirmed",
    "no-original",
    "stop",
    "change",
    "legacy-data-classification",
    "directory",
    "origin",
    "uncertain",
    "confident-question-uncertain",
    "legacy",
    "uncertain-cancel",
    "contradictory-implementation",
  ] as const) {
    await t.test(boundary, async () => {
      const store = new Store(":memory:");
      try {
        const facts: IntakeFacts = {
          mainAgentId: "conversation-main",
          messageId: "original",
          origin: "human",
          directory: process.cwd(),
          text: "Implement the single public objective",
          dataScope: "public",
          knownFacts: [],
          messageRevision: 1,
          factsRevision: 1,
        };
        const original: Assessment<IntakeResult> = {
          id: intakeIdentity(facts),
          kind: "intake",
          factsHash: hash(facts),
          version: "intake-v3",
          source: "decisions",
          reason: "DECISIONS_INTAKE",
          result: {
            intent: "new-task",
            needImplementation: true,
            needExplorer: false,
            needPlanner: false,
            needAdvisor: false,
            extraReviewRecommended: false,
          },
        };
        if (boundary === "operator-confirmed") {
          original.source = "fallback";
          original.reason = "DECISIONS_LOW_CONFIDENCE";
          original.result = { ...original.result, intent: "other", needImplementation: false };
          original.answers = [
            { name: "intent", value: "new-task", confidence: 0.51 },
            { name: "needImplementation", value: true, confidence: 0.44 },
          ];
        }
        insertAssessment(store, original, facts, facts.mainAgentId);
        store.db
          .prepare("INSERT INTO internal_messages VALUES(?,?,?)")
          .run(facts.mainAgentId, facts.messageId, `human:${hash(facts.text)}`);
        store.db
          .prepare("INSERT INTO main_checkpoints(agent_id,message_id,work_intake_id) VALUES(?,?,?)")
          .run(facts.mainAgentId, facts.messageId, boundary === "no-original" ? null : original.id);
        if (boundary === "operator-confirmed")
          approveLowConfidenceIntake(
            store,
            facts.mainAgentId,
            original.id,
            facts.messageId,
            "synthetic original approval",
          );
        if (boundary === "stop" || boundary === "change") {
          const interveningFacts = {
            ...facts,
            messageId: "intervening",
            text: boundary === "stop" ? "Stop the work" : "Change the objective",
          };
          insertAssessment(
            store,
            {
              ...original,
              id: intakeIdentity(interveningFacts),
              factsHash: hash(interveningFacts),
              result: {
                ...original.result,
                intent: boundary === "stop" ? "cancel" : "change-request",
                needImplementation: false,
              },
            },
            interveningFacts,
            facts.mainAgentId,
          );
          store.db
            .prepare("INSERT INTO internal_messages VALUES(?,?,?)")
            .run(
              facts.mainAgentId,
              interveningFacts.messageId,
              `human:${hash(interveningFacts.text)}`,
            );
        }
        const followupFacts: IntakeFacts = {
          ...facts,
          messageId: "followup",
          text: "Erledigt, aber wieso musste ich das machen?",
          ...changedFacts[boundary],
        };
        const classifier = followupDecisions(store, {
          preserveConfidence: ["uncertain", "confident-question-uncertain"].includes(boundary)
            ? 0.4
            : 0.94,
          intentConfidence: boundary === "confident-question-uncertain" ? 0.94 : 0.47,
          intent: boundary === "uncertain-cancel" ? "cancel" : "question",
          needImplementation: boundary === "contradictory-implementation",
        });
        const followup = await classifier.classifyIntake(followupFacts, config);
        if (boundary !== "origin") {
          assert.equal(
            followup.source,
            boundary === "confident-question-uncertain" ? "decisions" : "fallback",
            "low intent confidence never authorizes a new objective",
          );
          assert.equal(followup.result.needImplementation, false);
        }
        store.db
          .prepare("INSERT INTO internal_messages VALUES(?,?,?)")
          .run(facts.mainAgentId, followupFacts.messageId, `human:${hash(followupFacts.text)}`);
        store.db
          .prepare("UPDATE main_checkpoints SET message_id=? WHERE agent_id=?")
          .run(followupFacts.messageId, facts.mainAgentId);
        if (boundary === "legacy") {
          const { preserveExistingWork: _omitted, ...legacy } = followup.result;
          insertAssessment(
            store,
            { ...followup, result: legacy },
            followupFacts,
            facts.mainAgentId,
          );
        }
        const cached = await classifier.classifyIntake(followupFacts, config);
        if (["unchanged", "operator-confirmed", "legacy-data-classification"].includes(boundary)) {
          assert.equal(
            currentIntake(store, facts.mainAgentId, true).id,
            original.id,
            "the question preserves exactly the original authorization without an operator click",
          );
          assert.equal(cached.result.preserveExistingWork, true);
        } else {
          const rejections: Record<string, RegExp> = {
            directory: /INTAKE_DIRECTORY_MISMATCH/,
            origin: /INTAKE_HUMAN_ORIGIN_UNCONFIRMED/,
            "no-original": /INTAKE_IMPLEMENTATION_NOT_AUTHORIZED/,
          };
          const rejection = rejections[boundary] ?? /INTAKE_SUPERSEDED/;
          assert.throws(() => currentIntake(store, facts.mainAgentId, true), rejection);
          if (boundary === "legacy")
            assert.equal(
              cached.result.preserveExistingWork,
              undefined,
              "old answers are never reinterpreted as a new preservation decision",
            );
        }
        assert.equal(
          store.db.prepare("SELECT count(*) AS n FROM decision_calls").get()!.n,
          boundary === "origin" ? 0 : 1,
          "immutable replay does not create another paid call",
        );
        assert.equal(
          store.db
            .prepare(
              "SELECT count(*) AS n FROM events WHERE kind LIKE 'OPERATOR_INTAKE_APPROVED:%'",
            )
            .get()!.n,
          boundary === "operator-confirmed" ? 1 : 0,
          "automatic preservation does not manufacture operator approval",
        );
      } finally {
        store.close();
      }
    });
  }
});

// A removed privacy gate must not permanently cache a never-attempted call, or
// replay a paid/uncertain call or reorder an older message during recovery.
test("only the latest unattempted local scope denial can enter its first Decisions call", async (t) => {
  const config = configSchema.parse({
    ...JSON.parse(readFileSync("config/controller.local.example.json", "utf8")),
    budgets: { decisions: 1000000, implementation: 0, "premium-api": 0, emergency: 0 },
    decisions: {
      ...defaultDecisionSettings(),
      enabled: true,
      fundsConfirmed: true,
      monthlyBudgetMicroUsd: 1000000,
      validUntil: "2099-01-01T00:00:00Z",
      dataScopes: [],
    },
  });
  for (const boundary of [
    "first-call",
    "SETTLED",
    "PENDING",
    "UNKNOWN",
    "facts-changed",
    "newer-message",
    "operator-approved",
    "already-recovered",
  ] as const) {
    await t.test(boundary, async () => {
      const store = new Store(":memory:");
      try {
        const facts = intakeFactsSchema.parse({
          mainAgentId: "legacy-scope-main",
          messageId: "actual-original-message",
          origin: "human",
          directory: process.cwd(),
          text: "Continue the original objective",
          dataScope: "personal",
          knownFacts: [],
          messageRevision: 1,
          factsRevision: 1,
        });
        const original: Assessment<IntakeResult> = {
          id: intakeIdentity(facts),
          kind: "intake",
          version: "intake-v3",
          factsHash: hash(facts),
          source: "fallback",
          reason: "DECISIONS_SCOPE_BLOCKED",
          result: {
            intent: "other",
            needImplementation: false,
            needPlanner: true,
            needExplorer: false,
            needAdvisor: false,
            extraReviewRecommended: false,
          },
        };
        const created = Date.now() - 100000;
        insertAssessment(store, original, facts, facts.mainAgentId);
        store.db
          .prepare("UPDATE assessments SET created_ms=? WHERE id=?")
          .run(created, original.id);
        if (["SETTLED", "PENDING", "UNKNOWN"].includes(boundary))
          store.db
            .prepare(
              "INSERT INTO decision_calls(key,cycle,state,reserved,created_ms) VALUES(?,?,?,?,?)",
            )
            .run(
              hash({ id: original.id, version: original.version }),
              new Date().toISOString().slice(0, 7),
              boundary,
              100,
              created,
            );
        if (boundary === "newer-message") {
          const newerFacts = { ...facts, messageId: "newer-real-message" };
          insertAssessment(
            store,
            { ...original, id: intakeIdentity(newerFacts), factsHash: hash(newerFacts) },
            newerFacts,
            facts.mainAgentId,
          );
        }
        if (boundary === "operator-approved")
          store.event(`OPERATOR_INTAKE_APPROVED:${JSON.stringify({ assessmentId: original.id })}`);
        if (boundary === "already-recovered")
          store.event(
            `DECISIONS_LOCAL_SCOPE_DENIAL_REOPENED:${JSON.stringify({ previous: { id: original.id } })}`,
          );
        let requests = 0;
        const classifier = followupDecisions(store, {
          onRequest: () => {
            requests++;
          },
        });
        if (boundary === "facts-changed") {
          await assert.rejects(
            () => classifier.classifyIntake({ ...facts, text: "Different objective" }, config),
            /ASSESSMENT_FACTS_CHANGED_USE_NEW_REVISION/,
          );
        } else {
          const [first, concurrent] = await Promise.all([
            classifier.classifyIntake(facts, config),
            classifier.classifyIntake(facts, config),
          ]);
          if (boundary === "first-call") {
            assert.notEqual(
              first.reason,
              "DECISIONS_SCOPE_BLOCKED",
              "the removed local gate cannot permanently block its first model query",
            );
            assert.equal(
              concurrent.reason,
              "DECISIONS_OUTCOME_PENDING",
              "a concurrent caller observes the same claim instead of sending twice",
            );
            assert.deepEqual(await classifier.classifyIntake(facts, config), first);
          } else
            assert.deepEqual(
              first,
              original,
              "an existing call, newer message or audited decision remains immutable",
            );
        }
        assert.equal(requests, boundary === "first-call" ? 1 : 0);
        const row = store.db
          .prepare("SELECT facts_json,result_json,state,created_ms FROM assessments WHERE id=?")
          .get(original.id) as {
          facts_json: string;
          result_json: string;
          state: string;
          created_ms: number;
        };
        assert.equal(row.facts_json, JSON.stringify(facts));
        if (boundary === "first-call") {
          assert.ok(
            row.created_ms > created,
            "the new claim has a real start time, not an expired legacy timestamp",
          );
          const audits = store.db
            .prepare(
              "SELECT kind FROM events WHERE kind LIKE 'DECISIONS_LOCAL_SCOPE_DENIAL_REOPENED:%'",
            )
            .all() as { kind: string }[];
          assert.equal(audits.length, 1);
          const previous = JSON.parse(
            audits[0].kind.slice(audits[0].kind.indexOf(":") + 1),
          ).previous;
          assert.deepEqual(JSON.parse(previous.result_json), original);
          assert.equal(previous.created_ms, created);
          assert.equal(previous.state, "SETTLED");
        } else {
          assert.equal(row.created_ms, created);
          assert.deepEqual(JSON.parse(row.result_json), original);
        }
        assert.equal(
          store.db.prepare("SELECT count(*) AS n FROM main_checkpoints").get()!.n,
          0,
          "recovery never repairs a checkpoint or write authorization",
        );
      } finally {
        store.close();
      }
    });
  }
});

// The model's UI answer must survive parsing without a second paid call; low
// confidence and cached old answers must not be presented as new UI evidence.
test("package Decisions records UI independently and preserves optional uncertainty and legacy cache", async () => {
  const store = new Store(":memory:");
  try {
    const config = configSchema.parse({
      ...JSON.parse(readFileSync("config/controller.local.example.json", "utf8")),
      budgets: { decisions: 1000000, implementation: 0, "premium-api": 0, emergency: 0 },
      decisions: {
        ...defaultDecisionSettings(),
        enabled: true,
        fundsConfirmed: true,
        monthlyBudgetMicroUsd: 1000000,
        validUntil: "2099-01-01T00:00:00Z",
        dataScopes: ["public"],
      },
    });
    let calls = 0,
      workConfidence = 0.95,
      selectedWorkKind = "ui";
    const classifier = new Decisions(store, {
      credential: () => "synthetic-unit-credential",
      credentialRevision: () => "fixture",
      fetcher: async (_url, init) => {
        calls++;
        const request = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            model: "gpt-6-luna",
            answers: request.questions.map(
              (question: { name: string; choices: { value: string | boolean }[] }) => {
                let choice: string | boolean = false;
                if (question.name === "workKind") {
                  assert.ok(
                    question.choices.some((option) => option.value === selectedWorkKind),
                    "Decisions sees exactly the frozen custom category choices",
                  );
                  choice = selectedWorkKind;
                } else if (question.name === "complexity") choice = "normal";
                const confidence = question.name === "workKind" ? workConfidence : 0.95;
                return {
                  type: "choice",
                  name: question.name,
                  choice,
                  confidence,
                  probabilities: question.choices.map((option) => ({
                    value: option.value,
                    probability:
                      option.value === choice
                        ? confidence
                        : (1 - confidence) / (question.choices.length - 1),
                  })),
                };
              },
            ),
            usage: {
              input_tokens: 100,
              input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            },
          }),
        );
      },
    });
    const facts = packageFactsSchema.parse({
      mainAgentId: "ui-model-main",
      intakeId: "a".repeat(64),
      packageId: "ui-package",
      repository: process.cwd(),
      baseCommit: "b".repeat(40),
      dataScope: "public",
      goal: "Implement the interface",
      acceptance: ["Interface works"],
      files: ["screen.tsx"],
      mutation: true,
      uiChanged: false,
      checks: { build: [process.execPath, "--version"], test: [process.execPath, "--version"] },
    });
    const ui = await classifier.classifyPackage(facts, config);
    assert.equal(ui.source, "decisions");
    assert.equal(
      ui.result.workKind,
      "ui",
      "the real Decisions response supplies UI without a Main flag",
    );
    assert.equal(ui.result.complexity, "normal");
    assert.deepEqual(await classifier.classifyPackage(facts, config), ui);
    assert.equal(calls, 1, "cached UI classification never creates a second call");
    workConfidence = 0.1;
    const uncertain = await classifier.classifyPackage(
      { ...facts, packageId: "uncertain-ui" },
      config,
    );
    assert.equal(uncertain.source, "decisions");
    assert.equal(
      uncertain.result.workKind,
      undefined,
      "uncertain UI is not fabricated as a model decision",
    );
    assert.match(uncertain.reason, /OPTIONAL_FALLBACK/);
    const legacyFacts = { ...facts, packageId: "legacy-ui" };
    const { workKind: _omitted, ...legacyResult } = ui.result;
    insertAssessment(
      store,
      {
        id: packageIdentity(legacyFacts),
        kind: "package",
        version: "package-v3",
        factsHash: hash(legacyFacts),
        source: "decisions",
        reason: "DECISIONS_PACKAGE",
        result: legacyResult,
      },
      legacyFacts,
      facts.mainAgentId,
    );
    const old = await classifier.classifyPackage(legacyFacts, config);
    assert.equal(old.result.workKind, undefined);
    assert.equal(calls, 2, "legacy assessments keep their immutable result and call identity");
    workConfidence = 0.95;
    selectedWorkKind = "db";
    const customFacts = {
      ...facts,
      packageId: "custom-db",
      workCategoryCatalog: [
        { id: "general", label: "Allgemein", description: "Other work" },
        { id: "db", label: "Datenbank", description: "Models and queries" },
      ],
      routingConfigIdentity: "c".repeat(64),
    };
    const custom = await classifier.classifyPackage(customFacts, config);
    assert.equal(custom.result.workKind, "db");
    assert.equal(calls, 3);
    await assert.rejects(
      () =>
        classifier.classifyPackage(
          {
            ...customFacts,
            workCategoryCatalog: [
              { id: "general", label: "General", description: "Changed catalog" },
            ],
          },
          config,
        ),
      /ASSESSMENT_FACTS_CHANGED/,
    );
    assert.equal(calls, 3, "catalog changes cannot replay a paid assessment");
  } finally {
    store.close();
  }
});

test("explicit model confirmation preserves the original human intake and cannot cover newer input", async (t) => {
  for (const blocked of [
    undefined,
    "new-pending",
    "changed-reply",
    "newer-input",
    "unverified-original",
    "unseen-timeline",
  ] as const) {
    await t.test(
      blocked ?? "bound confirmation supersedes only older legacy observations",
      async () => {
        const store = new Store(":memory:");
        try {
          const agentId = "confirmed-main";
          const facts: IntakeFacts = {
            mainAgentId: agentId,
            messageId: "original-human-message",
            origin: blocked === "unverified-original" ? "unverified" : "human",
            directory: process.cwd(),
            text: "Implement the public pilot fixture",
            dataScope: "public",
            knownFacts: [],
            messageRevision: 1,
            factsRevision: 1,
          };
          markIntakeClassificationPending(store, agentId, "legacy-transport-id");
          store.db
            .prepare("INSERT INTO internal_messages VALUES(?,?,?)")
            .run(agentId, facts.messageId, `human:${hash(facts.text)}`);
          store.event(
            `HUMAN_INPUT_RECEIPT:${JSON.stringify({ agentId, messageId: facts.messageId })}`,
          );
          const result: IntakeResult = {
            intent: "other",
            needImplementation: false,
            needExplorer: false,
            needPlanner: true,
            needAdvisor: false,
            extraReviewRecommended: false,
          };
          const original: Assessment<IntakeResult> = {
            id: intakeIdentity(facts),
            kind: "intake",
            factsHash: hash(facts),
            version: "intake-v3",
            source: "fallback",
            reason: "DECISIONS_LOW_CONFIDENCE",
            result,
            answers: [
              { name: "intent", value: "new-task", confidence: 0.74 },
              { name: "needImplementation", value: true, confidence: 0.1 },
            ],
          };
          insertAssessment(store, original, facts, agentId);
          const replyFacts: IntakeFacts = {
            ...facts,
            messageId: "actual-question-answer",
            text: "Confirm exactly this assessment",
            origin: "unverified",
          };
          const reply: Assessment<IntakeResult> = {
            id: intakeIdentity(replyFacts),
            kind: "intake",
            factsHash: hash(replyFacts),
            version: "intake-v3",
            source: "fallback",
            reason: "INTAKE_HUMAN_ORIGIN_UNCONFIRMED",
            result,
          };
          insertAssessment(store, reply, replyFacts, agentId);
          store.db
            .prepare("INSERT INTO main_checkpoints(agent_id,message_id) VALUES(?,?)")
            .run(agentId, replyFacts.messageId);
          const confirmation = {
            assessmentId: reply.id,
            messageId: replyFacts.messageId,
            assessmentHash: blocked === "changed-reply" ? "0".repeat(64) : hash(reply),
          };
          assert.throws(
            () =>
              approveLowConfidenceIntake(
                store,
                agentId,
                original.id,
                facts.messageId,
                "explicit user confirmation",
              ),
            /INTAKE_APPROVAL_SUPERSEDED/,
          );
          if (blocked === "new-pending")
            markIntakeClassificationPending(store, agentId, "unobserved-new-input");
          if (blocked === "newer-input") {
            const newerFacts = { ...replyFacts, messageId: "newer-unverified-input" };
            insertAssessment(
              store,
              { ...reply, id: intakeIdentity(newerFacts), factsHash: hash(newerFacts) },
              newerFacts,
              agentId,
            );
          }
          const client = {
            agents: {
              ref: () => ({
                id: agentId,
                runtimeInfo: { sessionId: "fixture-native-session" },
                refresh: async () => ({
                  agent: {
                    id: agentId,
                    provider: "codex",
                    cwd: facts.directory,
                    status: "idle",
                    activeTurn: false,
                    pendingPermissions: [],
                    runtimeInfo: { sessionId: "fixture-native-session" },
                  },
                }),
                timeline: {
                  refetch: async ({ projection }: { projection: string }) => ({
                    entries: [
                      {
                        timestamp: new Date().toISOString(),
                        seqStart: 1,
                        seqEnd: 1,
                        item: {
                          type: "user_message",
                          messageId:
                            blocked === "unseen-timeline"
                              ? "not-yet-classified-answer"
                              : replyFacts.messageId,
                          text: replyFacts.text,
                        },
                      },
                      {
                        timestamp: new Date().toISOString(),
                        seqStart: 2,
                        seqEnd: 2,
                        item:
                          projection === "projected"
                            ? {
                                type: "tool_call",
                                callId: "paseo-agent-message:operator-report",
                                name: "agent_message",
                                status: "completed",
                                error: null,
                                detail: {
                                  type: "plain_text",
                                  text: "Operator result; no human authorization",
                                  icon: "bot",
                                },
                                agentMessage: {
                                  event: "finished",
                                  sender: { id: "existing-operator" },
                                  text: "Operator result; no human authorization",
                                },
                              }
                            : {
                                type: "user_message",
                                messageId: "operator-report",
                                text: "Native agent report envelope",
                              },
                      },
                    ],
                    error: false,
                    gap: false,
                    hasOlder: false,
                    hasNewer: false,
                  }),
                },
              }),
            },
          } as unknown as Parameters<typeof approveIntakeModelAnswer>[1];
          const approve = () =>
            approveIntakeModelAnswer(
              store,
              client,
              { agentId, directory: facts.directory },
              {
                assessmentId: original.id,
                messageId: facts.messageId,
                reason: "explicit user confirmation",
                confirmation,
              },
            );
          if (blocked) {
            const errors = {
              "new-pending": /INTAKE_PENDING/,
              "changed-reply": /INTAKE_CONFIRMATION_IDENTITY_MISMATCH/,
              "unverified-original": /INTAKE_HUMAN_ORIGIN_UNCONFIRMED/,
              "newer-input": /INTAKE_APPROVAL_SUPERSEDED/,
              "unseen-timeline": /INTAKE_APPROVAL_SUPERSEDED/,
            };
            const error = errors[blocked];
            await assert.rejects(approve, error);
            assert.equal(
              store.db
                .prepare(
                  "SELECT count(*) AS n FROM events WHERE kind LIKE 'OPERATOR_INTAKE_APPROVED:%'",
                )
                .get()!.n,
              0,
            );
            return;
          }
          await approve();
          await approve();
          const active = currentIntake(store, agentId, true);
          assert.equal(
            active.id,
            original.id,
            "confirmation must authorize the original human request, never create replacement work",
          );
          assert.equal(active.source, "operator-confirmed");
          assert.equal(active.result.intent, "new-task");
          assert.equal(active.result.needImplementation, true);
          assert.equal(currentIntake(store, agentId, false).id, original.id);
          assert.equal(
            store.db
              .prepare("SELECT count(*) AS n FROM internal_messages WHERE message_id=?")
              .get(replyFacts.messageId)!.n,
            0,
            "confirmation must not manufacture a human receipt",
          );
          assert.deepEqual(
            JSON.parse(
              (
                store.db
                  .prepare("SELECT result_json FROM assessments WHERE id=?")
                  .get(original.id) as { result_json: string }
              ).result_json,
            ),
            original,
          );
          assert.equal(
            store.db
              .prepare(
                "SELECT count(*) AS n FROM events WHERE kind LIKE 'OPERATOR_INTAKE_APPROVED:%'",
              )
              .get()!.n,
            1,
          );
          const newerFacts = { ...replyFacts, messageId: "later-real-input" };
          insertAssessment(
            store,
            { ...reply, id: intakeIdentity(newerFacts), factsHash: hash(newerFacts) },
            newerFacts,
            agentId,
          );
          assert.throws(
            () => currentIntake(store, agentId, true),
            /INTAKE_HUMAN_ORIGIN_UNCONFIRMED/,
            "a prior confirmation cannot cover a subsequent input",
          );
        } finally {
          store.close();
        }
      },
    );
  }
});

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
    const originalLocalDenial = facts.text === "new task: implement the initial objective";
    if (originalLocalDenial && !existing) {
      const legacyFacts = intakeFactsSchema.parse({ ...facts, dataScope: "personal" });
      const denial: Assessment<IntakeResult> = {
        id,
        kind: "intake",
        version: "intake-v3",
        factsHash: hash(legacyFacts),
        source: "fallback",
        reason: "DECISIONS_SCOPE_BLOCKED",
        result: {
          intent: "other",
          needImplementation: false,
          needExplorer: false,
          needPlanner: true,
          needAdvisor: false,
          extraReviewRecommended: false,
        },
      };
      insertAssessment(this.store, denial, legacyFacts, facts.mainAgentId);
      return denial;
    }
    if (originalLocalDenial || facts.text === "Erledigt, aber wieso musste ich das machen?")
      return followupDecisions(
        this.store,
        originalLocalDenial
          ? { intent: "new-task", intentConfidence: 0.94, needImplementation: true }
          : {},
      ).classifyIntake(facts, {
        ..._config,
        budgets: { ..._config.budgets, decisions: 1000000 },
        decisions: {
          ...defaultDecisionSettings(),
          enabled: true,
          fundsConfirmed: true,
          monthlyBudgetMicroUsd: 1000000,
          validUntil: "2099-01-01T00:00:00Z",
          dataScopes: ["public"],
        },
      });
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
      workKind: facts.goal === "UI initial objective" ? "ui" : "general",
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

// Consequential regression: the public worktree operation succeeds, but registration
// pins an umbrella main workspace and prevents any isolated implementation worker.
test("public automatic worktree registration pins the source workspace and preserves the main parent", async (t) => {
  const directory = mkdtempSync(path.join(process.cwd(), ".placement-intake-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const mainDirectory = path.join(directory, "main"),
    repository = path.join(mainDirectory, "repository"),
    controllerRoot = path.join(directory, "controller");
  mkdirSync(repository, { recursive: true });
  mkdirSync(controllerRoot, { recursive: true });
  const git = gitExecutable();
  runGit(git, ["init", "-b", "main"], repository);
  runGit(git, ["config", "core.autocrlf", "false"], repository);
  runGit(git, ["config", "user.name", "Paseo test"], repository);
  runGit(git, ["config", "user.email", "paseo-test@example.invalid"], repository);
  writeFileSync(
    path.join(repository, "greeting.mjs"),
    "export const greet = name => `Hello ${name}`;\n",
  );
  runGit(git, ["add", "."], repository);
  runGit(git, ["commit", "-m", "fixture"], repository);
  const baseCommit = runGit(git, ["rev-parse", "HEAD"], repository);
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
    routes: [
      {
        id: "placement-codex",
        access: "codex-pro200",
        provider: "codex",
        model: "fixture-model",
        revision: "fixture",
        reasoning: "high",
        tier: 3,
        enabled: true,
        maxConcurrent: 1,
        dataScopes: ["public"],
        capabilities: ["code"],
      },
    ],
  });
  const configFile = path.join(controllerRoot, "controller.json"),
    database = path.join(controllerRoot, "controller.sqlite"),
    agentId = "existing-placement-main";
  writeFileSync(configFile, JSON.stringify(config));
  const main = {
    id: agentId,
    workspaceId: "main-workspace",
    cwd: mainDirectory,
    provider: "codex",
    status: "idle",
    activeTurn: false,
    pendingPermissions: [],
    runtimeInfo: { sessionId: "placement-native-session" },
    labels: { orchestratorScope: "public" },
  };
  const originalMain = structuredClone(main);
  const messageId = "placement-human-input-0001",
    text = "new task: fix greeting.mjs";
  let worktree = "",
    sourceOpens = 0;
  const sourceWorkspace = {
    id: "source-workspace",
    refresh: async () => ({ workspaceDirectory: worktree }),
    agents: {
      create: async () => {
        throw Error("Registration must not start a worker");
      },
    },
  };
  const provider = new PaseoProvider(config.daemonUrl);
  Object.assign(provider, {
    connect: async () => {},
    close: async () => {},
    client: {
      agents: {
        ref: () => ({
          id: agentId,
          runtimeInfo: main.runtimeInfo,
          refresh: async () => ({ agent: main }),
          timeline: {
            refetch: async () => ({
              entries: [
                {
                  timestamp: new Date().toISOString(),
                  seqStart: 1,
                  seqEnd: 1,
                  item: { type: "user_message", clientMessageId: messageId, messageId, text },
                },
              ],
              error: false,
              gap: false,
              hasOlder: false,
              hasNewer: false,
              startCursor: { epoch: "placement-native-session", seq: 1 },
              endCursor: { epoch: "placement-native-session", seq: 1 },
            }),
          },
          backgroundWork: {
            refresh: async () => ({
              agentId,
              providerSessionId: "placement-native-session",
              observationId: "placement-fresh-observation",
              coverage: "codex_background_terminals",
              queriedProviderSessionIds: ["placement-native-session"],
              items: [],
              providerSubagents: [],
            }),
          },
        }),
      },
      workspaces: {
        ref: (id: string) => {
          if (id === sourceWorkspace.id) return sourceWorkspace;
          assert.equal(id, main.workspaceId);
          return {
            refresh: async () => ({ workspaceDirectory: mainDirectory }),
            agents: {
              create: async () => {
                throw Error("Worker must not run in the main workspace");
              },
            },
          };
        },
        open: async (selected: string) => {
          sourceOpens++;
          if (canonicalPath(selected) === canonicalPath(worktree)) return sourceWorkspace;
          return {
            id: "other-source-workspace",
            refresh: async () => ({ workspaceDirectory: selected }),
          };
        },
      },
    },
  });
  const options = {
    file: configFile,
    database,
    vault: new CredentialVault(controllerRoot),
    providerFactory: () => provider,
    classifierFactory: (store: Store) => new FixtureClassifier(store),
  };
  editAutomation(
    agentId,
    () => ({
      agentId,
      directory: canonicalPath(mainDirectory),
      state: "ready",
      requestId: "placement-prepared-main",
      protocolVersion: 3,
      taskKeys: [],
      wakeCount: 0,
      wakeBaseline: {},
    }),
    controllerRoot,
  );
  await settingsOperation(
    { operation: "auto-input", agentId, directory: mainDirectory, messageId, text },
    options,
  );
  const observed = (await settingsOperation(
    { operation: "auto-interpret", agentId, directory: mainDirectory },
    options,
  )) as { input: { intakeId: string; factsHash: string; previousWorkIntakeId: string | null } };
  await settingsOperation(
    {
      operation: "auto-interpret",
      agentId,
      directory: mainDirectory,
      interpretation: {
        version: 1,
        intakeId: observed.input.intakeId,
        factsHash: observed.input.factsHash,
        previousWorkIntakeId: observed.input.previousWorkIntakeId,
        action: "start",
      },
    },
    options,
  );
  const created = (await settingsOperation(
    {
      operation: "auto-worktree",
      agentId,
      directory: mainDirectory,
      repository,
      slug: "placement-worker",
    },
    options,
  )) as { worktree: string };
  worktree = created.worktree;
  const contract = contractSchema.parse({
    workflowId: "placement",
    taskId: "greeting",
    repository,
    worktree,
    baseCommit,
    dataScope: "restricted",
    role: "implement-simple",
    prompt: "Fix greeting.mjs",
    acceptance: ["Greeting is correct"],
    allowedPaths: ["greeting.mjs"],
    requiredCapabilities: ["code"],
    minTier: 1,
    mutation: true,
    highRisk: false,
    uiChanged: false,
    estimatedMicroUsd: 0,
    checks: {
      build: [process.execPath, "--check", "greeting.mjs"],
      test: [process.execPath, "--check", "greeting.mjs"],
    },
  });
  const register = (value: Contract) =>
    settingsOperation(
      {
        operation: "auto-task",
        agentId,
        directory: mainDirectory,
        contract: value,
        packageInterpretation: {
          complexity: "simple",
          workKind: "general",
          additionalPlanning: false,
          advisorNeeded: false,
        },
      },
      options,
    );
  const registered = (await register(contract)) as { key: string; state: string };
  assert.equal(registered.state, "READY");
  assert.deepEqual(await register(contract), registered, "registration remains idempotent");
  const store = new Store(database);
  try {
    const saved = contractSchema.parse(JSON.parse(store.task(registered.key)!.contract_json));
    assert.deepEqual(saved.workspace, {
      id: sourceWorkspace.id,
      directory: canonicalPath(worktree),
      mainAgentId: agentId,
    });
    assert.deepEqual(saved.allowedPaths, ["greeting.mjs"]);
    assert.equal(
      (store.db.prepare("SELECT COUNT(*) AS count FROM tasks").get() as { count: number }).count,
      1,
    );
    assert.deepEqual(main, originalMain);
    assert.equal(readAutomation(controllerRoot).mains[0].workerPlacement, undefined);

    const outside = path.join(directory, "unapproved-worktree");
    runGit(
      git,
      ["worktree", "add", "-b", "feature/unapproved-worktree", outside, baseCommit],
      repository,
    );
    const previousOpens = sourceOpens;
    await assert.rejects(
      register({ ...contract, taskId: "outside", worktree: outside }),
      /AUTOMATION_WORKTREE_MISMATCH/,
    );
    await assert.rejects(
      register({ ...contract, taskId: "foreign", repository: process.cwd() }),
      /AUTOMATION_REPOSITORY_MISMATCH/,
    );
    assert.equal(sourceOpens, previousOpens, "unapproved source paths cannot create a workspace");
    assert.equal(
      (store.db.prepare("SELECT COUNT(*) AS count FROM tasks").get() as { count: number }).count,
      1,
    );
  } finally {
    store.close();
  }
});

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
  // Legacy configurations retain their role lists until UI is explicitly configured.
  assert.equal(config.roleRoutes?.ui, undefined);
  writeFileSync(configFile, JSON.stringify(config));
  const messages: {
    id: string;
    text: string;
    timestamp: string;
    nativeId?: string;
    observedProviderId?: string;
    liveMessageId?: string;
    replayedClientId?: string;
  }[] = [];
  let rehydratedHistory = false;
  let historyGap = false;
  let sessionChangesDuringHistory = false;
  const historyReads: string[] = [];
  const timelinePage = async (request: PaseoAgentTimelineRefetchOptions = {}) => {
    historyReads.push(request.direction ?? "tail");
    const olderEntries = Array.from({ length: rehydratedHistory ? 220 : 0 }, (_, index) => ({
      timestamp: index < 2 ? "2025-01-02T00:00:00.000Z" : "2026-01-01T00:00:00.000Z",
      seqStart: index + 1,
      seqEnd: index + 1,
      item:
        index < 2
          ? {
              type: "user_message",
              messageId: `33333333-3333-7333-8333-33333333333${index}`,
              text: "Old duplicate internal transport",
            }
          : { type: "assistant_message", text: "Earlier safe fixture activity" },
    }));
    const all = [
      ...olderEntries,
      ...messages.map((message, index) => ({
        timestamp: message.timestamp,
        seqStart: olderEntries.length + index + 1,
        seqEnd: olderEntries.length + index + 1,
        ...(!rehydratedHistory && message.nativeId
          ? { providerMessageId: message.observedProviderId ?? message.nativeId }
          : {}),
        item: {
          type: "user_message",
          clientMessageId:
            rehydratedHistory && message.nativeId ? message.replayedClientId : message.id,
          messageId: rehydratedHistory
            ? (message.nativeId ?? message.id)
            : (message.liveMessageId ?? message.id),
          text: message.text,
        },
      })),
    ];
    const end = request.direction === "before" ? request.cursor!.seq - 1 : all.length;
    const start = rehydratedHistory ? Math.max(0, end - (request.limit ?? 200)) : 0;
    if (sessionChangesDuringHistory && request.direction === "before") {
      providerSessionId = "foreign-native-session";
      sessionChangesDuringHistory = false;
    }
    return {
      entries: all.slice(start, end),
      error: false,
      gap: historyGap,
      hasOlder: start > 0,
      hasNewer: false,
      startCursor: { epoch: "fixture-session", seq: start + 1 },
      endCursor: { epoch: "fixture-session", seq: end },
    };
  };
  let backgroundActive: boolean | null = false;
  let savedSessionId: string | null = null;
  let providerSessionId = "fixture-session";
  let finalTimelineSessionChange = false;
  let recoveryHistoryReads = 0;
  const mainSnapshot = (id: string, sessionId = savedSessionId) => ({
    id,
    cwd: repo,
    provider: "codex/codex",
    status: "idle",
    activeTurn: false,
    pendingPermissions: [],
    runtimeInfo: { sessionId },
    labels: { orchestratorScope: "public" },
  });
  const timelineApi = createPaseoApi({
    getLastServerInfoMessage: () => ({ serverId: "fixture-server" }),
    fetchAgent: async ({ agentId: requestedId }: { agentId: string }) => ({
      agent: mainSnapshot(requestedId),
    }),
    fetchAgentTimeline: async (id: string, request: Parameters<typeof timelinePage>[0]) => {
      const page = await timelinePage(request);
      if (finalTimelineSessionChange && request?.direction === "before") recoveryHistoryReads++;
      return {
        ...page,
        agent: mainSnapshot(
          id,
          finalTimelineSessionChange && recoveryHistoryReads === 2
            ? "different-final-timeline-session"
            : savedSessionId,
        ),
        entries: page.entries.map((entry) =>
          AgentTimelineEntryPayloadSchema.parse({
            ...entry,
            provider: "codex",
            collapsed: [],
            sourceSeqRanges: [{ startSeq: entry.seqStart, endSeq: entry.seqEnd }],
          }),
        ),
      };
    },
  } as unknown as Parameters<typeof createPaseoApi>[0]);
  t.after(() => timelineApi.dispose());
  const client = {
    workspaces: {
      open: async (directory: string) => ({
        id: "fixture-worker-workspace",
        refresh: async () => ({ workspaceDirectory: directory }),
      }),
    },
    agents: {
      ref: (id: string) => {
        const handle = timelineApi.agents.ref(id);
        handle.backgroundWork.refresh = async () => ({
          agentId: id,
          providerSessionId,
          observationId: "fresh-session-identity",
          coverage: "codex_background_terminals",
          queriedProviderSessionIds: [providerSessionId],
          items: [],
          providerSubagents: [],
        });
        return handle;
      },
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
      {
        provider: "claude",
        status: "ready",
        models: [{ id: "fixture-ui-model", thinking: ["high"] }],
        modes: [],
      },
      {
        provider: "claude-private",
        status: "ready",
        models: [{ id: "fixture-ui-model", thinking: ["high"] }],
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
  // Concrete regression: a saved UI preference was ignored because assessment
  // assigns implement-normal. Exercise real save/readback, V3 package binding
  // and Engine.plan; no paid Decisions or provider executions are needed.
  const privateProfile = {
    id: "private-ui-profile",
    name: "OpusP fixture",
    provider: "claude-private",
    model: "fixture-ui-model",
    thinkingOptionId: "high",
  };
  const privateRoute = createProfileRoute(
    privateProfile,
    [{ id: "fixture-ui-model", thinkingOptions: [{ id: "high" }] }],
    config.routes,
  );
  assert.equal(privateRoute.access, "claude-personal-pro");
  assert.equal(privateRoute.enabled, false, "adding a profile never grants activation");
  assert.equal(privateRoute.bucket, undefined, "a native private subscription has no API bucket");
  const approvedPrivate = {
    ...privateRoute,
    enabled: true,
    repositoryRoots: [root],
    dataScopes: ["public", "company"],
  };
  assert.equal(routeSchema.parse(approvedPrivate).provider, "claude-private");
  assert.throws(() => routeSchema.parse({ ...approvedPrivate, access: "claude-company-pro" }));
  assert.throws(() => routeSchema.parse({ ...approvedPrivate, bucket: "implementation" }));
  const savedView = (await settingsOperation(
    {
      operation: "save",
      revision: hash(config),
      config: {
        ...config,
        roleRoutes: { ...config.roleRoutes, ui: ["test-claude-ui", privateRoute.id, "test-codex"] },
        workCategories: [
          {
            id: "db",
            label: "Datenbank",
            description: "Datenmodelle und Abfragen",
            routeIds: ["test-codex", privateRoute.id],
          },
        ],
        routes: [
          ...config.routes,
          {
            ...route,
            id: "test-claude-ui",
            provider: "claude",
            access: "claude-company-pro",
            model: "fixture-ui-model",
            tier: 2,
            repositoryRoots: [root],
          },
          approvedPrivate,
        ],
      },
    },
    options,
  )) as { config: Config };
  const savedConfig = syncProfiles(readConfig(configFile), [privateProfile]);
  assert.deepEqual(savedConfig.roleRoutes?.ui, ["test-claude-ui", privateRoute.id, "test-codex"]);
  assert.deepEqual(savedView.config.roleRoutes?.ui, savedConfig.roleRoutes?.ui);
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
  const registerInput = async (id: string, text: string, retainedLegacy = true) => {
    messages.push({ id, text, timestamp: new Date(Date.now() + messages.length).toISOString() });
    await settingsOperation(
      { operation: "auto-input", agentId, directory: repo, messageId: id, text },
      options,
    );
    // These existing sequences exercise retained pre-upgrade assessments and
    // their historical authorization/repair paths. New Main-authority cases
    // below deliberately use fresh facts through the public capture path.
    if (retainedLegacy) {
      const legacyStore = new Store(database);
      try {
        await new FixtureClassifier(legacyStore).classifyIntake(
          intakeFactsSchema.parse({
            mainAgentId: agentId,
            messageId: id,
            origin: "human",
            directory: repo,
            text,
          }),
          savedConfig,
        );
      } finally {
        legacyStore.close();
      }
    } else {
      const pendingStore = new Store(database);
      try {
        markIntakeClassificationPending(pendingStore, agentId, id);
      } finally {
        pendingStore.close();
      }
    }
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
  const localDenialStore = new Store(database);
  const denied = currentIntake(localDenialStore, agentId, false);
  assert.equal(denied.reason, "DECISIONS_SCOPE_BLOCKED");
  assert.equal(localDenialStore.db.prepare("SELECT count(*) AS n FROM decision_calls").get()!.n, 0);
  localDenialStore.close();
  // The normal polling callback must recover the same unreadied input without
  // another Composer message, operator action or manufactured receipt.
  await settingsOperation({ operation: "auto-intake", agentId, directory: repo }, options);
  const beforeQuestion = new Store(database);
  const originalIntakeId = currentIntake(beforeQuestion, agentId, true).id;
  assert.equal(
    originalIntakeId,
    denied.id,
    "normal capture retains the exact original message and assessment identity",
  );
  assert.equal(beforeQuestion.db.prepare("SELECT count(*) AS n FROM decision_calls").get()!.n, 1);
  // Isolated fixture of a caller crash after model settlement but before the
  // ordinary work binding. Recovery must reuse its settled result, never pay twice.
  beforeQuestion.db
    .prepare("UPDATE main_checkpoints SET work_intake_id=NULL WHERE agent_id=?")
    .run(agentId);
  beforeQuestion.close();
  await settingsOperation({ operation: "auto-intake", agentId, directory: repo }, options);
  const resumedBinding = new Store(database);
  assert.equal(currentIntake(resumedBinding, agentId, true).id, originalIntakeId);
  assert.equal(resumedBinding.db.prepare("SELECT count(*) AS n FROM decision_calls").get()!.n, 1);
  resumedBinding.close();
  await registerInput(
    "informative-before-registration",
    "Erledigt, aber wieso musste ich das machen?",
  );
  const originalResult = (await settingsOperation(
    {
      operation: "auto-task",
      agentId,
      directory: repo,
      contract: taskRequest("initial", "UI initial objective"),
    },
    options,
  )) as { key: string; state: string };
  assert.equal(originalResult.state, "READY");
  const store = new Store(database);
  const originalTask = store.task(originalResult.key)!;
  const originalContract = contractSchema.parse(JSON.parse(originalTask.contract_json));
  assert.equal(
    originalContract.intakeId,
    originalIntakeId,
    "first registration after a question binds the original work order, not replacement work",
  );
  await t.test(
    "saved UI routes preserve package binding, safety filters and legacy routing",
    async () => {
      const routingEngine = new Engine(
        store,
        savedConfig,
        fakeProvider,
        undefined,
        undefined,
        (key) => taskDispatchAllowed(key, vaultRoot),
      );
      assert.equal(originalContract.role, "implement-normal");
      assert.equal(originalContract.minTier, 2);
      assert.equal(originalContract.uiChanged, false);
      assert.equal(originalContract.workKind, "ui");
      const uiPlan = await routingEngine.plan(originalResult.key);
      assert.equal(uiPlan.route?.provider, "claude", "UI work uses the saved provider preference");
      assert.equal(uiPlan.routing?.category, "ui");
      assert.throws(
        () => assertTaskAssessment(store, savedConfig, { ...originalContract, uiChanged: true }),
        /PACKAGE_EXECUTION_FACTS_MISMATCH/,
        "routing work kind cannot diverge from assessed execution facts",
      );
      assert.throws(
        () =>
          assertTaskAssessment(store, savedConfig, { ...originalContract, workKind: "general" }),
        /PACKAGE_WORK_KIND_MISMATCH/,
      );
      store.blockAccess("claude-company-pro", "fixture-unavailable", null);
      const privateFallback = await routingEngine.plan(originalResult.key);
      assert.equal(
        privateFallback.route?.provider,
        "claude-private",
        "company quota cannot suppress the separate private account",
      );
      assert.equal(privateFallback.route?.access, "claude-personal-pro");
      store.blockAccess("claude-personal-pro", "fixture-unavailable", null);
      const uiFallback = await routingEngine.plan(originalResult.key);
      assert.equal(uiFallback.route?.id, "test-codex");
      assert.deepEqual(uiFallback.routing?.skipped, [
        { routeId: "test-claude-ui", reason: "confirmed-provider-or-route-circuit" },
        { routeId: privateRoute.id, reason: "confirmed-provider-or-route-circuit" },
      ]);
      store.blockAccess("route:test-codex", "fixture-unavailable", null);
      const uiWaiting = await routingEngine.plan(originalResult.key);
      assert.equal(uiWaiting.action, "wait");
      assert.equal(uiWaiting.reason, "ui-no-safe-and-funded-candidate");
      assert.equal(uiWaiting.routing?.skipped?.length, 3);
      store.db.prepare("DELETE FROM circuits WHERE reason=?").run("fixture-unavailable");

      // A UI route below the assessed tier must not be selected merely due to priority.
      const lowTierConfig = configSchema.parse({
        ...savedConfig,
        routes: savedConfig.routes.map((candidate) =>
          candidate.provider === "claude" || candidate.provider === "claude-private"
            ? { ...candidate, tier: 1 }
            : candidate,
        ),
      });
      // Separate legacy admissions never change the immutable V3 task/configuration
      // or manufacture assessment/authorization records for the active workflow.
      for (const scenario of [
        { name: "legacy-without-ui", config, expectedRoute: "test-codex" },
        { name: "ui-tier-fallback", config: lowTierConfig, expectedRoute: "test-codex" },
        {
          name: "ui-list-exhausted",
          config: {
            ...lowTierConfig,
            roleRoutes: { ...lowTierConfig.roleRoutes!, ui: ["test-claude-ui"] },
          },
          expectedRoute: undefined,
        },
      ]) {
        const legacyStore = new Store(":memory:");
        try {
          const legacyConfig = configSchema.parse({ ...scenario.config, orchestrationVersion: 2 });
          const legacyKey = legacyStore.add(
            { ...taskRequest(scenario.name, "legacy UI objective"), uiChanged: true },
            legacyConfig,
          );
          const legacyEngine = new Engine(
            legacyStore,
            legacyConfig,
            fakeProvider,
            undefined,
            undefined,
            () => true,
          );
          const legacyPlan = await legacyEngine.plan(legacyKey);
          assert.equal(legacyPlan.route?.id, scenario.expectedRoute, scenario.name);
          if (!scenario.expectedRoute) {
            assert.equal(legacyPlan.reason, "ui-no-safe-and-funded-candidate");
            assert.deepEqual(legacyPlan.routing?.skipped, [
              { routeId: "test-claude-ui", reason: "quality-tier-insufficient" },
            ]);
          }
          const legacyView = settingsView(legacyStore, config, options.vault);
          assert.equal(legacyView.config.roleRoutes?.ui, undefined);
        } finally {
          legacyStore.close();
        }
      }
    },
  );
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
  assert.deepEqual(pendingStatus.writeAuthorization, { allowed: true, reason: "AUTHORIZED_INPUT" });
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
  assert.deepEqual(
    await settingsOperation(
      {
        operation: "auto-task",
        agentId,
        directory: repo,
        contract: taskRequest("wrong-target", "approve"),
      },
      options,
    ),
    { state: "WAITING", reason: "APPROVAL_TARGET_REQUIRED" },
    "an explicit wrong target must not select the sole paused task",
  );
  const approval = (await settingsOperation(
    {
      operation: "auto-task",
      agentId,
      directory: repo,
      contract: taskRequest("initial", "approve"),
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
  const nonUiEngine = new Engine(
    afterAmendment,
    savedConfig,
    fakeProvider,
    undefined,
    undefined,
    (key) => taskDispatchAllowed(key, vaultRoot),
  );
  const nonUiPlan = await nonUiEngine.plan(amended.key);
  assert.equal(nonUiPlan.route?.id, "test-codex", "non-UI amendments keep ordinary role routing");
  assert.equal(nonUiPlan.routing?.category, undefined);
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

  // A named P1 approval must work within a real multi-package plan, without
  // approving P3 or revoking the original authority of ordinary P2 work.
  const registerPlannedTask = async (contract: Contract) =>
    (await settingsOperation(
      { operation: "auto-task", agentId, directory: repo, contract },
      options,
    )) as { key: string; state: string };
  const siblingRisk = await registerPlannedTask(highRiskRequest("planned-p3", "P3 backend"));
  const ordinary = await registerPlannedTask({
    ...taskRequest("planned-p2", "P2 validation"),
    worktree: riskWorktree,
  });
  assert.equal(siblingRisk.state, "READY");
  assert.equal(ordinary.state, "READY");
  const ordinaryContract = contractSchema.parse(
    JSON.parse(riskStore.task(ordinary.key)!.contract_json),
  );

  await registerInput(
    "high-risk-approval-0001",
    "low-confidence approval for the high-risk policy task",
  );
  const waitingForOperatorApproval = (await settingsOperation(
    {
      operation: "auto-task",
      agentId,
      directory: repo,
      contract: highRiskContract,
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
  assert.doesNotThrow(() => assertTaskAssessment(riskStore, config, ordinaryContract));
  assert.equal(
    (await riskEngine.plan(ordinary.key)).action,
    "start",
    "an unlinked accepted approval is not a revocation of the original normal work order",
  );
  const history = decisionHistory(
    riskStore,
    repo,
    agentId,
    lowConfidenceApprovalRow.id,
    undefined,
    vaultRoot,
  );
  assert.equal(
    history.detail?.source,
    "operator-confirmed",
    "history must show the effective confirmation alongside immutable model diagnostics",
  );
  assert.equal(
    history.detail?.approval,
    undefined,
    "a confirmed model answer must not offer another approval action",
  );
  const registered = riskStore.db
    .prepare("SELECT created_ms FROM task_assessments WHERE task_key=?")
    .get(highRiskResult.key) as { created_ms: number };
  const approvalCreated = riskStore.db
    .prepare("SELECT created_ms FROM assessments WHERE id=?")
    .get(effectiveApproval.id) as { created_ms: number };
  // Isolated registration-order fault: the same accepted message must not
  // authorize a package registered only after that message was assessed.
  riskStore.db
    .prepare("UPDATE task_assessments SET created_ms=? WHERE task_key=?")
    .run(approvalCreated.created_ms + 1, highRiskResult.key);
  assert.deepEqual(
    await registerPlannedTask(highRiskRequest("high-risk-one", "approve")),
    { state: "WAITING", reason: "APPROVAL_TARGET_REQUIRED" },
    "registration after approval cannot inherit earlier authority",
  );
  riskStore.db
    .prepare("UPDATE task_assessments SET created_ms=? WHERE task_key=?")
    .run(registered.created_ms, highRiskResult.key);
  const riskApproval = (await settingsOperation(
    {
      operation: "auto-task",
      agentId,
      directory: repo,
      contract: highRiskContract,
    },
    options,
  )) as { key: string; state: string };
  assert.deepEqual(riskApproval, { key: highRiskResult.key, state: "APPROVAL_LINKED" });
  assert.deepEqual(
    await registerPlannedTask(highRiskRequest("high-risk-one", "unchanged approval retry")),
    riskApproval,
    "the same assessment and target are idempotent",
  );
  assert.deepEqual(
    await registerPlannedTask(highRiskRequest("planned-p3", "approve another task")),
    { state: "WAITING", reason: "APPROVAL_TARGET_REQUIRED" },
    "one accepted assessment cannot be reassigned to P3",
  );
  assert.deepEqual(
    await registerPlannedTask({ ...highRiskContract, taskId: "unknown-target" }),
    { state: "WAITING", reason: "APPROVAL_TARGET_REQUIRED" },
    "an explicit unknown target never falls back to another candidate",
  );
  assert.deepEqual(
    await registerPlannedTask({
      ...highRiskContract,
      workflowId: `auto-${hash("another-main").slice(0, 12)}-followup`,
    }),
    { state: "WAITING", reason: "APPROVAL_TARGET_REQUIRED" },
    "a stored-looking workflow from another main cannot select this main's P1",
  );
  assert.doesNotThrow(() => assertTaskAssessment(riskStore, config, ordinaryContract));
  assert.equal((await riskEngine.plan(ordinary.key)).action, "start");
  assert.deepEqual(await riskEngine.plan(siblingRisk.key), {
    action: "wait",
    reason: "owner-approval-required",
  });
  assert.equal(riskStore.task(highRiskResult.key)!.contract_hash, highRiskTask.contract_hash);
  assert.equal(
    riskStore.db
      .prepare(
        "SELECT count(*) AS n FROM events WHERE kind LIKE 'TASK_APPROVAL_LINK:%' AND json_extract(substr(kind,20),'$.approvalAssessmentId')=?",
      )
      .get(effectiveApproval.id)!.n,
    1,
    "retry and rejected reassignment leave exactly one audited link",
  );
  assert.equal(riskStore.db.prepare("SELECT count(*) AS n FROM tasks").get()!.n, 5);
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
  // Old versions could reuse an assessment after its first target stopped
  // being eligible. Ambiguous retained audits must not approve either task.
  riskStore.db.exec("SAVEPOINT conflicting_approval");
  try {
    riskStore.event(
      `TASK_APPROVAL_LINK:${JSON.stringify({
        ...JSON.parse(approvalLinkRow.kind.slice("TASK_APPROVAL_LINK:".length)),
        taskKey: siblingRisk.key,
        contractHash: riskStore.task(siblingRisk.key)!.contract_hash,
        packageAssessmentId: JSON.parse(riskStore.task(siblingRisk.key)!.contract_json)
          .packageAssessmentId,
        packageId: `${highRiskContract.workflowId}/planned-p3`,
      })}`,
    );
    assert.deepEqual(
      await riskEngine.plan(highRiskResult.key),
      {
        action: "wait",
        reason: "owner-approval-required",
      },
      "conflicting retained approval links do not grant owner authority",
    );
  } finally {
    riskStore.db.exec("ROLLBACK TO conflicting_approval; RELEASE conflicting_approval");
  }
  const approvedPlan = await riskEngine.plan(highRiskResult.key);
  assert.equal(approvedPlan.action, "start", JSON.stringify(approvedPlan));

  const seedVerification = (
    taskKey: string,
    attemptId: string,
    state = riskStore,
    engine = riskEngine,
  ) => {
    const task = state.task(taskKey)!;
    const contract = contractSchema.parse(JSON.parse(task.contract_json));
    const diffHash = engine.git.snapshot(contract).diffHash;
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
    state.db
      .prepare(`INSERT INTO attempts(id,task_key,sequence,status,route_json,agent_id,fence,session_key,created_ms,result_hash,error_kind)
      VALUES(?,?,?,'VERIFY',?,?,1,?,?,NULL,NULL)`)
      .run(
        attemptId,
        taskKey,
        (state.latest(taskKey)?.sequence ?? 0) + 1,
        JSON.stringify(route),
        implementationAgentId,
        engine.sessionKey(contract, route),
        Date.now(),
      );
    state.db
      .prepare(`INSERT INTO leases(worktree,attempt_id,fence,state,heartbeat_ms) VALUES(?,?,1,'HELD',?)
      ON CONFLICT(worktree) DO UPDATE SET attempt_id=excluded.attempt_id,fence=excluded.fence,state=excluded.state,heartbeat_ms=excluded.heartbeat_ms`)
      .run(
        contract.workspace
          ? `scope:${hash({ worktree: contract.worktree, key: taskKey })}`
          : contract.worktree,
        attemptId,
        Date.now(),
      );
    state.db
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
    state.db
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
  assert.throws(
    () =>
      riskEngine.verify("high-risk-unapproved-proof", {
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
      }),
    /VERIFICATION_OWNER_APPROVAL_REQUIRED/,
  );
  assert.equal(riskStore.attempt("high-risk-unapproved-proof").status, "VERIFY");
  assert.equal(
    riskStore.db
      .prepare("SELECT count(*) AS n FROM reviews WHERE attempt_id=?")
      .get("high-risk-unapproved-proof")!.n,
    0,
  );
  riskStore.db
    .prepare("UPDATE attempts SET status='NEEDS_CONFIRMATION' WHERE id=?")
    .run("high-risk-unapproved-proof");
  riskStore.db
    .prepare("UPDATE tasks SET state='NEEDS_CONFIRMATION' WHERE key=?")
    .run(secondRiskResult.key);
  await assert.rejects(
    () => riskEngine.continueExisting(secondRiskResult.key),
    /CONTINUATION_OWNER_APPROVAL_REQUIRED/,
    "native continuation cannot turn another task's approval into P3 owner consent",
  );
  riskStore.close();
  closeRiskStore = () => {};

  // A supplied Main proposal is unfinished regardless of the retained legacy
  // authority source. It must not claim advice before the same task is clarified.
  const legacyProposal = highRiskRequest(
    "legacy-proposal-recovery",
    "update a second high-risk policy",
  );
  const proposalDeclaration = {
    complexity: "unknown" as const,
    workKind: "general",
    additionalPlanning: false,
    advisorNeeded: false,
  };
  await assert.rejects(
    () =>
      settingsOperation(
        {
          operation: "auto-task",
          agentId,
          directory: repo,
          contract: legacyProposal,
          packageInterpretation: proposalDeclaration,
        },
        options,
      ),
    /PACKAGE_CLASSIFICATION_REQUIRED/,
  );
  const legacyProposalState = new Store(database);
  assert.equal(
    legacyProposalState.db
      .prepare(
        "SELECT count(*) AS count FROM assessments WHERE kind='package' AND facts_json LIKE '%legacy-proposal-recovery%'",
      )
      .get()!.count,
    0,
    "legacy authority cannot freeze an unfinished Main package or advice",
  );
  legacyProposalState.close();
  const recoveredProposal = (await settingsOperation(
    {
      operation: "auto-task",
      agentId,
      directory: repo,
      contract: legacyProposal,
      packageInterpretation: { ...proposalDeclaration, complexity: "complex" },
    },
    options,
  )) as { state: string };
  assert.equal(
    recoveredProposal.state,
    "READY",
    "retained legacy authority can clarify the same unregistered package",
  );

  await t.test(
    "main authority separates plan, native implementation and stop from pending advisory calls",
    async (mainAuthority) => {
      let releaseAdvice = () => {};
      let noticeRequest = () => {};
      let responseGate = Promise.resolve();
      let requests = 0;
      const intakeRequests: string[] = [];
      const advisoryOptions = {
        ...options,
        classifierFactory: (state: Store): Classifier => ({
          classifyPackage: (facts, cfg) => new Decisions(state).classifyPackage(facts, cfg),
          classifyIntake: (facts, cfg) => {
            intakeRequests.push(facts.messageId);
            return facts.text.startsWith("Implement advisory example")
              ? followupDecisions(state, {
                  intent: "new-task",
                  intentConfidence: 0.94,
                  needImplementation: true,
                  implementationConfidence: 0.12,
                  beforeResponse: responseGate,
                  onRequest: () => {
                    requests++;
                    noticeRequest();
                  },
                }).classifyIntake(facts, {
                  ...cfg,
                  budgets: { ...cfg.budgets, decisions: 1000000 },
                  decisions: {
                    ...defaultDecisionSettings(),
                    enabled: true,
                    fundsConfirmed: true,
                    monthlyBudgetMicroUsd: 1000000,
                    validUntil: "2099-01-01T00:00:00Z",
                  },
                })
              : new FixtureClassifier(state).classifyIntake(facts, cfg);
          },
        }),
      };
      const readInput = () =>
        settingsOperation(
          { operation: "auto-interpret", agentId, directory: repo },
          advisoryOptions,
        ) as Promise<{
          input: { intakeId: string; factsHash: string; previousWorkIntakeId: string | null };
        }>;
      const interpret = async (
        action: "plan" | "start" | "question" | "stop" | "approve" | "change" | "continue",
        target?: { taskKey: string; contractHash: string; packageAssessmentId: string },
      ) => {
        const { input } = await readInput();
        const interpretation = {
          version: 1 as const,
          intakeId: input.intakeId,
          factsHash: input.factsHash,
          previousWorkIntakeId: input.previousWorkIntakeId,
          action,
          ...(target ? { target } : {}),
        };
        await settingsOperation(
          { operation: "auto-interpret", agentId, directory: repo, interpretation },
          advisoryOptions,
        );
        return interpretation;
      };
      await registerInput(
        "advisory-plan-only-0001",
        "Plan the example only, do not implement",
        false,
      );
      await interpret("plan");
      const selectedTree = (await settingsOperation(
        {
          operation: "auto-worktree",
          agentId,
          directory: repo,
          repository: repo,
          slug: "advisory-native",
        },
        advisoryOptions,
      )) as { worktree: string };
      const declaredContract = {
        ...taskRequest("advisory-native", "implement the example"),
        worktree: selectedTree.worktree,
      };
      const declaration = {
        complexity: "normal" as const,
        workKind: "general" as const,
        additionalPlanning: false,
        advisorNeeded: false,
      };
      assert.deepEqual(
        await settingsOperation(
          {
            operation: "auto-task",
            agentId,
            directory: repo,
            contract: declaredContract,
            packageInterpretation: declaration,
          },
          advisoryOptions,
        ),
        { state: "WAITING", reason: "INTAKE_IMPLEMENTATION_NOT_AUTHORIZED" },
        "plan-only cannot create a mutating task",
      );

      await registerInput("advisory-start-000001", "Implement advisory example now", false);
      let requestSeen = new Promise<void>((resolve) => {
        noticeRequest = resolve;
      });
      responseGate = new Promise<void>((resolve) => {
        releaseAdvice = resolve;
      });
      let pendingRead = readInput();
      try {
        await requestSeen;
        const started = await interpret("start");
        const pendingStore = new Store(database);
        assert.equal(currentIntake(pendingStore, agentId, true).id, started.intakeId);
        const authorityHash = hash(currentIntake(pendingStore, agentId, true));
        assert.equal(
          pendingStore.db.prepare("SELECT state FROM assessments WHERE id=?").get(started.intakeId)!
            .state,
          "PENDING",
        );
        const pendingHistory = decisionHistory(
          pendingStore,
          repo,
          agentId,
          started.intakeId,
          undefined,
          vaultRoot,
        );
        assert.equal(pendingHistory.detail?.source, "main");
        assert.equal(
          pendingHistory.detail?.callState,
          "PENDING",
          "financial uncertainty remains visible under main authority",
        );
        pendingStore.close();
        // An incomplete unregistered package must not freeze authoritative facts
        // or paid advice: planning can complete the same public registration.
        for (const incomplete of [
          {
            complexity: "unknown" as const,
            additionalPlanning: false,
            reason: /PACKAGE_CLASSIFICATION_REQUIRED/,
          },
          {
            complexity: "normal" as const,
            additionalPlanning: true,
            reason: /PACKAGE_ADDITIONAL_PLANNING_REQUIRED/,
          },
        ]) {
          const taskId = incomplete.complexity === "unknown" ? "needs-facts" : "needs-planning";
          const unfinished = { ...declaredContract, taskId, unknowns: ["one missing fact"] };
          await assert.rejects(
            () =>
              settingsOperation(
                {
                  operation: "auto-task",
                  agentId,
                  directory: repo,
                  contract: unfinished,
                  packageInterpretation: {
                    ...declaration,
                    complexity: incomplete.complexity,
                    additionalPlanning: incomplete.additionalPlanning,
                  },
                },
                advisoryOptions,
              ),
            incomplete.reason,
          );
          const state = new Store(database);
          assert.equal(
            state.db
              .prepare(
                "SELECT count(*) AS count FROM assessments WHERE kind='package' AND facts_json LIKE ?",
              )
              .get(`%${taskId}%`)!.count,
            0,
            "incomplete Main package cannot freeze a paid or authoritative assessment",
          );
          state.close();
          const completed = (await settingsOperation(
            {
              operation: "auto-task",
              agentId,
              directory: repo,
              contract: { ...unfinished, unknowns: [] },
              packageInterpretation: declaration,
            },
            advisoryOptions,
          )) as { state: string };
          assert.equal(
            completed.state,
            "READY",
            "the same unregistered package is usable after factual clarification",
          );
        }
        const nativeRegistration = (await settingsOperation(
          {
            operation: "auto-task",
            agentId,
            directory: repo,
            contract: declaredContract,
            packageInterpretation: declaration,
          },
          advisoryOptions,
        )) as { key: string; state: string };
        assert.equal(
          nativeRegistration.state,
          "READY",
          "explicit native implementation uses the main declaration despite unavailable package advice",
        );
        await assert.rejects(
          () =>
            settingsOperation(
              {
                operation: "auto-task",
                agentId,
                directory: repo,
                contract: { ...declaredContract, taskId: "invalid-category" },
                packageInterpretation: { ...declaration, workKind: "missing" },
              },
              advisoryOptions,
            ),
          /MAIN_PACKAGE_CATEGORY_UNKNOWN/,
        );
        const databaseRegistration = (await settingsOperation(
          {
            operation: "auto-task",
            agentId,
            directory: repo,
            contract: { ...declaredContract, taskId: "custom-database", uiChanged: true },
            packageInterpretation: { ...declaration, workKind: "db" },
          },
          advisoryOptions,
        )) as { key: string; state: string };
        assert.equal(databaseRegistration.state, "READY");
        const databaseStore = new Store(database);
        const databaseContract = contractSchema.parse(
          JSON.parse(databaseStore.task(databaseRegistration.key)!.contract_json),
        );
        assert.equal(
          databaseContract.uiChanged,
          true,
          "custom routing cannot remove the actual visual acceptance requirement",
        );
        const categoryFacts = JSON.parse(
          (
            databaseStore.db
              .prepare("SELECT facts_json FROM assessments WHERE id=?")
              .get(databaseContract.packageAssessmentId!) as { facts_json: string }
          ).facts_json,
        );
        assert.deepEqual(
          categoryFacts.workCategoryCatalog.find(
            (category: { id: string }) => category.id === "db",
          ),
          { id: "db", label: "Datenbank", description: "Datenmodelle und Abfragen" },
        );
        assert.match(categoryFacts.routingConfigIdentity, /^[a-f0-9]{64}$/);
        // The task must keep its pinned category even if the current editor later
        // changes it. Both fresh selection and reuse go through the same plan.
        const editedConfig = configSchema.parse({
          ...savedConfig,
          workCategories: [
            {
              id: "db",
              label: "Geändert",
              description: "Andere Präferenz",
              routeIds: ["test-claude-ui"],
            },
          ],
        });
        const categoryEngine = new Engine(
          databaseStore,
          editedConfig,
          fakeProvider,
          undefined,
          undefined,
          () => true,
        );
        const categoryPlan = await categoryEngine.plan(databaseRegistration.key);
        assert.equal(
          categoryPlan.route?.id,
          "test-codex",
          "explicit saved DB category wins over UI preference and later category edits",
        );
        assert.equal(categoryPlan.routing?.category, "db");
        databaseStore.blockAccess("route:test-codex", "category-unavailable", null);
        assert.equal(
          (await categoryEngine.plan(databaseRegistration.key)).route?.id,
          privateRoute.id,
          "custom category uses its ordered healthy fallback",
        );
        databaseStore.blockAccess("claude-personal-pro", "category-unavailable", null);
        const exhaustedCategory = await categoryEngine.plan(databaseRegistration.key);
        assert.equal(
          exhaustedCategory.reason,
          "category-no-safe-and-funded-candidate",
          "exhausted category cannot append a generic healthy Claude route",
        );
        databaseStore.db.prepare("DELETE FROM circuits WHERE reason=?").run("category-unavailable");
        const pinnedConfig = configSchema.parse(
          JSON.parse(databaseStore.task(databaseRegistration.key)!.config_json),
        );
        databaseStore.db
          .prepare("INSERT INTO sessions VALUES(?,?, 'idle',0.1,?,NULL)")
          .run(
            new Engine(databaseStore, pinnedConfig, fakeProvider).sessionKey(
              databaseContract,
              pinnedConfig.routes.find((candidate) => candidate.id === "test-codex")!,
            ),
            "database-reuse",
            Date.now(),
          );
        const reuseProvider = {
          ...fakeProvider,
          refresh: async (id: string) => ({
            ...(await fakeProvider.refresh(id)),
            cwd: databaseContract.worktree,
            contextFraction: 0.1,
          }),
        } as PaseoProvider;
        const reusePlan = await new Engine(
          databaseStore,
          editedConfig,
          reuseProvider,
          undefined,
          undefined,
          () => true,
        ).plan(databaseRegistration.key);
        assert.equal(
          reusePlan.action,
          "reuse",
          "custom category uses the same pinned preference for native reuse",
        );
        assert.equal(reusePlan.route?.id, "test-codex");
        assert.equal(reusePlan.sessionId, "database-reuse");
        databaseStore.close();
        releaseAdvice();
        await pendingRead;
        const settledStore = new Store(database);
        assert.equal(
          hash(currentIntake(settledStore, agentId, true)),
          authorityHash,
          "late low-confidence advice cannot change the authoritative binding/hash",
        );
        const raw = settledStore.db
          .prepare("SELECT result_json FROM assessments WHERE id=?")
          .get(started.intakeId) as { result_json: string };
        assert.equal(JSON.parse(raw.result_json).reason, "DECISIONS_LOW_CONFIDENCE");
        const settledHistory = decisionHistory(
          settledStore,
          repo,
          agentId,
          started.intakeId,
          undefined,
          vaultRoot,
        );
        assert.equal(settledHistory.detail?.callState, "SETTLED");
        assert.equal(
          JSON.parse(settledHistory.detail!.diagnostics!).find(
            (answer: { name: string }) => answer.name === "needImplementation",
          ).confidence,
          0.12,
          "the original advisory confidence remains visible",
        );
        const registeredContract = contractSchema.parse(
          JSON.parse(settledStore.task(nativeRegistration.key)!.contract_json),
        );
        assert.equal(registeredContract.role, "implement-normal");
        assert.doesNotThrow(() => assertTaskAssessment(settledStore, config, registeredContract));
        assert.equal(requests, 1, "pending/settled retries reuse the same paid-call identity");
        settledStore.close();
        await settingsOperation(
          { operation: "auto-interpret", agentId, directory: repo, interpretation: started },
          advisoryOptions,
        );
        const mainRisks: { key: string; contract: Contract; hash: string }[] = [];
        editAutomation(
          agentId,
          (main) => ({ ...main!, workerPlacement: "main-workspace" }),
          vaultRoot,
        );
        for (const taskId of ["main-p1", "main-p3"]) {
          const registration = (await settingsOperation(
            {
              operation: "auto-task",
              agentId,
              directory: repo,
              contract: {
                ...declaredContract,
                taskId,
                highRisk: true,
                minTier: 3,
                role: "implement-complex",
              },
              packageInterpretation: declaration,
            },
            advisoryOptions,
          )) as { key: string };
          const riskState = new Store(database);
          const row = riskState.task(registration.key)!;
          mainRisks.push({
            key: registration.key,
            contract: contractSchema.parse(JSON.parse(row.contract_json)),
            hash: row.contract_hash,
          });
          riskState.close();
        }
        editAutomation(
          agentId,
          (main) => ({ ...main!, workerPlacement: "source-workspace" }),
          vaultRoot,
        );
        const p1 = mainRisks[0]!,
          p3 = mainRisks[1]!;
        await registerInput("advisory-approve-p1-001", "Approve P1 only", false);
        await interpret("approve", {
          taskKey: p1.key,
          contractHash: p1.hash,
          packageAssessmentId: p1.contract.packageAssessmentId!,
        });
        assert.deepEqual(
          await settingsOperation(
            { operation: "auto-task", agentId, directory: repo, contract: p1.contract },
            advisoryOptions,
          ),
          { key: p1.key, state: "APPROVAL_LINKED" },
        );
        assert.deepEqual(
          await settingsOperation(
            { operation: "auto-task", agentId, directory: repo, contract: p3.contract },
            advisoryOptions,
          ),
          { state: "WAITING", reason: "APPROVAL_TARGET_REQUIRED" },
        );
        const approvedState = new Store(database);
        const mainEngine = new Engine(
          approvedState,
          config,
          fakeProvider,
          undefined,
          undefined,
          (key) => taskDispatchAllowed(key, vaultRoot),
        );
        assert.equal(
          (await mainEngine.plan(p1.key)).action,
          "start",
          "Main approval reaches the same audited owner gate as legacy approval",
        );
        assert.deepEqual(await mainEngine.plan(p3.key), {
          action: "wait",
          reason: "owner-approval-required",
        });
        assert.doesNotThrow(() => assertTaskAssessment(approvedState, config, registeredContract));
        approvedState.close();
        await registerInput(
          "advisory-continue-0001",
          "Continue P1 unchanged; do not change its contract.",
          false,
        );
        await assert.rejects(() => interpret("change"), /MAIN_TARGET_REQUIRED/);
        await interpret("continue");
        await registerInput("advisory-question-0001", "Why did you choose this approach?", false);
        await interpret("question");
        const afterQuestion = new Store(database);
        assert.equal(
          currentIntake(afterQuestion, agentId, true).id,
          started.intakeId,
          "a question preserves only the existing objective",
        );
        afterQuestion.close();

        // An unresolved new input is an authority wait, not a failed code revision.
        const finalState = new Store(database);
        try {
          const finalEngine = new Engine(finalState, config, fakeProvider);
          const proof = seedVerification(p1.key, "authority-finalization", finalState, finalEngine);
          const evidence = {
            diffHash: proof.diffHash,
            reviewedDiffHash: proof.diffHash,
            implementationAgentId: proof.implementationAgentId,
            reviewerAgentId: proof.reviewerAgentId,
            buildExit: 0,
            testExit: 0,
            reviewPass: true,
            visualAcceptance: false,
            ownerApproved: true,
            scopeViolations: 0,
            unresolvedIssues: 0,
            artifacts: [configFile],
          };
          const before = () => ({
            attempt: { ...finalState.attempt("authority-finalization") },
            task: { ...finalState.task(p1.key)! },
            lease: finalState.db
              .prepare("SELECT * FROM leases WHERE attempt_id=?")
              .get("authority-finalization"),
            reviews: finalState.db
              .prepare("SELECT * FROM reviews WHERE attempt_id=?")
              .all("authority-finalization"),
          });
          const original = before();
          await registerInput("verification-unresolved-question", "Why is this ready?", false);
          assert.throws(
            () => finalEngine.verify("authority-finalization", evidence),
            /INTAKE_PENDING|MAIN_INPUT_INTERPRETATION_REQUIRED/,
          );
          assert.deepEqual(
            before(),
            original,
            "authority uncertainty preserves the revision, evidence, counter and lease",
          );
          await interpret("question");
          const finish = finalState.finish.bind(finalState);
          finalState.finish = (...args: Parameters<Store["finish"]>) => {
            markIntakeClassificationPending(finalState, agentId, "verification-raced-input");
            return finish(...args);
          };
          assert.throws(
            () => finalEngine.verify("authority-finalization", evidence),
            /INTAKE_PENDING|MAIN_INPUT_INTERPRETATION_REQUIRED/,
          );
          assert.deepEqual(
            before(),
            original,
            "the final transaction rechecks authority before any finish writes",
          );
          finalState.finish = finish;
          await registerInput(
            "verification-raced-input",
            "Explain the same unchanged result",
            false,
          );
          await interpret("question");
          seedVerification(p3.key, "unapproved-cohort-peer", finalState, finalEngine);
          const cohortBefore = {
            own: before(),
            peer: { ...finalState.attempt("unapproved-cohort-peer") },
            task: { ...finalState.task(p3.key)! },
          };
          assert.throws(
            () => finalEngine.verify("authority-finalization", { ...evidence, reviewPass: false }),
            /VERIFICATION_OWNER_APPROVAL_REQUIRED/,
          );
          assert.deepEqual(
            {
              own: before(),
              peer: { ...finalState.attempt("unapproved-cohort-peer") },
              task: { ...finalState.task(p3.key)! },
            },
            cohortBefore,
            "a rejected cohort finalization cannot consume P3 without its own approval",
          );
          // Dispose only the synthetic peer attempt after the rollback assertion.
          for (const table of ["review_runs", "turn_checks", "leases"])
            finalState.db
              .prepare(`DELETE FROM ${table} WHERE attempt_id=?`)
              .run("unapproved-cohort-peer");
          finalState.db.prepare("DELETE FROM attempts WHERE id=?").run("unapproved-cohort-peer");
          assert.equal(finalEngine.verify("authority-finalization", evidence).ok, true);
          assert.equal(finalState.attempt("authority-finalization").status, "COMPLETE");
        } finally {
          finalState.close();
        }

        // A controller wake lost its client ID during native history replay.
        // The old false unverified claim must not require a new human click.
        async function recoverInternalWake(wakeTest: TestContext) {
          const wake = {
            id: "dc5b5935-c85f-4acf-913a-b6054f6b8e4e",
            nativeId: "11111111-1111-7111-8111-111111111111",
            text: "Controller progress for the unchanged authorized task",
            timestamp: new Date().toISOString(),
          };
          const activation = readAutomation(vaultRoot).mains.find(
            (main) => main.agentId === agentId,
          )!;
          await settingsOperation(
            {
              operation: "auto-wake",
              agentId,
              activationId: activation.requestId,
              fingerprint: hash(wake),
              messageId: wake.id,
            },
            advisoryOptions,
          );
          await settingsOperation(
            { operation: "auto-wake-settle", agentId, messageId: wake.id, sent: true },
            advisoryOptions,
          );
          const state = new Store(database);
          // A historical activation was never replayed by the native provider.
          // It must not force complete reads after the current wake is proven.
          state.db
            .prepare("INSERT INTO internal_messages VALUES(?,?,?)")
            .run(agentId, "old-activation-without-native", "activation");
          rememberIntakeIdentity(state, {
            agentId,
            sessionId: providerSessionId,
            messageId: "old-activation-without-native",
            timestamp: "2025-01-01T00:00:00.000Z",
            textHash: hash("Old activation absent from replayed history"),
          });
          state.db
            .prepare("INSERT INTO internal_messages VALUES(?,?,?)")
            .run(agentId, "old-reminder-ambiguous-in-history", "reminder");
          rememberIntakeIdentity(state, {
            agentId,
            sessionId: providerSessionId,
            messageId: "old-reminder-ambiguous-in-history",
            timestamp: "2025-01-02T00:00:00.000Z",
            textHash: hash("Old duplicate internal transport"),
          });
          const beforeWork = state.db
            .prepare("SELECT work_intake_id FROM main_checkpoints WHERE agent_id=?")
            .get(agentId)!.work_intake_id;
          rememberIntakeIdentity(state, {
            agentId,
            sessionId: providerSessionId,
            messageId: wake.id,
            timestamp: new Date(Date.parse(wake.timestamp) - 85).toISOString(),
            textHash: hash(wake.text),
          });
          const mistaken = await new Decisions(state).classifyIntake(
            intakeFactsSchema.parse({
              mainAgentId: agentId,
              messageId: wake.nativeId,
              origin: "unverified",
              directory: repo,
              text: wake.text,
            }),
            config,
          );
          state.event(`MAIN_INPUT_AWAITING_INTERPRETATION:${mistaken.id}`);
          markIntakeClassificationPending(state, agentId, wake.nativeId);
          state.db
            .prepare("UPDATE main_checkpoints SET message_id=? WHERE agent_id=?")
            .run(wake.nativeId, agentId);
          const historical = {
            ...state.db.prepare("SELECT * FROM assessments WHERE id=?").get(mistaken.id)!,
          };
          const callsBefore = state.db.prepare("SELECT count(*) AS n FROM decision_calls").get()!.n;
          state.close();
          messages.push(wake);
          rehydratedHistory = true;
          historyReads.length = 0;
          try {
            sessionChangesDuringHistory = true;
            await assert.rejects(() => readInput(), /INTAKE_HISTORY_SESSION_CHANGED/);
            const foreignState = new Store(database);
            assert.throws(
              () => currentIntake(foreignState, agentId, true),
              /INTAKE_PENDING|MAIN_INPUT_INTERPRETATION_REQUIRED/,
            );
            foreignState.close();
            providerSessionId = "fixture-session";
            historyGap = true;
            await assert.rejects(() => readInput(), /TIMELINE_HISTORY_INCOMPLETE/);
            historyGap = false;
            messages.push({
              ...wake,
              id: "ambiguous-copy",
              nativeId: "22222222-2222-7222-8222-222222222222",
            });
            await assert.rejects(() => readInput(), /INTAKE_MESSAGE_IDENTITY_AMBIGUOUS/);
            messages.pop();
            const intakeRequestsBefore = intakeRequests.length;
            const recovered = await readInput();
            assert.equal(
              intakeRequests.length,
              intakeRequestsBefore,
              "proven internal transport causes no new classification",
            );
            assert.notEqual(
              recovered.input.intakeId,
              mistaken.id,
              "controller transport is not a new Main input",
            );
            const recoveredState = new Store(database);
            try {
              assert.equal(currentIntake(recoveredState, agentId, true).id, beforeWork);
              assert.doesNotThrow(() =>
                assertTaskAssessment(recoveredState, config, registeredContract),
              );
              assert.equal(
                (
                  await new Engine(
                    recoveredState,
                    config,
                    fakeProvider,
                    undefined,
                    undefined,
                    (key) => taskDispatchAllowed(key, vaultRoot),
                  ).plan(p1.key)
                ).action,
                "start",
              );
              assert.deepEqual(
                {
                  ...recoveredState.db
                    .prepare("SELECT * FROM assessments WHERE id=?")
                    .get(mistaken.id)!,
                },
                historical,
              );
              assert.equal(
                recoveredState.db.prepare("SELECT count(*) AS n FROM decision_calls").get()!.n,
                callsBefore,
              );
              assert.equal(
                recoveredState.db
                  .prepare("SELECT work_intake_id FROM main_checkpoints WHERE agent_id=?")
                  .get(agentId)!.work_intake_id,
                beforeWork,
              );
              assert.equal(
                recoveredState.db
                  .prepare("SELECT message_id FROM main_checkpoints WHERE agent_id=?")
                  .get(agentId)!.message_id,
                wake.nativeId,
                "alias recovery must not rewrite the native checkpoint",
              );
              recoveredState.db
                .prepare("INSERT INTO internal_messages VALUES(?,?,?)")
                .run(agentId, wake.nativeId, `human:${hash(wake.text)}`);
              assert.throws(
                () => currentIntake(recoveredState, agentId, true),
                /INTAKE_INTERNAL_ORIGIN_CONFLICT/,
                "a colliding human receipt cannot be ignored",
              );
              recoveredState.db
                .prepare("DELETE FROM internal_messages WHERE agent_id=? AND message_id=?")
                .run(agentId, wake.nativeId);
            } finally {
              recoveredState.close();
            }
            assert.ok(
              historyReads.includes("before"),
              "the strict first alias proof requires complete history",
            );
            historyReads.length = 0;
            const status = (await settingsOperation(
              { operation: "status", agentId, directory: repo },
              advisoryOptions,
            )) as { writeAuthorization: { allowed: boolean } };
            assert.equal(status.writeAuthorization.allowed, true);
            await readInput();
            assert.equal(
              historyReads.includes("before"),
              false,
              "the proven native alias avoids full reads on later pulses",
            );
            const delayedWake = {
              id: "44444444-4444-7444-8444-444444444444",
              nativeId: "55555555-5555-7555-8555-555555555555",
              observedProviderId: "unsupported-provider-message-format",
              liveMessageId: undefined as string | undefined,
              text: "A later controlled controller notification",
              timestamp: new Date().toISOString(),
            };
            await settingsOperation(
              {
                operation: "auto-wake",
                agentId,
                activationId: activation.requestId,
                fingerprint: hash(delayedWake),
                messageId: delayedWake.id,
              },
              advisoryOptions,
            );
            await settingsOperation(
              { operation: "auto-wake-settle", agentId, messageId: delayedWake.id, sent: true },
              advisoryOptions,
            );
            const delayedState = new Store(database);
            const delayedClaim = await new Decisions(delayedState).classifyIntake(
              intakeFactsSchema.parse({
                mainAgentId: agentId,
                messageId: delayedWake.nativeId,
                origin: "unverified",
                directory: repo,
                text: delayedWake.text,
              }),
              config,
            );
            const delayedFacts = {
              ...delayedState.db
                .prepare("SELECT * FROM assessments WHERE id=?")
                .get(delayedClaim.id)!,
            };
            markIntakeClassificationPending(delayedState, agentId, delayedWake.nativeId);
            const delayedCalls = delayedState.db
              .prepare("SELECT count(*) AS n FROM decision_calls")
              .get()!.n;
            const delayedRequests = intakeRequests.length;
            delayedState.close();
            messages.push(delayedWake);
            rehydratedHistory = false;
            await readInput();
            const unsupportedState = new Store(database);
            try {
              assert.throws(
                () => currentIntake(unsupportedState, agentId, true),
                /INTAKE_HUMAN_ORIGIN_UNCONFIRMED|MAIN_INPUT_INTERPRETATION_REQUIRED|INTAKE_PENDING/,
              );
              assert.equal(
                unsupportedState.db
                  .prepare(
                    "SELECT count(*) AS n FROM events WHERE kind LIKE 'INTAKE_INTERNAL_ORIGIN:%' AND kind LIKE ?",
                  )
                  .get(`%${delayedWake.nativeId}%`)!.n,
                0,
                "an unsupported optional ID adds no origin proof",
              );
            } finally {
              unsupportedState.close();
            }
            delayedWake.observedProviderId = "66666666-6666-7666-8666-666666666666";
            delayedWake.liveMessageId = delayedWake.nativeId;
            await assert.rejects(
              () => readInput(),
              /INTAKE_MESSAGE_IDENTITY_AMBIGUOUS/,
              "contradictory supported client/message/provider IDs remain blocked",
            );
            delayedWake.observedProviderId = delayedWake.nativeId;
            delayedWake.liveMessageId = undefined;
            await readInput(); // Actual observed SubmittedPrompt/native-echo correlation.
            delayedWake.timestamp = new Date(
              Date.parse(delayedWake.timestamp) + 20329,
            ).toISOString();
            rehydratedHistory = true;
            await readInput(); // Only native IDs survive the replay; timestamps no longer match.
            const replayedState = new Store(database);
            try {
              assert.equal(currentIntake(replayedState, agentId, true).id, beforeWork);
              assert.equal(
                intakeRequests.length,
                delayedRequests,
                "the observed echo is not new classification input",
              );
              assert.equal(
                replayedState.db.prepare("SELECT count(*) AS n FROM decision_calls").get()!.n,
                delayedCalls,
              );
              assert.deepEqual(
                {
                  ...replayedState.db
                    .prepare("SELECT * FROM assessments WHERE id=?")
                    .get(delayedClaim.id)!,
                },
                delayedFacts,
              );
              assert.equal(
                replayedState.db
                  .prepare("SELECT work_intake_id FROM main_checkpoints WHERE agent_id=?")
                  .get(agentId)!.work_intake_id,
                beforeWork,
              );
              assert.ok(
                replayedState.db
                  .prepare(
                    "SELECT 1 FROM events WHERE kind LIKE 'INTAKE_INTERNAL_ORIGIN:%' AND kind LIKE ?",
                  )
                  .get(`%${delayedWake.nativeId}%`),
                "observed alias is durable in the existing origin audit",
              );
            } finally {
              replayedState.close();
            }
            // Reproduce the historical terminal approval-only failure. This is
            // synthetic fixture history, never a runtime status repair.
            const recoveryState = new Store(database);
            const savedMainSession = savedSessionId;
            savedSessionId = providerSessionId;
            try {
              const recoveryConfig = configSchema.parse({
                ...JSON.parse(recoveryState.task(p1.key)!.config_json),
                liveDispatchApproved: true,
              });
              recoveryState.db
                .prepare("UPDATE tasks SET config_json=?,config_hash=? WHERE key=?")
                .run(JSON.stringify(recoveryConfig), hash(recoveryConfig), p1.key);
              const historicalWake = {
                id: "77777777-7777-7777-8777-777777777777",
                nativeId: "88888888-8888-7888-8888-888888888888",
                text: "Old explicitly operator-attested transport",
                timestamp: new Date().toISOString(),
                replayedClientId: undefined as string | undefined,
              };
              recoveryState.db
                .prepare("INSERT INTO internal_messages VALUES(?,?,?)")
                .run(agentId, historicalWake.id, "wake");
              rememberIntakeIdentity(recoveryState, {
                agentId,
                sessionId: providerSessionId,
                messageId: historicalWake.id,
                timestamp: new Date(Date.parse(historicalWake.timestamp) - 20329).toISOString(),
                textHash: hash(historicalWake.text),
              });
              const oldClaim = await new Decisions(recoveryState).classifyIntake(
                intakeFactsSchema.parse({
                  mainAgentId: agentId,
                  messageId: historicalWake.nativeId,
                  origin: "unverified",
                  directory: repo,
                  text: historicalWake.text,
                }),
                config,
              );
              markIntakeClassificationPending(recoveryState, agentId, historicalWake.nativeId);
              recoveryState.db
                .prepare("UPDATE main_checkpoints SET message_id=? WHERE agent_id=?")
                .run(historicalWake.nativeId, agentId);
              messages.push(historicalWake);
              const nativeRowsBefore = recoveryState.db
                .prepare("SELECT kind FROM events WHERE kind LIKE 'INTAKE_MESSAGE_IDENTITY:%'")
                .all();
              const claimBefore = {
                ...recoveryState.db
                  .prepare("SELECT * FROM assessments WHERE id=?")
                  .get(oldClaim.id)!,
              };
              const nativeIds = new Map([
                [agentId, providerSessionId],
                ["recovery-worker", "worker-native"],
                ["recovery-reviewer", "reviewer-native"],
              ]);
              let starts = 0,
                driftDuringReviewer = false;
              let duringReviewer: (() => void) | undefined;
              const recoveryProvider = {
                ...fakeProvider,
                nativeSessionId: (id: string) => nativeIds.get(id) ?? null,
                refresh: async (id: string) => {
                  if (id === "recovery-reviewer") duringReviewer?.();
                  if (id === "recovery-reviewer" && driftDuringReviewer)
                    nativeIds.set("recovery-worker", "changed-after-await");
                  return {
                    ...(await fakeProvider.refresh(id)),
                    cwd: id === agentId ? repo : p1.contract.workspace!.directory,
                    workspaceId: p1.contract.workspace!.id,
                    nativeSessionId: nativeIds.get(id) ?? null,
                  };
                },
                run: async () => {
                  starts++;
                  throw Error("unexpected implementation send");
                },
                create: async () => {
                  starts++;
                  throw Error("unexpected reviewer creation");
                },
              } as unknown as PaseoProvider;
              const recoveryEngine = new Engine(
                recoveryState,
                recoveryConfig,
                recoveryProvider,
                undefined,
                undefined,
                () => true,
              );
              const predecessorId = `${p1.key}/3`,
                recoveryId = `${p1.key}/4`;
              const seeded = seedVerification(p1.key, predecessorId, recoveryState, recoveryEngine);
              recoveryState.db
                .prepare(
                  "UPDATE attempts SET sequence=3,status='FAILED',fence=3,agent_id='recovery-worker' WHERE id=?",
                )
                .run(predecessorId);
              seedVerification(p1.key, recoveryId, recoveryState, recoveryEngine);
              recoveryState.db
                .prepare(
                  "UPDATE attempts SET sequence=4,status='FAILED',fence=4,agent_id='recovery-worker',run_accepted=1,result_hash=? WHERE id=?",
                )
                .run(seeded.diffHash, recoveryId);
              recoveryState.db
                .prepare("UPDATE tasks SET state='BLOCKED',rework=4 WHERE key=?")
                .run(p1.key);
              recoveryState.db
                .prepare("UPDATE leases SET state='RELEASED',fence=4 WHERE attempt_id=?")
                .run(recoveryId);
              recoveryState.db
                .prepare("UPDATE review_runs SET agent_id='recovery-reviewer' WHERE attempt_id=?")
                .run(recoveryId);
              const task = recoveryState.task(p1.key)!;
              const grant = {
                predecessorAttemptId: predecessorId,
                predecessorFence: 3,
                agentId: "recovery-worker",
                nativeSessionId: "worker-native",
                taskKey: p1.key,
                contractHash: task.contract_hash,
                configHash: task.config_hash,
                diffHash: seeded.diffHash,
                approvedScopeRevision: recoveryState.scopeRevision(p1.contract),
                approvedCheckRevision: recoveryState.checkRevision(p1.contract),
                checks: p1.contract.checks,
                reason: "one old approved repair",
              };
              recoveryState.event(`TERMINAL_REPAIR_SUCCESSOR:${JSON.stringify(grant)}`, recoveryId);
              recoveryState.event(
                `OPERATOR_TERMINAL_REPAIR:${JSON.stringify(grant)}`,
                predecessorId,
              );
              recoveryState.event(`TERMINAL_REPAIR_CONSUMED:${hash(grant)}`, predecessorId);
              const oldVerdict = JSON.stringify({
                reasons: ["approval-required"],
                cohortFailure: { sourceAttemptId: recoveryId, round: 4 },
              });
              recoveryState.db
                .prepare("INSERT INTO reviews VALUES(?,?,?)")
                .run(recoveryId, seeded.diffHash, oldVerdict);
              const sha = (value: string) => createHash("sha256").update(value).digest("hex");
              const checkRow = recoveryState.db
                .prepare("SELECT * FROM turn_checks WHERE attempt_id=?")
                .get(recoveryId)!;
              const reviewRow = recoveryState.db
                .prepare("SELECT * FROM review_runs WHERE attempt_id=?")
                .get(recoveryId)!;
              const request = {
                attemptId: recoveryId,
                fence: 4,
                rework: 4,
                agentId: "recovery-worker",
                nativeSessionId: "worker-native",
                reviewerId: "recovery-reviewer",
                reviewerNativeSessionId: "reviewer-native",
                contractHash: task.contract_hash,
                configHash: task.config_hash,
                diffHash: seeded.diffHash,
                checkEvidenceSha256: sha(String(checkRow.result_json)),
                reviewRunSha256: sha(JSON.stringify(reviewRow)),
                finalEvidenceSha256: sha(oldVerdict),
                scopeRevision: recoveryState.scopeRevision(p1.contract),
                checkRevision: recoveryState.checkRevision(p1.contract),
                checkBindingHash: hash(recoveryState.checkCommandBinding(p1.contract)),
                origin: {
                  mainAgentId: agentId,
                  sessionId: providerSessionId,
                  receiptId: historicalWake.id,
                  nativeMessageId: historicalWake.nativeId,
                  assessmentId: oldClaim.id,
                  factsHash: oldClaim.factsHash,
                  textHash: hash(historicalWake.text),
                  directory: repo,
                  workIntakeId: String(beforeWork),
                },
              };
              const operator = {
                reason: "exactly one approved verification recovery",
                paseo: fakeProvider.client,
              };
              const countsBefore = recoveryState.db
                .prepare("SELECT count(*) AS n FROM events")
                .get()!.n;
              for (const scenario of [
                "uncaptured-stop",
                "foreign-client-receipt",
                "last-timeline-session",
              ] as const) {
                await wakeTest.test(scenario, async () => {
                  const isolatedDatabase = path.join(root, `${scenario}.sqlite`);
                  await recoveryState.backupTo(isolatedDatabase);
                  const isolated = new Store(isolatedDatabase);
                  const isolatedEngine = new Engine(
                    isolated,
                    recoveryConfig,
                    recoveryProvider,
                    undefined,
                    undefined,
                    () => true,
                  );
                  const projection = () => ({
                    task: isolated.task(p1.key),
                    attempt: isolated.attempt(recoveryId),
                    events: isolated.db.prepare("SELECT * FROM events ORDER BY sequence").all(),
                    lease: isolated.db
                      .prepare("SELECT * FROM leases WHERE attempt_id=?")
                      .get(recoveryId),
                    review: isolated.db
                      .prepare("SELECT * FROM reviews WHERE attempt_id=?")
                      .get(recoveryId),
                  });
                  const messageCount = messages.length;
                  try {
                    if (scenario === "uncaptured-stop") {
                      // The input arrives in the last worker/reviewer preflight,
                      // while Main is idle and capture has not seen it yet.
                      duringReviewer = () => {
                        if (messages.length !== messageCount) return;
                        messages.push({
                          id: "fresh-uncaptured-stop",
                          text: "Stop the implementation now",
                          timestamp: new Date().toISOString(),
                        });
                      };
                    } else if (scenario === "foreign-client-receipt") {
                      const originalInput = isolated.db
                        .prepare("SELECT facts_json FROM assessments WHERE id=?")
                        .get(String(beforeWork))!;
                      historicalWake.replayedClientId = JSON.parse(
                        String(originalInput.facts_json),
                      ).messageId;
                      assert.match(
                        String(
                          isolated.db
                            .prepare(
                              "SELECT kind FROM internal_messages WHERE agent_id=? AND message_id=?",
                            )
                            .get(agentId, historicalWake.replayedClientId!)!.kind,
                        ),
                        /^human:/,
                      );
                    } else {
                      finalTimelineSessionChange = true;
                      recoveryHistoryReads = 0;
                    }
                    const before = projection();
                    let expectedError = /VERIFICATION_RECOVERY_MAIN_CHANGED/;
                    if (scenario === "uncaptured-stop")
                      expectedError = /VERIFICATION_RECOVERY_UNCAPTURED_INPUT/;
                    else if (scenario === "foreign-client-receipt")
                      expectedError = /INTAKE_MESSAGE_IDENTITY_AMBIGUOUS/;
                    await assert.rejects(
                      isolatedEngine.recoverVerification(p1.key, request, operator),
                      expectedError,
                    );
                    if (scenario === "last-timeline-session") assert.equal(recoveryHistoryReads, 2);
                    assert.deepEqual(projection(), before, "rejected origin must have no effects");
                    assert.equal(starts, 0);
                  } finally {
                    duringReviewer = undefined;
                    messages.splice(messageCount);
                    historicalWake.replayedClientId = undefined;
                    finalTimelineSessionChange = false;
                    recoveryHistoryReads = 0;
                    isolated.close();
                  }
                });
              }
              recoveryState.db.exec(
                "CREATE TRIGGER reject_recovery_marker BEFORE INSERT ON events WHEN NEW.kind LIKE 'OPERATOR_VERIFICATION_RECOVERY:%' BEGIN SELECT RAISE(ABORT,'fixture-recovery-rollback'); END",
              );
              await assert.rejects(
                () => recoveryEngine.recoverVerification(p1.key, request, operator),
                /fixture-recovery-rollback/,
              );
              recoveryState.db.exec("DROP TRIGGER reject_recovery_marker");
              assert.equal(
                recoveryState.db.prepare("SELECT count(*) AS n FROM events").get()!.n,
                countsBefore,
              );
              assert.equal(recoveryState.attempt(recoveryId).status, "FAILED");
              assert.equal(
                recoveryState.db
                  .prepare("SELECT evidence_json FROM reviews WHERE attempt_id=?")
                  .get(recoveryId)!.evidence_json,
                oldVerdict,
              );
              assert.equal(
                recoveryState.db
                  .prepare("SELECT state FROM leases WHERE attempt_id=?")
                  .get(recoveryId)!.state,
                "RELEASED",
              );
              const reentry = await recoveryEngine.recoverVerification(p1.key, request, operator);
              assert.equal(reentry.replayed, false);
              assert.equal(recoveryState.attempt(recoveryId).status, "VERIFY");
              assert.equal(recoveryState.task(p1.key)!.rework, 4);
              const afterReentry = recoveryState.db
                .prepare("SELECT count(*) AS n FROM events")
                .get()!.n;
              assert.equal(
                (await recoveryEngine.recoverVerification(p1.key, request, operator)).replayed,
                true,
              );
              assert.equal(
                recoveryState.db.prepare("SELECT count(*) AS n FROM events").get()!.n,
                afterReentry,
              );
              await assert.rejects(
                () =>
                  recoveryEngine.recoverVerification(
                    p1.key,
                    { ...request, diffHash: "a".repeat(64) },
                    operator,
                  ),
                /REPLAY_CONFLICT/,
              );
              let negativeFinishBlocked = false;
              try {
                recoveryState.finish(recoveryId, false, seeded.diffHash, {}, 2);
              } catch (error) {
                assert.match(String(error), /VERIFICATION_RECOVERY_WAIT/);
                negativeFinishBlocked = true;
              }
              assert.equal(
                recoveryState.task(p1.key)!.rework,
                4,
                "verification-only recovery must never spend a fifth repair round",
              );
              assert.equal(recoveryState.attempt(recoveryId).status, "VERIFY");
              assert.equal(negativeFinishBlocked, true);
              recoveryState.db
                .prepare("UPDATE turn_checks SET result_json=? WHERE attempt_id=?")
                .run(
                  JSON.stringify({ ...JSON.parse(String(checkRow.result_json)), changed: true }),
                  recoveryId,
                );
              await assert.rejects(
                () => recoveryEngine.advance(recoveryId),
                /VERIFICATION_RECOVERY_EVIDENCE_CHANGED/,
              );
              recoveryState.db
                .prepare("UPDATE turn_checks SET result_json=? WHERE attempt_id=?")
                .run(checkRow.result_json, recoveryId);
              driftDuringReviewer = true;
              await assert.rejects(
                () => recoveryEngine.advance(recoveryId),
                /VERIFICATION_RECOVERY_SESSION_CHANGED/,
              );
              driftDuringReviewer = false;
              nativeIds.set("recovery-worker", "worker-native");
              assert.equal(recoveryState.task(p1.key)!.rework, 4);
              await recoveryEngine.advance(recoveryId);
              assert.equal(recoveryState.attempt(recoveryId).status, "COMPLETE");
              assert.equal(recoveryState.task(p1.key)!.rework, 4);
              assert.equal(starts, 0);
              assert.equal(
                recoveryState.db
                  .prepare("SELECT result_json FROM turn_checks WHERE attempt_id=?")
                  .get(recoveryId)!.result_json,
                checkRow.result_json,
              );
              assert.deepEqual(
                recoveryState.db
                  .prepare("SELECT * FROM review_runs WHERE attempt_id=?")
                  .get(recoveryId),
                reviewRow,
              );
              const archived = recoveryState.db
                .prepare(
                  "SELECT kind FROM events WHERE attempt_id=? AND kind LIKE 'VERIFICATION_RECOVERY_ARCHIVE:%'",
                )
                .get(recoveryId)!.kind;
              assert.equal(
                JSON.parse(String(archived).slice("VERIFICATION_RECOVERY_ARCHIVE:".length))
                  .evidenceJson,
                oldVerdict,
              );
              assert.deepEqual(
                {
                  ...recoveryState.db
                    .prepare("SELECT * FROM assessments WHERE id=?")
                    .get(oldClaim.id)!,
                },
                claimBefore,
              );
              assert.deepEqual(
                recoveryState.db
                  .prepare("SELECT kind FROM events WHERE kind LIKE 'INTAKE_MESSAGE_IDENTITY:%'")
                  .all(),
                nativeRowsBefore,
              );
              assert.equal(currentIntake(recoveryState, agentId, true).id, beforeWork);
              await readInput();
              assert.deepEqual(
                recoveryState.db
                  .prepare("SELECT kind FROM events WHERE kind LIKE 'INTAKE_MESSAGE_IDENTITY:%'")
                  .all(),
                nativeRowsBefore,
                "operator association must not synthesize a durable native echo during later capture",
              );
              assert.equal(
                recoveryState.db
                  .prepare("SELECT work_intake_id FROM main_checkpoints WHERE agent_id=?")
                  .get(agentId)!.work_intake_id,
                beforeWork,
              );
              const actualDatabase = recoveryState.db;
              let eventScans = 0;
              const countedDatabase = new Proxy(actualDatabase, {
                get(target, property) {
                  if (property !== "prepare") {
                    const value = Reflect.get(target, property);
                    return typeof value === "function" ? value.bind(target) : value;
                  }
                  return (sql: string) => {
                    const statement = target.prepare(sql);
                    return new Proxy(statement, {
                      get(value, method) {
                        const action = Reflect.get(value, method);
                        if (method !== "get" && method !== "all")
                          return typeof action === "function" ? action.bind(value) : action;
                        return (...args: Parameters<typeof statement.all>) => {
                          const result = Reflect.apply(action, value, args);
                          if (/^\s*SELECT\b/i.test(sql)) {
                            const plan = target.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args);
                            if (plan.some((row) => /\bSCAN events\b/.test(String(row.detail))))
                              eventScans++;
                          }
                          return result;
                        };
                      },
                    });
                  };
                },
              });
              Object.defineProperty(recoveryState, "db", { value: countedDatabase });
              try {
                const beforeStatus = workflowStatus(recoveryState, repo, agentId, vaultRoot);
                const beforeScans = eventScans;
                assert.ok(beforeScans > 0, "the cost proof must observe actual event scans");
                for (let index = 0; index < 6; index++) {
                  const messageId = `status-cost-reminder-${index}`;
                  const nativeMessageId = `10101010-1010-7101-8101-${String(index).padStart(12, "0")}`;
                  const text = `Synthetic completed controller transport ${index}`;
                  const timestamp = new Date().toISOString();
                  recoveryState.db
                    .prepare("INSERT INTO internal_messages VALUES(?,?,?)")
                    .run(agentId, messageId, "reminder");
                  rememberIntakeIdentity(recoveryState, {
                    agentId,
                    sessionId: providerSessionId,
                    messageId,
                    nativeMessageId,
                    timestamp,
                    textHash: hash(text),
                  });
                  recordInternalMessageOrigins(
                    recoveryState,
                    { agentId, directory: repo },
                    providerSessionId,
                    [
                      {
                        timestamp,
                        item: {
                          type: "user_message",
                          clientMessageId: messageId,
                          messageId: nativeMessageId,
                          text,
                        },
                      },
                    ],
                  );
                }
                recoveryState.transaction(() => {
                  const insert = recoveryState.db.prepare(
                    "INSERT INTO events(at_ms,kind,attempt_id) VALUES(?,?,NULL)",
                  );
                  for (let index = 0; index < 30000; index++)
                    insert.run(Date.now(), `UNRELATED_STATUS_COST:${index}`);
                });
                eventScans = 0;
                const profiledStatus = workflowStatus(recoveryState, repo, agentId, vaultRoot);
                assert.deepEqual({ ...profiledStatus, at: 0 }, { ...beforeStatus, at: 0 });
                assert.equal(
                  eventScans,
                  beforeScans,
                  "additional proven origins must not multiply status event scans",
                );
              } finally {
                Object.defineProperty(recoveryState, "db", { value: actualDatabase });
              }
              // SQL LIKE has case-insensitive/wildcard semantics here. A JS
              // prefix filter must not silently discard the existing collision.
              const claim = `operator_intake_approved:${JSON.stringify({ assessmentId: mistaken.id })}`;
              recoveryState.event(claim);
              assert.throws(
                () => currentIntake(recoveryState, agentId, true),
                /INTAKE_INTERNAL_ORIGIN_CONFLICT/,
              );
              recoveryState.db.prepare("DELETE FROM events WHERE kind=?").run(claim);
              const malformed = "main_input_interpretation:{";
              recoveryState.event(malformed);
              assert.throws(() => currentIntake(recoveryState, agentId, true), /JSON/i);
              recoveryState.db.prepare("DELETE FROM events WHERE kind=?").run(malformed);
              assert.equal(currentIntake(recoveryState, agentId, true).id, beforeWork);
              const confirmationBaseline = workflowStatus(recoveryState, repo, agentId, vaultRoot);
              const unrelatedConfirmationEvent = `OPERATOR_CONFIRMED_EXISTING_WORK:${agentId}:unbound-native-message:fixture`;
              const matchingConfirmationEvent = `OPERATOR_CONFIRMED_EXISTING_WORK:${agentId}:${wake.nativeId}:fixture`;
              recoveryState.event(unrelatedConfirmationEvent);
              assert.deepEqual(
                { ...workflowStatus(recoveryState, repo, agentId, vaultRoot), at: 0 },
                { ...confirmationBaseline, at: 0 },
                "an unrelated confirmation target does not block the normal status",
              );
              recoveryState.event(matchingConfirmationEvent);
              assert.throws(
                () => workflowStatus(recoveryState, repo, agentId, vaultRoot),
                /INTAKE_INTERNAL_ORIGIN_CONFLICT/,
                "confirmed work on a proven native origin must remain a collision",
              );
              recoveryState.db
                .prepare("DELETE FROM events WHERE kind IN (?,?)")
                .run(matchingConfirmationEvent, unrelatedConfirmationEvent);
              assert.deepEqual(
                { ...workflowStatus(recoveryState, repo, agentId, vaultRoot), at: 0 },
                { ...confirmationBaseline, at: 0 },
                "removing only the fixture confirmations restores the same normal status",
              );
            } finally {
              recoveryState.close();
              savedSessionId = savedMainSession;
            }
            await registerInput(
              "wake-followed-by-human-stop",
              "Stop the unchanged implementation",
              false,
            );
            await readInput();
            const beforeHumanStop = new Store(database);
            assert.throws(
              () => currentIntake(beforeHumanStop, agentId, true),
              /MAIN_INPUT_INTERPRETATION_REQUIRED|INTAKE_PENDING/,
            );
            beforeHumanStop.close();
            await interpret("stop");
            const stoppedState = new Store(database);
            assert.throws(
              () => currentIntake(stoppedState, agentId, true),
              /INTAKE_IMPLEMENTATION_NOT_AUTHORIZED/,
            );
            stoppedState.close();
          } finally {
            rehydratedHistory = false;
            historyGap = false;
            providerSessionId = "fixture-session";
            sessionChangesDuringHistory = false;
          }
        }
        await mainAuthority.test(
          "rehydrated internal wake preserves the bound task and a later human stop",
          recoverInternalWake,
        );

        await registerInput(
          "advisory-start-000002",
          "Implement advisory example second objective",
          false,
        );
        requestSeen = new Promise<void>((resolve) => {
          noticeRequest = resolve;
        });
        responseGate = new Promise<void>((resolve) => {
          releaseAdvice = resolve;
        });
        pendingRead = readInput();
        await requestSeen;
        await interpret("start");
        await registerInput("advisory-stop-0000001", "Stop implementation", false);
        const { input: uninterpreted } = await readInput();
        const beforeStop = new Store(database);
        assert.throws(
          () => currentIntake(beforeStop, agentId, true),
          /MAIN_INPUT_INTERPRETATION_REQUIRED|INTAKE_PENDING/,
        );
        beforeStop.close();
        await assert.rejects(
          () =>
            settingsOperation(
              {
                operation: "auto-interpret",
                agentId,
                directory: repo,
                interpretation: {
                  intakeId: uninterpreted.intakeId,
                  previousWorkIntakeId: uninterpreted.previousWorkIntakeId,
                  version: 1,
                  action: "stop",
                  factsHash: "0".repeat(64),
                },
              },
              advisoryOptions,
            ),
          /MAIN_INPUT_FACTS_CHANGED/,
        );
        const stopped = await interpret("stop");
        releaseAdvice();
        await pendingRead;
        const afterStop = new Store(database);
        assert.equal(currentIntake(afterStop, agentId, false).result.intent, "cancel");
        assert.throws(
          () => currentIntake(afterStop, agentId, true),
          /INTAKE_IMPLEMENTATION_NOT_AUTHORIZED/,
        );
        assert.equal(
          afterStop.db
            .prepare("SELECT work_intake_id FROM main_checkpoints WHERE agent_id=?")
            .get(agentId)!.work_intake_id,
          null,
          "late advisory settlement cannot resurrect a stopped order",
        );
        assert.equal(requests, 2);
        afterStop.close();
        await assert.rejects(
          () =>
            settingsOperation(
              {
                operation: "auto-interpret",
                agentId,
                directory: repo,
                interpretation: { ...stopped, action: "start" },
              },
              advisoryOptions,
            ),
          /MAIN_INPUT_INTERPRETATION_CONFLICT/,
        );
        messages.push({
          id: "agent-notification-0001",
          text: "Implement more work",
          timestamp: new Date().toISOString(),
        });
        const { input: unverified } = await readInput();
        await assert.rejects(
          () =>
            settingsOperation(
              {
                operation: "auto-interpret",
                agentId,
                directory: repo,
                interpretation: {
                  version: 1,
                  intakeId: unverified.intakeId,
                  factsHash: unverified.factsHash,
                  previousWorkIntakeId: unverified.previousWorkIntakeId,
                  action: "start",
                },
              },
              advisoryOptions,
            ),
          /INTAKE_HUMAN_ORIGIN_UNCONFIRMED/,
        );
        await registerInput("reactivation-start-0001", "Start the final isolated example", false);
        await interpret("start");
        messages.push({
          id: "unreceipted-stop-0001",
          text: "Stopp",
          timestamp: new Date().toISOString(),
        });
        await settingsOperation(
          { operation: "auto-state", agentId, directory: repo, state: "off", requestId: "" },
          advisoryOptions,
        );
        await settingsOperation(
          {
            operation: "auto-state",
            agentId,
            directory: repo,
            state: "arming",
            requestId: "reactivation-check",
          },
          advisoryOptions,
        );
        await settingsOperation(
          {
            operation: "auto-state",
            agentId,
            directory: repo,
            state: "ready",
            requestId: "reactivation-check",
          },
          advisoryOptions,
        );
        const reactivated = new Store(database);
        try {
          assert.throws(
            () => currentIntake(reactivated, agentId, true),
            /INTAKE_PENDING/,
            "reactivation cannot hide a newer unseen stop behind the earlier interpreted start",
          );
        } finally {
          reactivated.close();
        }
      } finally {
        releaseAdvice();
        await pendingRead.catch(() => {});
      }
    },
  );
});
