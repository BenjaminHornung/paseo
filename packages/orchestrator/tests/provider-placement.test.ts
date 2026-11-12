import { test, after } from "node:test";
import assert from "node:assert/strict";
import { contractSchema, canonicalPath, type RuntimeRoute } from "../src/contracts.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const fixture = mkdtempSync(path.join(process.cwd(), ".provider-placement-"));
process.env.ORCHESTRATOR_STATE = path.join(fixture, "controller.sqlite");
const { PaseoProvider, taskPrompt, assertSeparateClaudeConfiguration } =
  await import("../src/provider.ts");
const { Store } = await import("../src/store.ts");
const store = new Store(process.env.ORCHESTRATOR_STATE);
after(() => {
  store.close();
  rmSync(fixture, { recursive: true, force: true });
});

// A company launcher inherits process.env when its own directory is absent.
// Ignoring that environment would let both account routes use the same login.
test("private Claude separation compares the effective inherited company directory", () => {
  const companyDirectory = path.join(fixture, "company");
  const privateDirectory = path.join(fixture, "private");
  mkdirSync(companyDirectory);
  mkdirSync(privateDirectory);
  assert.throws(
    () =>
      assertSeparateClaudeConfiguration(
        { CLAUDE_CONFIG_DIR: companyDirectory },
        {},
        { CLAUDE_CONFIG_DIR: companyDirectory },
        process.cwd(),
      ),
    /Separate private Claude configuration directory required/,
    "an inherited company directory cannot also serve the private account",
  );
  assert.doesNotThrow(() =>
    assertSeparateClaudeConfiguration(
      { CLAUDE_CONFIG_DIR: privateDirectory },
      {},
      { CLAUDE_CONFIG_DIR: companyDirectory },
      process.cwd(),
    ),
  );
  assert.doesNotThrow(
    () =>
      assertSeparateClaudeConfiguration(
        { CLAUDE_CONFIG_DIR: privateDirectory },
        { CLAUDE_CONFIG_DIR: companyDirectory },
        { CLAUDE_CONFIG_DIR: privateDirectory },
        process.cwd(),
      ),
    "the company's explicit provider override wins over inherited environment",
  );
});

