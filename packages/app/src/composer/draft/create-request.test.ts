import { expect, it } from "vitest";
import type {
  CreateAgentRequestOptions,
  DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import { bindHarnessContextAgentId, harnessContextAgentId } from "../context/selection";
import { bindCreationAgentIdentity, requestDraftAgent } from "./create-request";

function harnessAttachment(agentId: string, entryId = "skill:review"): AgentAttachment {
  const name = entryId.slice("skill:".length);
  return {
    type: "text",
    mimeType: "text/plain",
    title: name,
    text: `Explicitly use the ${name} skill.`,
    harnessContext: {
      agentId,
      provider: "claude",
      entry: {
        id: entryId,
        kind: "skill",
        name,
        description: name,
        invocation: `/${name}`,
      },
    },
  };
}

function creationRequest(
  agentId: string,
  initialPrompt = "Start the task.",
): Omit<CreateAgentRequestOptions, "idempotencyKey"> {
  return {
    config: { provider: "claude", cwd: "/repo" },
    workspaceId: "workspace-1",
    initialPrompt,
    clientMessageId: "draft-1:initial-message",
    attachments: [harnessAttachment(agentId), harnessAttachment(agentId, "skill:test")],
  };
}

function capturedAt(
  requests: CreateAgentRequestOptions[],
  index: number,
): CreateAgentRequestOptions {
  const request = requests[index];
  if (!request) throw new Error(`No create request was captured at index ${index}`);
  return request;
}

function createCapturingClient(
  requests: CreateAgentRequestOptions[],
): Pick<DaemonClient, "createAgent"> {
  return {
    createAgent: async (request) => {
      requests.push(request);
      throw new Error("captured create request");
    },
  };
}

it("sends a stable bound identity for retries and a new identity for an edited draft", async () => {
  const draftId = "draft-1";
  const original = creationRequest("stored-context-id-1");
  const retry = creationRequest("stored-context-id-2");
  const edited = creationRequest("stored-context-id-3", "Start the edited task.");
  const requests: CreateAgentRequestOptions[] = [];
  const client = createCapturingClient(requests);

  await expect(requestDraftAgent(client, { draftId, request: original })).rejects.toThrow(
    "captured create request",
  );
  await expect(requestDraftAgent(client, { draftId, request: retry })).rejects.toThrow(
    "captured create request",
  );
  await expect(requestDraftAgent(client, { draftId, request: edited })).rejects.toThrow(
    "captured create request",
  );

  const first = capturedAt(requests, 0);
  const retried = capturedAt(requests, 1);
  const editedRequest = capturedAt(requests, 2);
  expect(first.agentId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(retried.agentId).toBe(first.agentId);
  expect(retried.idempotencyKey).toBe(first.idempotencyKey);
  expect(harnessContextAgentId(first.attachments ?? [])).toBe(first.agentId);
  expect(harnessContextAgentId(retried.attachments ?? [])).toBe(retried.agentId);
  expect(editedRequest.agentId).not.toBe(first.agentId);
  expect(editedRequest.idempotencyKey).not.toBe(first.idempotencyKey);
  expect(harnessContextAgentId(editedRequest.attachments ?? [])).toBe(editedRequest.agentId);
  expect(harnessContextAgentId(original.attachments ?? [])).toBe("stored-context-id-1");
});

it("isolates the initial Workspace agent identity from the Workspace-tab retry", async () => {
  const draftId = "new-workspace-creation-1";
  const request = creationRequest("stored-context-id");
  const initialAgent = bindCreationAgentIdentity({
    draftId,
    namespace: "new-workspace-initial",
    request,
  });
  const initialAgentId = initialAgent.agentId;
  if (!initialAgentId) throw new Error("Harness context did not bind an initial agent ID");
  const firstAgentContext = bindHarnessContextAgentId(request.attachments ?? [], initialAgentId);
  const requests: CreateAgentRequestOptions[] = [];

  await expect(
    requestDraftAgent(createCapturingClient(requests), { draftId, request }),
  ).rejects.toThrow("captured create request");

  const workspaceTabRetry = capturedAt(requests, 0);
  expect(initialAgentId).not.toBe(workspaceTabRetry.agentId);
  expect(harnessContextAgentId(initialAgent.attachments ?? [])).toBe(initialAgentId);
  expect(harnessContextAgentId(firstAgentContext)).toBe(initialAgentId);
  expect(harnessContextAgentId(workspaceTabRetry.attachments ?? [])).toBe(
    workspaceTabRetry.agentId,
  );
  expect(harnessContextAgentId(request.attachments ?? [])).toBe("stored-context-id");
});

it("leaves a normal draft create request and its existing key unchanged", async () => {
  const request: Omit<CreateAgentRequestOptions, "idempotencyKey"> = {
    config: { provider: "codex", cwd: "/repo", model: "gpt-6" },
    workspaceId: "workspace-1",
    initialPrompt: "Start the original task.",
    clientMessageId: "draft-1:initial-message",
  };
  const requests: CreateAgentRequestOptions[] = [];

  await expect(
    requestDraftAgent(createCapturingClient(requests), { draftId: "draft-1", request }),
  ).rejects.toThrow("captured create request");

  expect(capturedAt(requests, 0)).toEqual({
    ...request,
    idempotencyKey: "draft-1:9cfx1hqrhz",
  });
});
