import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { configSchema, contractSchema, hash, localPath } from "./contracts.ts";
import { Store } from "./store.ts";
import { appRoot, codeRoot } from "./settings-files.ts";
import { Engine } from "./engine.ts";
import { PaseoProvider } from "./provider.ts";
import { Git } from "./git.ts";
import { setTimeout as delay } from "node:timers/promises";
import { syncProfiles } from "./profiles.ts";
import { OptionalBackgroundCapability, type BackgroundHandle } from "./completion.ts";
import { Decisions } from "./decisions.ts";
import { CredentialVault } from "./secrets.ts";
import { settingsOperation } from "./settings.ts";
import { randomUUID } from "node:crypto";
import { automaticTaskKeys, taskDispatchAllowed } from "./automation.ts";
import { acquireWatchLease } from "./watch-lock.ts";
import { assertTaskAssessment, approveLowConfidenceIntake, captureHumanIntake } from "./intake.ts";
import { bindLegacyIntakeIdentity, rebaseLegacyIntakeCursor } from "./intake-identity.ts";
import { readAutomation } from "./automation.ts";

const root = appRoot;
const configFile =
  process.env.ORCHESTRATOR_CONFIG ??
  path.join(
    root,
    existsSync(path.join(root, "config/local.controller.json"))
      ? "config/local.controller.json"
      : "config/controller.local.example.json",
  );
