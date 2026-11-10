import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { PaseoApi } from "@getpaseo/client";
import { AutomationRuntime, orchestrationInstructions } from "./automation";
import { preparationInput, type PreparationInput } from "../shared/preparation";

export async function prepareOrchestratorSession(
  input: PreparationInput,
  paseo: PaseoApi,
  automation: AutomationRuntime,
) {
  const request = preparationInput.parse(input);
  const { projects } = await paseo.projects.list();
  const project = projects.find((value) => value.projectId === request.projectId);
  if (!project || !/^C:[\\/]IFI_SourceCode(?:[\\/]|$)/i.test(project.projectRootPath))
    throw Error("AUTOMATION_DIRECTORY_BLOCKED");
  const workspace = request.workspaceId ? paseo.workspaces.ref(request.workspaceId) : undefined;
  if (workspace) {
    await workspace.refresh();
    if (workspace.projectId !== project.projectId || !workspace.directory)
      throw Error("AUTOMATION_WORKSPACE_MISMATCH");
  }
  const directory = workspace?.directory ?? project.projectRootPath;
  if (!/^C:[\\/]IFI_SourceCode(?:[\\/]|$)/i.test(directory))
    throw Error("AUTOMATION_DIRECTORY_BLOCKED");
  let catalog = await paseo.providers.snapshot({ cwd: directory });
  const deadline = Date.now() + 30000;
  while (
    catalog.entries.find((value) => value.provider === "codex")?.status === "loading" &&
    Date.now() < deadline
  ) {
    await delay(250);
    catalog = await paseo.providers.snapshot({ cwd: directory });
  }
  const provider = catalog.entries.find(
    (value) => value.provider === "codex" && value.status === "ready",
  );
  const model = provider?.models?.find(
    (value) => value.id === request.model && value.isSelectable !== false,
  );
  if (
    !model ||
    (request.reasoning &&
      !model.thinkingOptions?.some((value) => value.id === request.reasoning)) ||
    (request.modeId && !provider?.modes?.some((value) => value.id === request.modeId))
  )
    throw Error("AUTOMATION_MODEL_UNAVAILABLE");
  // The same preparation request always addresses the same empty session, even
  // after a lost RPC response. Including the complete selection prevents a key
  // reused with different parameters from rebinding an unrelated session.
  const identity = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const agentId = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-5${identity.slice(13, 16)}-8${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
  const options = {
    agentId,
    idempotencyKey: `orchestrator-prepare-${identity}`,
    config: {
      provider: `codex/${request.model}`,
      thinkingOptionId: request.reasoning || undefined,
      modeId: request.modeId,
      systemPrompt: request.autoRouting ? orchestrationInstructions(agentId) : undefined,
      ...(request.autoRouting
        ? {
            options: {
              sandbox_mode: "read-only",
              approval_policy: "on-request",
              web_search: "disabled",
            },
          }
        : {}),
    },
    labels: {
      orchestratorPreparation: request.requestId,
      orchestratorScope: request.dataScope,
      ...(!workspace ? { orchestratorOwnWorkspace: "true" } : {}),
    },
  };
  const handle = workspace
    ? await workspace.agents.create(options)
    : await paseo.agents.create({ ...options, cwd: directory });
  const snapshot = (await handle.refresh())?.agent;
  if (
    !snapshot?.workspaceId ||
    snapshot.id !== agentId ||
    snapshot.labels?.orchestratorPreparation !== request.requestId ||
    (request.workspaceId && snapshot.workspaceId !== request.workspaceId)
  )
    throw Error("AUTOMATION_PREPARATION_UNCERTAIN");
  if (request.autoRouting) {
    if (snapshot.capabilities.supportsBackgroundWorkRefresh !== true)
      throw Error("AUTOMATION_COMPATIBLE_DAEMON_REQUIRED");
    try {
      // Capability preflight only: a never-prompted native session is not completion proof.
      const observation = await handle.backgroundWork.refresh();
      if (
        observation.agentId !== agentId ||
        !observation.queriedProviderSessionIds.includes(observation.providerSessionId)
      )
        throw Error("Native observation identity unavailable");
    } catch {
      throw Error("AUTOMATION_NATIVE_PROCESS_PROOF_UNAVAILABLE");
    }
  }
  const status = request.autoRouting
    ? await automation.prepare(agentId, request.requestId, paseo)
    : await automation.status(snapshot.cwd, agentId);
  return { agentId, workspaceId: snapshot.workspaceId, automation: status.automation };
}
