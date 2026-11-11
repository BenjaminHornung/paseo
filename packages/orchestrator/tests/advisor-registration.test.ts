import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Engine } from "../src/engine.ts";
import {
  canonicalPath,
  configSchema,
  contractSchema,
  type Config,
  type RuntimeRoute,
} from "../src/contracts.ts";
import { Git } from "../src/git.ts";
import type { Provider } from "../src/provider.ts";
import { Store } from "../src/store.ts";

const exampleConfig = JSON.parse(readFileSync("config/controller.local.example.json", "utf8")) as {
  routes: RuntimeRoute[];
  [key: string]: unknown;
};
const config: Config = configSchema.parse({
  ...exampleConfig,
  orchestrationVersion: 2,
  liveDispatchApproved: true,
  routes: exampleConfig.routes.map((route) => ({
    ...route,
    revision: "advisor-registration-test",
  })),
});

// Concrete fault: source-workspace registration omits workspace identity, so the dirty-check
// blocks a read-only advisor despite an active writer lease. Existing routing tests never run
// this registration path against a dirty Git tree and its SQLite lease.
function createFixture(placement: "legacy" | "public") {
  const stateDirectory = path.join(process.cwd(), "state");
  mkdirSync(stateDirectory, { recursive: true });
  const directory = mkdtempSync(path.join(stateDirectory, "advisor-registration-"));
  const repository = path.join(directory, "repository");
  const worktree = path.join(directory, "worktree");
  const git = new Git(config.gitExecutable);
  git.run(directory, ["init", "-b", "main", repository]);
  git.run(repository, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(repository, "value.txt"), "before\n");
  git.run(repository, ["add", "value.txt"]);
  git.run(repository, [
    "-c",
    "user.name=Local Test",
    "-c",
    "user.email=local-test@invalid",
    "commit",
    "-m",
    "fixture baseline",
  ]);
  git.createWorktree(repository, worktree, "advisor-registration");

  const contract = contractSchema.parse({
    workflowId: "advisor-registration",
    taskId: "writer",
    repository: canonicalPath(repository),
    worktree: canonicalPath(worktree),
    baseCommit: git.run(worktree, ["rev-parse", "HEAD"]),
    dataScope: "personal",
    role: "implement-normal",
    prompt: "Change value.txt",
    acceptance: ["Value changed correctly"],
    allowedPaths: ["value.txt"],
    requiredCapabilities: ["code"],
    minTier: 2,
    mutation: true,
    workspace:
      placement === "public"
        ? {
            id: "source-workspace",
            directory: canonicalPath(worktree),
            mainAgentId: "existing-main",
          }
        : undefined,
    highRisk: false,
    uiChanged: false,
    checks: {
      build: [process.execPath, "-e", "process.exit(0)"],
      test: [process.execPath, "-e", "process.exit(0)"],
    },
  });
  const store = new Store(path.join(directory, "controller.sqlite"));
  const engine = new Engine(store, config, {} as Provider);
  const writerKey = engine.add(contract);
  const route = config.routes.find((candidate) => candidate.provider === "codex")!;
  const attempt = store.claim(writerKey, route, config, "writer-session");
  assert.equal(store.beginSend(attempt.id), true);
  store.observe(attempt.id, "RUNNING");
  writeFileSync(path.join(worktree, "value.txt"), "writer change\n");

  return { directory, engine, store, contract, attempt, route, worktree };
}

for (const placement of ["legacy", "public"] as const)
  test(`a read-only advisor may idempotently register against a VERIFY writer’s scoped dirty source (${placement})`, () => {
    const fixture = createFixture(placement);
    try {
      fixture.store.observe(fixture.attempt.id, "VERIFY");
      const writerState = fixture.store.db
        .prepare(`SELECT l.state,a.status FROM leases l
      JOIN attempts a ON a.id=l.attempt_id WHERE a.id=?`)
        .get(fixture.attempt.id) as { state: string; status: string } | undefined;
      assert.equal(writerState?.state, "HELD");
      assert.equal(writerState?.status, "VERIFY");

      const advisor = contractSchema.parse({
        ...fixture.contract,
        taskId: "advisor",
        role: "advisor",
        prompt: "Review the current value and advise.",
        acceptance: ["Advice is tied to the current source."],
        requiredCapabilities: ["text"],
        minTier: 1,
        mutation: false,
        workspace:
          placement === "public"
            ? {
                id: "main-workspace",
                directory: canonicalPath(fixture.directory),
                mainAgentId: "existing-main",
              }
            : undefined,
      });

      if (advisor.workspace) {
        assert.throws(
          () =>
            fixture.engine.add({
              ...advisor,
              workspace: { ...advisor.workspace!, mainAgentId: "foreign-main" },
            }),
          /New task requires clean baseline or exclusively known peer changes/,
          "another main cannot attribute the leased writer's changes",
        );
      }

      assert.throws(
        () =>
          fixture.engine.add({
            ...fixture.contract,
            workspace: undefined,
            taskId: "second-writer",
          }),
        /New task requires clean baseline or exclusively known peer changes/,
        "dirty source must not authorize an unattributed second writer registration",
      );

      const advisorKey = fixture.engine.add(advisor);
      assert.equal(advisorKey, "advisor-registration/advisor/advisor");
      assert.equal(
        fixture.engine.add(advisor),
        advisorKey,
        "re-registering the same advisor contract remains idempotent while the writer is in VERIFY",
      );
      assert.throws(
        () => fixture.store.claim(advisorKey, fixture.route, config, "advisor-session"),
        /Worktree coordination blocked/,
        "advisor registration must not bypass the active writer lease",
      );
      const activeLeases = fixture.store.db
        .prepare("SELECT COUNT(*) AS count FROM leases WHERE state!='RELEASED'")
        .get() as { count: number };
      assert.equal(
        activeLeases.count,
        1,
        "registering an advisor must leave the existing writer lease as the only active lease",
      );

      writeFileSync(path.join(fixture.worktree, "unowned.txt"), "unowned change\n");
      assert.throws(
        () => fixture.engine.add({ ...advisor, taskId: "advisor-out-of-scope" }),
        /New task requires clean baseline or exclusively known peer changes/,
        "an advisor must not register against source outside its declared and leased scope",
      );
    } finally {
      fixture.store.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