const stateFile = process.env.ORCHESTRATOR_STATE ?? path.join(root, "state/controller.sqlite");
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));
const print = (v: unknown): void => {
  console.log(JSON.stringify(v, null, 2));
};
const [command, subcommand, argument] = process.argv.slice(2);
let store: Store | undefined;
let provider: PaseoProvider | undefined;
try {
  localPath(process.cwd());
  const config = configSchema.parse(readJson(configFile));
  const connection = async (): Promise<PaseoProvider> => {
    provider ??= new PaseoProvider(config.daemonUrl);
    await provider.connect();
    return provider;
  };
  if (command === "auto" && argument && ["status", "worktree", "register"].includes(subcommand)) {
    const identity = { agentId: argument, directory: process.cwd() };
    if (subcommand === "status")
      print(await settingsOperation({ operation: "status", ...identity }));
    else if (subcommand === "worktree" && process.argv[5])
      print(
        await settingsOperation({
          operation: "auto-worktree",
          ...identity,
          slug: process.argv[5],
          repository: process.argv[6],
        }),
      );
    else if (subcommand === "register" && process.argv[5])
      print(
        await settingsOperation({
          operation: "auto-task",
          ...identity,
          contract: readJson(localPath(process.argv[5])),
        }),
      );
    else throw Error("AUTOMATION_ARGUMENT_REQUIRED");
  } else if (command === "decisions" && subcommand === "test") {
    print(
      await settingsOperation({ operation: "test-decisions", nonce: argument ?? randomUUID() }),
    );
  } else if (command === "decisions" && subcommand === "status") {
    store = new Store(stateFile);
    print({
      enabled: config.decisions?.enabled ?? false,
      model: "gpt-6-luna",
      roles: config.decisions?.roles ?? [],
      credentialConfigured: new CredentialVault().status("decisions").present,
      usage: new Decisions(store).usage(),
    });
  } else if (command === "profiles") {
    const p = await connection();
    const live = (await p.client.config.get()).config.agentProfiles ?? [];
    if (subcommand === "sync") {
      const target = argument ?? path.join(root, "config/local.controller.json");
      const effective = syncProfiles(config, live);
      if (existsSync(target)) {
        const previous = readFileSync(target, "utf8"),
          backup = `${target}.${hash(JSON.parse(previous)).slice(0, 12)}.bak`;
        if (!existsSync(backup)) writeFileSync(backup, previous, { flag: "wx" });
      }
      const pending = `${target}.pending-${hash(effective).slice(0, 12)}`;
      writeFileSync(pending, JSON.stringify(effective, null, 2) + "\n", { flag: "wx" });
      renameSync(pending, target);
      print({
        saved: target,
        configHash: hash(effective),
        liveDispatchApproved: effective.liveDispatchApproved,
      });
    } else
      print(
        live.map((p) => ({
          id: p.id,
          name: p.name,
          provider: p.provider,
          model: p.model,
          mode: p.modeId,
          reasoning: p.thinkingOptionId,
        })),
      );
  } else if (command === "routing") {
    print({
      config: configFile,
      roles: config.roleRoutes,
      routes: config.routes.map((r) => ({
        route: r.id,
        name: r.name ?? r.profileName ?? r.id,
        profile: r.profileName ?? r.profileId,
        model: r.model,
        reasoning: r.reasoning,
        enabled: r.enabled,
        tier: r.tier,
        scopes: r.dataScopes,
      })),
    });
  } else if (command === "doctor") {
    const p = await connection();
    const discovered = await p.discover(process.cwd());
    const capability = new OptionalBackgroundCapability(
      p.client.agents.ref(argument ?? "capability-probe") as unknown as BackgroundHandle,
    );
    const background =
      subcommand === "background" && argument ? await capability.inventory() : undefined;
    const buildInfo = path.join(codeRoot, "dist/build-info.json");
    const sdk = existsSync(buildInfo)
      ? (readJson(buildInfo) as { sdk: string }).sdk
      : `@getpaseo/client@${(readJson(path.join(codeRoot, "../client/package.json")) as { version: string }).version}`;
    print({
      node: process.version,
      sdk,
      configHash: hash(config),
      liveDispatchApproved: config.liveDispatchApproved,
      apiEnabled: config.apiEnabled,
      backgroundObservation: {
        sdkSurface: capability.available,
        liveReadVerified: background?.verified ?? false,
        activeItems: background?.verified ? background.items.length : null,
        mode: capability.available
          ? "per-agent-public-inventory"
          : "controlled-foreground-attestation",
      },
      routes: config.routes.map((r) => ({
        id: r.id,
        provider: r.provider,
        model: r.model,
        enabled: r.enabled,
        discovered: discovered.some(
          (p) =>
            p.status === "ready" &&
            p.provider === r.provider &&
            p.models.some(
              (m) =>
                m.id === r.model &&
                (m.thinking.length ? m.thinking.includes(r.reasoning) : r.reasoning === ""),
            ),
        ),
        revisionVerified: r.revision !== "discovery-required",
      })),
    });
  } else if (
    command === "worktree" &&
    subcommand === "create" &&
    argument &&
    process.argv[5] &&
    process.argv[6]
  ) {
    print({
      worktree: new Git(config.gitExecutable).createWorktree(
        argument,
        process.argv[5],
        process.argv[6],
      ),
    });
  } else if (command === "workflow" && subcommand === "dry-run" && argument) {
    store = new Store(":memory:");
    const e = new Engine(store, config, await connection());
    const key = e.add(readJson(argument));
    print(await e.plan(key));
  } else {
    const mutating =
      ["intake-bind", "scope-approve", "checks-approve"].includes(command) ||
      (command === "workflow" &&
        [
          "add",
          "dispatch",
          "deliver",
          "advance",
          "review",
          "verify",
          "reconcile",
          "attest",
          "attest-review",
        ].includes(subcommand)) ||
      ["recover", "stop", "resume", "watch", "tick"].includes(command);
    if (!existsSync(stateFile) && !mutating) {
      print({ state: "not-initialized", entries: [] });
    } else {
      store = new Store(stateFile);
      if (
        command === "intake-approve" &&
        subcommand &&
        argument &&
        process.argv[5] &&
        process.argv[6]
      ) {
        const main = readAutomation().mains.find((main) => main.agentId === subcommand);
        if (!main) throw Error("INTAKE_MIGRATION_MAIN_NOT_REGISTERED");
        const p = await connection();
        const snapshot = (await p.client.agents.ref(main.agentId).refresh())?.agent;
        if (
          !snapshot ||
          snapshot.status !== "idle" ||
          snapshot.activeTurn ||
          snapshot.pendingPermissions.length
        )
          throw Error("AUTOMATION_MAIN_MUST_BE_IDLE");
        await captureHumanIntake(store, config, p.client, main);
        approveLowConfidenceIntake(store, main.agentId, argument, process.argv[5], process.argv[6]);
        print({ approved: true, assessmentId: argument });
      } else if (command === "intake-rebase" && subcommand && argument && process.argv[5]) {
        const main = readAutomation().mains.find((main) => main.agentId === subcommand);
        if (!main) throw Error("INTAKE_MIGRATION_MAIN_NOT_REGISTERED");
        print({
          messageId: await rebaseLegacyIntakeCursor(store, (await connection()).client, {
            agentId: subcommand,
            directory: main.directory,
            sessionId: argument,
            expectedCheckpoint: process.argv[5],
          }),
        });
      } else if (
        command === "intake-bind" &&
        subcommand &&
        argument &&
        process.argv[5] &&
        process.argv[6]
      ) {
        const main = readAutomation().mains.find((main) => main.agentId === subcommand);
        if (!main) throw Error("INTAKE_MIGRATION_MAIN_NOT_REGISTERED");
        await bindLegacyIntakeIdentity(store, (await connection()).client, {
          agentId: subcommand,
          directory: main.directory,
          messageId: argument,
          nativeMessageId: process.argv[5],
          sessionId: process.argv[6],
        });
        print({ bound: true, messageId: argument, nativeMessageId: process.argv[5] });
      } else if (
        ["scope-approve", "checks-approve"].includes(command) &&
        subcommand &&
        argument &&
        process.argv.length > 5
      ) {
        // Explicit operator entry point. Never expose this through settings-RPC
        // or an agent tool: the classified main cannot grant itself more scope.
        const task = store.task(subcommand),
          attempt = store.latest(subcommand);
        if (!task || !attempt?.agent_id) throw Error("SCOPE_EXTENSION_TASK_REQUIRED");
        const contract = contractSchema.parse(JSON.parse(task.contract_json));
        assertTaskAssessment(store, configSchema.parse(JSON.parse(task.config_json)), contract);
        const snapshot = await (await connection()).refresh(attempt.agent_id);
        if (
          !snapshot ||
          snapshot.status !== "idle" ||
          snapshot.foregroundActive ||
          snapshot.backgroundActive === true
        )
          throw Error("SCOPE_EXTENSION_WORKER_MUST_BE_PAUSED");
        if (command === "scope-approve")
          print({
            approved: true,
            scopeRevision: store.approveScopeExtension(subcommand, process.argv.slice(5), argument),
          });
        else {
          const checks = contractSchema.parse({
            ...contract,
            checks: readJson(localPath(process.argv[5])),
          }).checks;
          for (const executable of [checks.build[0], checks.test[0]]) {
            if (!path.isAbsolute(executable))
              throw Error("CHECK_COMMAND_ABSOLUTE_EXECUTABLE_REQUIRED");
            localPath(executable);
          }
          print({
            approved: true,
            checkRevision: store.approveCheckCommands(subcommand, checks, argument),
          });
        }
      } else if (command === "workflow" && subcommand === "list") {
        print(
          store.db.prepare("SELECT key,state,rework,contract_hash FROM tasks ORDER BY key").all(),
        );
      } else if (command === "workflow" && subcommand === "show" && argument) {
        const t = store.task(argument);
        if (!t) throw Error("Task not found");
        const c = contractSchema.parse(JSON.parse(t.contract_json));
        print({
          key: t.key,
          state: t.state,
          rework: t.rework,
          contractHash: t.contract_hash,
          role: c.role,
          dataScope: c.dataScope,
          attempts: store.db
            .prepare(
              "SELECT id,status,agent_id,fence,error_kind FROM attempts WHERE task_key=? ORDER BY sequence",
            )
            .all(argument),
        });
      } else if (command === "agents" && subcommand === "active") {
        print(
          store
            .active()
            .map((a) => ({ id: a.id, status: a.status, agentId: a.agent_id, fence: a.fence })),
        );
      } else if (command === "budget" && subcommand === "show") {
        print({
          apiEnabled: config.apiEnabled,
          capsMicroUsd: config.budgets,
          decisions: new Decisions(store).usage(),
          reservations: store.db
            .prepare(
              "SELECT bucket,state,SUM(reserved) AS reserved,SUM(settled) AS settled FROM reservations GROUP BY bucket,state",
            )
            .all(),
        });
      } else if (command === "events" && subcommand === "tail") {
        print(store.db.prepare("SELECT * FROM events ORDER BY sequence DESC LIMIT 30").all());
      } else if (command === "backup" && subcommand) {
        if (existsSync(subcommand)) throw Error("Backup target already exists");
        localPath(path.dirname(path.resolve(subcommand)));
        await store.backupTo(subcommand);
        print({ backedUp: true });
      } else if (command === "stop" || command === "resume") {
        store.stop(command === "stop");
        print({ dispatchStopped: store.stopped(), runningAgentsCancelled: false });
      } else if (command === "recover") {
        const e = new Engine(store, config, await connection());
        print(
          (await e.recover()).map((a) => ({ id: a.id, status: a.status, agentId: a.agent_id })),
        );
      } else if (command === "tick") {
        const e = new Engine(store, config, await connection());
        await e.tick();
        print({ advanced: true });
      } else if (command === "watch") {
        const lease = await acquireWatchLease(`${stateFile}.watch`);
        let stopping = false;
        process.once("SIGINT", () => {
          stopping = true;
        });
        process.once("SIGTERM", () => {
          stopping = true;
        });
        if (subcommand === "--automation") {
          process.stdin.resume();
          process.stdin.once("end", () => {
            stopping = true;
          });
        }
        try {
          print({ watching: true, dispatchApproved: config.liveDispatchApproved });
          while (lease.held()) {
            if (stopping) break;
            const current = configSchema.parse(readJson(configFile));
            const gate = (key: string) =>
              lease.held() &&
              (subcommand === "--automation"
                ? automaticTaskKeys().includes(key)
                : taskDispatchAllowed(key));
            const e = new Engine(store, current, await connection(), undefined, undefined, gate);
            await e.tick(subcommand === "--automation" ? automaticTaskKeys() : undefined);
            print({ watching: true, tickCompletedAt: Date.now() });
            if (!stopping) await delay(5000);
          }
        } finally {
          process.stdin.pause();
          await lease.release();
        }
      } else if (command === "workflow" && argument) {
        const e = new Engine(store, config, await connection());
        if (subcommand === "add") print({ key: e.add(readJson(argument)) });
        else if (subcommand === "dispatch") print({ id: (await e.dispatch(argument)).id });
        else if (subcommand === "deliver") print({ id: (await e.deliver(argument)).id });
        else if (subcommand === "reconcile") {
          const a = await e.reconcile(argument);
          print({ id: a.id, status: a.status });
        } else if (subcommand === "review") print(await e.review(argument));
        else if (subcommand === "advance") {
          await e.advance(argument);
          print({ status: store.attempt(argument).status });
        } else if (subcommand === "attest" || subcommand === "attest-review") {
          await e.attest(argument, subcommand === "attest-review");
          print({
            attested: true,
            type: "operator-reviewed-foreground-only",
            hostProcessProof: false,
          });
        } else if (subcommand === "verify" && process.argv[5])
          print(e.verify(argument, readJson(process.argv[5])));
        else throw Error("Unknown workflow command");
      } else
        throw Error(
          "Use doctor, worktree create <repo> <destination> <slug>, workflow add|dry-run <contract>, workflow list|show|dispatch|deliver|review|reconcile|verify, agents active, budget show, events tail, recover, watch, stop, resume, backup <file>",
        );
    }
  }
} catch (error) {
  // Provider errors and contract inputs can contain confidential values. Never dump them.
  print({
    error: "COMMAND_FAILED",
    kind: error instanceof Error ? error.name : "UnknownError",
    code:
      error instanceof Error && /^(?:WATCH_ALREADY_RUNNING|AUTOMATION_[A-Z_]+)$/.test(error.message)
        ? error.message
        : undefined,
    hint: "Check command arguments, local contract/config validation and persisted events. Raw error details omitted.",
  });
  process.exitCode = 1;
} finally {
  store?.close();
  await provider?.close();
}
