import assert from "node:assert/strict";
import { test, after, afterEach } from "node:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { PreparationInput } from "../paseo-plugin/shared/preparation.ts";

const fixtureRoot = realpathSync(process.cwd());
// The modelled eligible project is independent of the checkout/build location.
const projectDirectory = "C:/IFI_SourceCode/preparation-fixture";
const fixture = mkdtempSync(path.join(fixtureRoot, ".preparation-"));
interface TestRuntime {
  prepareExisting(
    agentId: string,
    requestId: string,
    paseo: unknown,
    retry: boolean,
  ): Promise<unknown>;
  toggle(agentId: string, enabled: boolean, paseo: unknown): Promise<unknown>;
  dispose(): void;
}
declare global {
  var __PASEO_PREPARATION_CONTROLLER__: (input: Record<string, unknown>) => Promise<unknown>;
}
const runtimes: TestRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});
const previousRoot = process.env.PASEO_ORCHESTRATOR_ROOT;
const previousNode = process.env.PASEO_ORCHESTRATOR_NODE;
process.env.PASEO_ORCHESTRATOR_ROOT = fixtureRoot;
process.env.PASEO_ORCHESTRATOR_NODE = process.execPath;
// Directory plugins use extensionless author imports. Exercise that same build
// resolution in the existing Node test suite, without opening any provider.
await build({
  stdin: {
    contents:
      'export { prepareOrchestratorSession } from "./paseo-plugin/server/preparation.ts"; export { AutomationRuntime } from "./paseo-plugin/server/automation.ts";',
    resolveDir: fixtureRoot,
    sourcefile: "preparation-test-entry.ts",
  },
  outfile: path.join(fixture, "preparation.mjs"),
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node24",
  plugins: [
    {
      name: "isolated-preparation-controller",
      setup(builder) {
        builder.onResolve({ filter: /^\.\/controller$/ }, () => ({
          path: "test-controller",
          namespace: "preparation-test",
        }));
        builder.onLoad({ filter: /.*/, namespace: "preparation-test" }, () => ({
          contents: `
        export const controllerRoot = ${JSON.stringify(fixtureRoot)};
        export const controllerNodeExecutable = process.execPath;
        export function controllerEntrypoint() { throw Error("REAL_RUNNER_FORBIDDEN"); }
        export const controller = (input) => globalThis.__PASEO_PREPARATION_CONTROLLER__(input);
      `,
          loader: "js",
        }));
      },
    },
  ],
});
const { prepareOrchestratorSession: prepare, AutomationRuntime } = (await import(
  pathToFileURL(path.join(fixture, "preparation.mjs")).href
)) as {
  prepareOrchestratorSession: (
    request: PreparationInput,
    paseo: unknown,
    automation: unknown,
  ) => Promise<{ agentId: string; workspaceId: string; automation: string }>;
  AutomationRuntime: new () => TestRuntime;
};
after(() => {
  if (previousRoot === undefined) delete process.env.PASEO_ORCHESTRATOR_ROOT;
  else process.env.PASEO_ORCHESTRATOR_ROOT = previousRoot;
  if (previousNode === undefined) delete process.env.PASEO_ORCHESTRATOR_NODE;
  else process.env.PASEO_ORCHESTRATOR_NODE = previousNode;
  const resolved = realpathSync(fixture);
  assert.equal(path.dirname(resolved), fixtureRoot);
  assert.ok(path.basename(resolved).startsWith(".preparation-"));
  rmSync(resolved, { recursive: true, force: true });
});

