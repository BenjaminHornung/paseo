import type {
  CreateAgentRequestOptions,
  DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import {
  draftCreationAgentId,
  draftCreationKey,
  type CreationAgentIdNamespace,
} from "./creation-key";
import { bindHarnessContextAgentId, harnessContextAgentId } from "../context/selection";

type CreationAgentRequest = Pick<CreateAgentRequestOptions, "agentId" | "attachments">;

export function bindCreationAgentIdentity<TRequest extends CreationAgentRequest>(input: {
  draftId: string;
  namespace: CreationAgentIdNamespace;
  request: TRequest;
}): TRequest {
  if (!harnessContextAgentId(input.request.attachments ?? [])) return input.request;

  const agentId = draftCreationAgentId(input.draftId, input.request, input.namespace);
  return {
    ...input.request,
    agentId,
    ...(input.request.attachments
      ? { attachments: bindHarnessContextAgentId(input.request.attachments, agentId) }
      : {}),
  };
}

export async function requestDraftAgent(
  client: Pick<DaemonClient, "createAgent">,
  input: {
    draftId: string;
    request: Omit<CreateAgentRequestOptions, "idempotencyKey">;
  },
) {
  const request = bindCreationAgentIdentity({
    draftId: input.draftId,
    namespace: "workspace-draft",
    request: input.request,
  });
  return await client.createAgent({
    ...request,
    idempotencyKey: draftCreationKey(input.draftId, request),
  });
}
