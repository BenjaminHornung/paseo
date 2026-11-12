import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createPaseoClient } from "@getpaseo/client";
import { controller } from "./server/controller";
import {
  loadSettings,
  saveSettings,
  saveCredential,
  pauseDispatch,
  testDecisions,
  settingsViewSchema,
} from "./shared/settings";
import { AutomationRuntime, orchestrationTools } from "./server/automation";
import { loadStatus, autoRouting, submitInput, abandonInput, prepareInput } from "./shared/status";
import {
  decisionsHistory,
  decisionsHistorySchema,
  approveIntake,
} from "./shared/decisions-history";
import { prepareSession } from "./shared/preparation";
import { prepareOrchestratorSession } from "./server/preparation";

export default function contribute(server: PluginServerContext) {
  const automation = new AutomationRuntime();
  const tools = orchestrationTools(automation);
  server.before("agent.session_open", async ({ request }) => {
    if (
      request.provider.split("/")[0] === "codex" &&
      request.labels.controller !== "variant-a" &&
      /^C:[\\/]IFI_SourceCode(?:[\\/]|$)/i.test(request.cwd)
    ) {
      request.tools = [...request.tools, ...tools];
      return request;
    }
    if (request.labels.controller !== "variant-a" || request.provider.split("/")[0] !== "pi")
      return;
    const launch = (await controller({
      operation: "launch-budget",
      requestKey: request.labels.requestKey,
      agentId: request.agentId,
      cwd: request.cwd,
      controllerState: request.labels.controllerState,
      processMonitor: request.labels.processMonitor === "pi-job-v1",
    })) as {
      budgetFile?: string;
      processMonitorFile?: string;
      worktree?: string;
      allowedPaths?: string[];
    };
    const ownedEnvironment = Object.fromEntries(
      [
        "PASEO_ORCHESTRATOR_ROOT",
        "PASEO_ORCHESTRATOR_DATA_ROOT",
        "PASEO_ORCHESTRATOR_NODE",
        "PASEO_ORCHESTRATOR_POWERSHELL",
        "PASEO_ORCHESTRATOR_PI_BASE_LAUNCHER",
        "PASEO_ORCHESTRATOR_PI_PACKAGE",
        "PASEO_ORCHESTRATOR_LUNA_GUARD",
      ].flatMap((key) => (typeof process.env[key] === "string" ? [[key, process.env[key]!]] : [])),
    );
    request.env = {
      ...request.env,
      ...ownedEnvironment,
      ...(launch.budgetFile ? { PASEO_ORCHESTRATOR_BUDGET_FILE: launch.budgetFile } : {}),
      ...(launch.processMonitorFile
        ? {
            PASEO_ORCHESTRATOR_PROCESS_MONITOR: launch.processMonitorFile,
            PASEO_ORCHESTRATOR_WORKTREE: launch.worktree!,
            PASEO_ORCHESTRATOR_ALLOWED_PATHS: JSON.stringify(launch.allowedPaths),
          }
        : {}),
    };
    return request;
  });
  server.handle(loadStatus, async (input, { paseo }) => {
    automation.use(paseo);
    return automation.status(input.directory, input.agentId);
  });
  server.handle(decisionsHistory, async (input) =>
    decisionsHistorySchema.parse(await controller({ operation: "decision-history", ...input })),
  );
  server.handle(approveIntake, async (input) =>
    approveIntake.output.parse(await controller({ operation: "intake-approve", ...input })),
  );
  server.handle(autoRouting, async (input, { paseo }) =>
    automation.toggle(input.agentId, input.enabled, paseo),
  );
  server.handle(prepareInput, async (input, { paseo }) => {
    const { mains } = (await controller({ operation: "auto-list" })) as {
      mains: { agentId: string; state: string }[];
    };
    const main = mains.find((main) => main.agentId === input.agentId);
    if (main?.state !== "ready") return { enabled: false as const };
    const agent = (await paseo.agents.ref(input.agentId).refresh())?.agent;
    if (!agent?.labels?.orchestratorPreparation) throw Error("AUTOMATION_PREPARED_MAIN_REQUIRED");
    const receipt = (await controller({
      operation: "auto-input",
      ...input,
      directory: agent.cwd,
    })) as { version: number };
    if (receipt.version !== 3) throw Error("V3_MAIN_RESTART_REQUIRED");
    return { recorded: true as const };
  });
  server.handle(submitInput, async (input, { paseo }) => {
    const handle = paseo.agents.ref(input.agentId),
      agent = (await handle.refresh())?.agent;
    if (!agent || agent.status !== "idle" || agent.activeTurn || agent.pendingPermissions.length)
      throw Error("AUTOMATION_MAIN_MUST_BE_IDLE");
    const receipt = (await controller({
      operation: "auto-input",
      ...input,
      directory: agent.cwd,
    })) as { version: number; recorded?: boolean };
    if (receipt.version !== 3) throw Error("V3_MAIN_RESTART_REQUIRED");
    if (!receipt.recorded) {
      const timeline = await handle.timeline.refetch({ direction: "tail", limit: 200 });
      const existing = timeline.entries.some(
        (entry) =>
          entry.item.type === "user_message" &&
          (entry.item.clientMessageId ?? entry.item.messageId) === input.messageId &&
          entry.item.text === input.text,
      );
      if (!timeline.error && !timeline.gap && existing) return { sent: true };
      throw Error("INPUT_SEND_OUTCOME_UNKNOWN");
    }
    await handle.send(input.text, { messageId: input.messageId, activeTurnBehavior: "steer" });
    return { sent: true };
  });
  server.handle(abandonInput, async (input, { paseo }) => {
    const agent = (await paseo.agents.ref(input.agentId).refresh())?.agent;
    if (!agent || agent.status !== "idle" || agent.activeTurn || agent.pendingPermissions.length)
      throw Error("AUTOMATION_MAIN_MUST_BE_IDLE");
    await controller({ operation: "auto-abandon-input", ...input, directory: agent.cwd });
    return { abandoned: true };
  });
  server.handle(prepareSession, async (input, { paseo }) => {
    if (!input.agentId) return prepareOrchestratorSession(input, paseo, automation);
    const { config } = (await controller({ operation: "get" })) as {
      config: { daemonUrl: string };
    };
    // Use this plugin's bundled SDK for the additive label action even on an
    // installed host whose injected API predates it. The wire operation already
    // exists on that daemon. Keep long-lived automation on the plugin-owned API.
    const client = createPaseoClient({ url: config.daemonUrl, reconnect: { enabled: false } });
    try {
      await client.connect();
      return await prepareOrchestratorSession(input, client, {
        prepare: (agentId, requestId) => automation.prepare(agentId, requestId, paseo),
        prepareExisting: (agentId, requestId, _client, retry) =>
          automation.prepareExisting(agentId, requestId, paseo, retry),
        status: (directory, agentId) => automation.status(directory, agentId),
      });
    } finally {
      await client.close();
    }
  });
  server.on("agent.turn_ended", async ({ agent, turnId }, { paseo }) => {
    await automation.afterTurn(agent, turnId, paseo);
  });
  server.handle(loadSettings, async () =>
    settingsViewSchema.parse(await controller({ operation: "get" })),
  );
  server.handle(saveSettings, async (input) =>
    settingsViewSchema.parse(await controller({ operation: "save", ...input })),
  );
  server.handle(saveCredential, async (input) =>
    settingsViewSchema.parse(await controller({ operation: "credential", ...input })),
  );
  server.handle(pauseDispatch, async (input) =>
    settingsViewSchema.parse(await controller({ operation: "pause", ...input })),
  );
  server.handle(testDecisions, async (input) => {
    const result = await controller({ operation: "test-decisions", ...input });
    return testDecisions.output.parse(result);
  });
  return () => automation.dispose();
}