const request: PreparationInput = {
  requestId: "prepare_existing_main_001",
  projectId: "project",
  workspaceId: "workspace",
  agentId: "existing-main",
  model: "gpt-6.1-sol",
  reasoning: "xhigh",
  modeId: "plan",
  autoRouting: true,
  dataScope: "public",
};
function existingMain() {
  let state: { agentId: string; requestId: string; directory: string; state: string } | undefined;
  const snapshot = {
    id: request.agentId,
    provider: "codex",
    model: request.model,
    effectiveThinkingOptionId: request.reasoning,
    currentModeId: request.modeId,
    cwd: projectDirectory,
    workspaceId: request.workspaceId,
    title: "Preserve this conversation",
    status: "idle",
    activeTurn: null as { id: string } | null,
    pendingPermissions: [] as string[],
    labels: { unrelated: "preserve" } as Record<string, string>,
    capabilities: { supportsBackgroundWorkRefresh: true },
    runtimeInfo: { sessionId: "existing-native-session" },
  };
  const observation = {
    agentId: request.agentId,
    providerSessionId: snapshot.runtimeInfo.sessionId,
    observationId: "fresh-native-observation",
    coverage: "codex_background_terminals",
    queriedProviderSessionIds: [snapshot.runtimeInfo.sessionId],
    items: [] as unknown[],
    providerSubagents: [] as { id: string; status: string }[],
  };
  const events: string[] = [];
  const sent: { text: string; options: { messageId: string } }[] = [];
  let unknownSend = false;
  const create = async () => {
    events.push("create");
    throw Error("REPLACEMENT_MAIN_CREATED");
  };
  const handle = {
    refresh: async () => ({ agent: structuredClone(snapshot) }),
    backgroundWork: {
      refresh: async () => {
        events.push("native-query");
        return structuredClone(observation);
      },
    },
    setLabels: async (labels: Record<string, string>) => {
      events.push("label-write");
      Object.assign(snapshot.labels, labels);
    },
    send: async (text: string, options: { messageId: string }) => {
      sent.push({ text, options });
      if (unknownSend) throw Error("SEND_OUTCOME_UNKNOWN");
    },
  };
  const paseo = {
    projects: {
      list: async () => ({
        projects: [{ projectId: "project", projectRootPath: projectDirectory }],
      }),
    },
    workspaces: {
      ref: () => ({
        projectId: "project",
        directory: projectDirectory,
        refresh: async () => {},
        agents: { create },
      }),
    },
    agents: {
      ref: (id: string) => {
        assert.equal(id, "existing-main");
        return handle;
      },
      create,
    },
    providers: {
      snapshot: async () => ({
        entries: [
          {
            provider: "codex",
            status: "ready",
            models: [{ id: "gpt-6.1-sol", thinkingOptions: [{ id: "xhigh" }] }],
            modes: [{ id: "plan" }],
          },
        ],
      }),
    },
  };
  globalThis.__PASEO_PREPARATION_CONTROLLER__ = async (input) => {
    if (input.operation === "auto-list") return { mains: state ? [state] : [] };
    if (input.operation === "auto-state") {
      state = {
        agentId: String(input.agentId),
        requestId: String(input.requestId),
        directory: String(input.directory),
        state: String(input.state),
      };
      return {};
    }
    throw Error("UNEXPECTED_CONTROLLER_OPERATION");
  };
  const automation = new AutomationRuntime();
  // Only process spawning/timeline publication are substituted. The real
  // prepareExisting -> toggle -> bootstrap send/state lifecycle runs below.
  Object.assign(automation, {
    ensureRunner: () => {},
    publish: async () => {},
    status: async () => ({ automation: state?.state ?? "off" }),
  });
  runtimes.push(automation);
  return {
    snapshot,
    observation,
    events,
    paseo,
    automation,
    sent,
    failSend: () => {
      unknownSend = true;
    },
    activationState: () => state?.state,
  };
}

