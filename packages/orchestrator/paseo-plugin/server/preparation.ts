import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import type { PaseoApi, PaseoAgent, PaseoAgentHandle } from "@getpaseo/client";
import { AutomationRuntime, orchestrationInstructions } from "./automation";
import {
  existingMainSelection,
  preparationInput,
  type PreparationInput,
} from "../shared/preparation";

function existingMainIdentity(agent: PaseoAgent, request: PreparationInput, directory: string) {
  const relative = path.relative(path.resolve(directory), path.resolve(agent.cwd));
  if (
    agent.id !== request.agentId ||
    agent.provider.split("/")[0] !== "codex" ||
    agent.labels.controller === "variant-a" ||
    agent.archivedAt ||
    !request.workspaceId ||
    agent.workspaceId !== request.workspaceId ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  )
    throw Error("AUTOMATION_MAIN_REQUIRED");
  if (agent.status !== "idle" || agent.activeTurn || agent.pendingPermissions.length)
    throw Error("AUTOMATION_MAIN_MUST_BE_IDLE");
  const selection = existingMainSelection(agent);
  if (
    selection.model !== request.model ||
    selection.reasoning !== request.reasoning ||
    (selection.modeId ?? "") !== (request.modeId ?? "")
  )
    throw Error("AUTOMATION_MAIN_SELECTION_CHANGED");
  if (!agent.runtimeInfo?.sessionId) throw Error("AUTOMATION_NATIVE_PROCESS_PROOF_UNAVAILABLE");
  return JSON.stringify({
    agentId: agent.id,
    sessionId: agent.runtimeInfo.sessionId,
    workspaceId: agent.workspaceId,
    cwd: agent.cwd,
    provider: agent.provider,
  });
}

async function prepareExistingMain(request: PreparationInput, paseo: PaseoApi, directory: string) {
  const handle = paseo.agents.ref(request.agentId!);
  const snapshot = (await handle.refresh())?.agent;
  if (!snapshot) throw Error("AUTOMATION_MAIN_REQUIRED");
  const identity = existingMainIdentity(snapshot, request, directory);
  const requestIdentity = createHash("sha256")
    .update(JSON.stringify(request))
    .update(identity)
    .digest("hex");
  const assertPreparation = (agent: PaseoAgent) => {
    if (
      agent.labels.orchestratorPreparation &&
      (agent.labels.orchestratorPreparation !== request.requestId ||
        agent.labels.orchestratorPreparationIdentity !== requestIdentity)
    )
      throw Error("AUTOMATION_PREPARATION_CHANGED");
  };
  assertPreparation(snapshot);
  if (snapshot.capabilities.supportsBackgroundWorkRefresh !== true)
    throw Error("AUTOMATION_COMPATIBLE_DAEMON_REQUIRED");
  try {
    const observation = await handle.backgroundWork.refresh();
    if (
      observation.agentId !== snapshot.id ||
      observation.providerSessionId !== snapshot.runtimeInfo!.sessionId ||
      observation.coverage !== "codex_background_terminals" ||
      !observation.queriedProviderSessionIds.includes(observation.providerSessionId) ||
      observation.items.length ||
      observation.providerSubagents.some((agent) => agent.status === "running")
    )
      throw Error("Native session is not settled");
  } catch {
    throw Error("AUTOMATION_NATIVE_PROCESS_PROOF_UNAVAILABLE");
  }
  const current = (await handle.refresh())?.agent;
  if (!current || existingMainIdentity(current, request, directory) !== identity)
    throw Error("AUTOMATION_PREPARATION_UNCERTAIN");
  assertPreparation(current);
  if (!current.labels.orchestratorPreparation) {
    await handle.setLabels({
      orchestratorPreparation: request.requestId,
      orchestratorPreparationIdentity: requestIdentity,
    });
  }
  const prepared = (await handle.refresh())?.agent;
  if (!prepared || existingMainIdentity(prepared, request, directory) !== identity)
    throw Error("AUTOMATION_PREPARATION_UNCERTAIN");
  assertPreparation(prepared);
  if (prepared.labels.orchestratorPreparation !== request.requestId)
    throw Error("AUTOMATION_PREPARATION_UNCERTAIN");
  return { snapshot: prepared, retry: !!snapshot.labels.orchestratorPreparation };
}

async function requirePreparationModel(
  request: PreparationInput,
  paseo: PaseoApi,
  directory: string,
) {
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
}

async function preflightCreatedMain(handle: PaseoAgentHandle, snapshot: PaseoAgent) {
  if (snapshot.capabilities.supportsBackgroundWorkRefresh !== true)
    throw Error("AUTOMATION_COMPATIBLE_DAEMON_REQUIRED");
  try {
    // Capability preflight only: a never-prompted session is not completion proof.
    const observation = await handle.backgroundWork.refresh();
    if (
      observation.agentId !== snapshot.id ||
      !observation.queriedProviderSessionIds.includes(observation.providerSessionId)
    )
      throw Error("Native observation identity unavailable");
  } catch {
    throw Error("AUTOMATION_NATIVE_PROCESS_PROOF_UNAVAILABLE");
  }
}

function newMainOptions(request: PreparationInput, ownWorkspace: boolean) {
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
      ...(ownWorkspace ? { orchestratorOwnWorkspace: "true" } : {}),
    },
  };
  return options;
}

async function preparationWorkspace(request: PreparationInput, paseo: PaseoApi) {
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
  return { workspace, directory };
}

export async function prepareOrchestratorSession(
  input: PreparationInput,
  paseo: PaseoApi,
  automation: Pick<AutomationRuntime, "prepare" | "prepareExisting" | "status">,
) {
  const request = preparationInput.parse(input);
  const { workspace, directory } = await preparationWorkspace(request, paseo);
  if (request.agentId) {
    // Adoption preserves the session; requested activation uses the normal
    // existing-main bootstrap, never the new-main system-prompt shortcut.
    const { snapshot, retry } = await prepareExistingMain(request, paseo, directory);
    const status = request.autoRouting
      ? await automation.prepareExisting(snapshot.id, request.requestId, paseo, retry)
      : await automation.status(snapshot.cwd, snapshot.id);
    return {
      agentId: snapshot.id,
      workspaceId: snapshot.workspaceId!,
      automation: status.automation,
    };
  }
  await requirePreparationModel(request, paseo, directory);
  const options = newMainOptions(request, !workspace);
  const agentId = options.agentId;
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
  if (request.autoRouting) await preflightCreatedMain(handle, snapshot);
  const status = request.autoRouting
    ? await automation.prepare(agentId, request.requestId, paseo)
    : await automation.status(snapshot.cwd, agentId);
  return { agentId, workspaceId: snapshot.workspaceId, automation: status.automation };
}