// Parent labels alone previously created children in a different workspace.
// The public workspace handle, explicit source directory and recovery binding
// must agree even when the main's directory is a non-Git project umbrella.
test("provider creates a child through its pinned workspace with explicit isolated source instructions", async () => {
  const root = canonicalPath(process.cwd());
  const route = JSON.parse(
    readFileSync("config/controller.local.example.json", "utf8"),
  ).routes.find((candidate: RuntimeRoute) => candidate.provider === "codex") as RuntimeRoute;
  const contract = contractSchema.parse({
    workflowId: "workflow",
    taskId: "task",
    repository: root,
    worktree: root,
    workspace: { id: "workspace", directory: root, mainAgentId: "main" },
    baseCommit: "a".repeat(40),
    dataScope: "public",
    role: "implement-normal",
    prompt: "Change the owned file",
    acceptance: ["Works"],
    allowedPaths: ["owned.txt"],
    requiredCapabilities: ["code"],
    minTier: 2,
    mutation: true,
    highRisk: false,
    uiChanged: false,
    checks: { build: ["unused"], test: ["unused"] },
  });
  const provider = new PaseoProvider("ws://127.0.0.1:6767/ws");
  let options: Record<string, unknown> | undefined;
  let childCreates = 0;
  let placementDirectory = root;
  Object.assign(provider, {
    client: {
      workspaces: {
        ref(id: string) {
          assert.equal(id, "workspace");
          return {
            refresh: async () => ({ workspaceDirectory: placementDirectory }),
            agents: {
              create: async (value: Record<string, unknown>) => {
                childCreates++;
                options = value;
                return { id: "child" };
              },
            },
          };
        },
      },
      agents: {
        create: async () => {
          throw Error("Unbound creation would place the child in another workspace");
        },
      },
    },
  });
  assert.equal(await provider.create(route, contract, "workflow/task/1"), "child");
  assert.equal(childCreates, 1);
  assert.equal(options!.parent, "main");
  assert.equal("cwd" in options!, false);
  assert.deepEqual(
    (options!.config as { options: { sandbox_workspace_write: { writable_roots: string[] } } })
      .options.sandbox_workspace_write.writable_roots,
    [root],
    "the worker can write only in the pinned source directory",
  );
  assert.ok(String(options!.prompt).includes(`SOURCE AND COMMAND DIRECTORY is ${root}`));
  assert.ok(taskPrompt(contract).includes("Modify only allowedPaths"));
  const privateRoute: RuntimeRoute = {
    ...route,
    provider: "claude-private",
    access: "claude-personal-pro",
    repositoryRoots: [root],
    modeId: "plan",
  };
  await provider.create(
    privateRoute,
    { ...contract, mutation: false, role: "advisor" },
    "workflow/advisor/1",
  );
  const readonlyConfig = options!.config as {
    provider: string;
    options: { disallowedTools: string[] };
  };
  assert.ok(readonlyConfig.provider.startsWith("claude-private/"));
  assert.deepEqual(
    readonlyConfig.options.disallowedTools,
    ["Write", "Edit", "Bash", "Agent", "Task"],
    "native private read-only roles retain the reviewer tool restriction",
  );
  await provider.create(privateRoute, contract, "workflow/private-writer/1");
  assert.deepEqual(
    (options!.config as { options: { disallowedTools: string[] } }).options.disallowedTools,
    ["Agent", "Task"],
  );
  placementDirectory = canonicalPath(path.dirname(root));
  options = undefined;
  await assert.rejects(provider.create(route, contract, "workflow/task/2"), /workspace changed/);
  assert.equal(options, undefined);
  assert.equal(childCreates, 3, "workspace drift must not start another worker");
  placementDirectory = root;
  Object.assign(provider, {
    client: {
      providers: {
        snapshot: async () => ({
          entries: [
            { provider: "pi", status: "loading" },
            {
              provider: "codex",
              status: "ready",
              models: [{ id: "ready-model", thinkingOptions: [] }],
              modes: [],
            },
          ],
        }),
      },
      workspaces: {
        open: async (directory: string) => {
          assert.equal(directory, root);
          return {
            refresh: async () => ({ workspaceDirectory: root }),
            agents: {
              create: async (value: Record<string, unknown>) => {
                assert.equal(value.parent, undefined);
                return { id: "source-child" };
              },
            },
          };
        },
      },
    },
  });
  const discovery = await provider.discover(root);
  assert.equal(
    discovery.find((entry) => entry.provider === "codex")?.models[0].id,
    "ready-model",
    "a loading Pi cannot prevent discovery of a ready Codex route",
  );
  assert.equal(
    await provider.create(route, { ...contract, workspace: undefined }, "standalone/task/1"),
    "source-child",
  );
});

// A timed-out waiter must not overwrite an authoritative idle snapshot. That
// false unknown otherwise prevents an idle existing worker from continuing.
test("a wait timeout preserves idle foreground state without asserting background quiescence", async () => {
  const provider = new PaseoProvider("ws://127.0.0.1:6767/ws");
  let status = "idle",
    activeTurn: unknown = undefined;
  const snapshot = () => ({
    id: "worker",
    cwd: process.cwd(),
    provider: "codex",
    model: "fixture-model",
    status,
    activeTurn,
    pendingPermissions: [],
  });
  Object.assign(provider, {
    client: {
      agents: {
        ref: () => ({
          id: "worker",
          refresh: async () => ({ agent: snapshot() }),
          waitForFinish: async () => ({ status: "timeout", final: snapshot() }),
          run: async () => ({ status: "timeout", final: snapshot() }),
        }),
      },
    },
  });
  for (const result of [await provider.refresh("worker"), await provider.wait("worker")]) {
    assert.equal(result!.status, "idle");
    assert.equal(result!.turnComplete, true);
    assert.equal(result!.backgroundActive, null, "idle does not prove process quiescence");
  }
  assert.equal(
    (await provider.run("worker", "Continue existing work")).status,
    "unknown",
    "a newly sent prompt without a turn acknowledgement must not appear completed",
  );
  status = "running";
  activeTurn = { id: "active-turn" };
  const running = await provider.wait("worker");
  assert.equal(running.status, "running");
  assert.equal(running.turnComplete, false);
  activeTurn = undefined;
  assert.equal(
    (await provider.wait("worker")).status,
    "unknown",
    "unsettled state without an active turn stays uncertain",
  );
});