test("existing-main preparation preserves identity, selection and unrelated labels on retries", async () => {
  const main = existingMain();
  const original = structuredClone(main.snapshot);
  const expected = { agentId: "existing-main", workspaceId: "workspace", automation: "ready" };
  assert.deepEqual(await prepare(request, main.paseo, main.automation), expected);
  assert.deepEqual(main.events, ["native-query", "label-write"]);
  assert.equal(main.sent.length, 1, "ready requires delivery of the normal activation bootstrap");
  assert.equal(main.sent[0].options.messageId, request.requestId);
  for (const instruction of [
    "existing-main",
    "orchestrator_status",
    "orchestrator_register_task",
    "NEEDS_CONFIRMATION",
    "COMPLETE",
    "Sandbox-Einstellungen bleiben unverändert",
  ])
    assert.ok(
      main.sent[0].text.includes(instruction),
      `Missing required instruction: ${instruction}`,
    );
  assert.deepEqual(main.snapshot, {
    ...original,
    labels: {
      ...original.labels,
      orchestratorPreparation: request.requestId,
      orchestratorScope: "public",
      orchestratorPreparationIdentity: main.snapshot.labels.orchestratorPreparationIdentity,
    },
  });
  assert.match(main.snapshot.labels.orchestratorPreparationIdentity, /^[a-f0-9]{64}$/);
  assert.deepEqual(await prepare(request, main.paseo, main.automation), expected);
  assert.equal(main.events.filter((event) => event === "label-write").length, 1);
  assert.equal(main.sent.length, 1, "retry must not replay the bootstrap");
  const before = [...main.events];
  await assert.rejects(
    prepare({ ...request, dataScope: "company" }, main.paseo, main.automation),
    /AUTOMATION_PREPARATION_CHANGED/,
  );
  assert.deepEqual(main.events, before);
  await main.automation.toggle("existing-main", false, main.paseo);
  assert.equal((await prepare(request, main.paseo, main.automation)).automation, "off");
  assert.equal(main.sent.length, 1, "preparation retry must preserve deliberate disable");
});

test("an unknown activation send remains uncertain without replay on preparation retry", async () => {
  const main = existingMain();
  main.failSend();
  await assert.rejects(prepare(request, main.paseo, main.automation), /ACTIVATION_UNCERTAIN/);
  assert.equal(main.activationState(), "uncertain");
  await assert.rejects(prepare(request, main.paseo, main.automation), /ACTIVATION_UNCERTAIN/);
  assert.equal(main.sent.length, 1);
});

test("existing-main preparation waits for idle and rejects unverified native work before mutation", async () => {
  const cases: {
    name: string;
    change: (main: ReturnType<typeof existingMain>) => void;
    error: RegExp;
  }[] = [
    {
      name: "foreground turn",
      change: (main) => {
        main.snapshot.status = "running";
      },
      error: /MAIN_MUST_BE_IDLE/,
    },
    {
      name: "pending permission",
      change: (main) => {
        main.snapshot.pendingPermissions.push("permission");
      },
      error: /MAIN_MUST_BE_IDLE/,
    },
    {
      name: "missing capability",
      change: (main) => {
        main.snapshot.capabilities.supportsBackgroundWorkRefresh = false;
      },
      error: /COMPATIBLE_DAEMON_REQUIRED/,
    },
    {
      name: "different native session",
      change: (main) => {
        main.observation.providerSessionId = "other-session";
      },
      error: /NATIVE_PROCESS_PROOF_UNAVAILABLE/,
    },
    {
      name: "active terminal",
      change: (main) => {
        main.observation.items.push({ processId: "known-active" });
      },
      error: /NATIVE_PROCESS_PROOF_UNAVAILABLE/,
    },
    {
      name: "active provider subagent",
      change: (main) => {
        main.observation.providerSubagents.push({ id: "provider-child", status: "running" });
      },
      error: /NATIVE_PROCESS_PROOF_UNAVAILABLE/,
    },
  ];
  for (const scenario of cases) {
    const main = existingMain();
    scenario.change(main);
    await assert.rejects(
      prepare(request, main.paseo, main.automation),
      scenario.error,
      scenario.name,
    );
    assert.ok(!main.events.includes("create"), scenario.name);
    assert.ok(!main.events.includes("label-write"), scenario.name);
    assert.equal(main.sent.length, 0, scenario.name);
  }
});
