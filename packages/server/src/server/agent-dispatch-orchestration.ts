import type { Logger } from "pino";

import type { AgentPromptInput } from "./agent/agent-sdk-types.js";
import { ensureAgentLoaded } from "./agent/agent-loading.js";
import type { AgentManager, ClientMessageAdmission } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import {
  AgentRunStartTimeoutError,
  sendPromptToAgent,
  waitForAgentRunStartWithTimeout,
} from "./agent/agent-prompt.js";

export interface ReplayAdmissionResolution {
  kind:
    | "admit"
    | "duplicate"
    | "in_flight"
    | "conflict"
    | "pending"
    | "capacity"
    | "legacy_unverifiable";
  accepted: boolean;
  error: string | null;
  admission: ClientMessageAdmission | null;
}

export async function resolveReplayAdmissionForPrompt(params: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  prompt: AgentPromptInput;
  messageId?: string;
  logger: Logger;
}): Promise<ReplayAdmissionResolution> {
  const { agentManager, agentStorage, agentId, prompt, messageId, logger } = params;
  let replayAdmission = await agentManager.admitRecordedUserMessage(agentId, prompt, {
    messageId,
  });
  if (replayAdmission.disposition === "legacy_load_required") {
    await ensureAgentLoaded(agentId, {
      agentManager,
      agentStorage,
      logger,
    });
    replayAdmission = await agentManager.admitRecordedUserMessage(agentId, prompt, {
      messageId,
    });
  }
  switch (replayAdmission.disposition) {
    case "new":
      return { kind: "admit", accepted: false, error: null, admission: replayAdmission };
    case "in_flight": {
      const outcome = await replayAdmission.completion;
      return {
        kind: "in_flight",
        accepted: outcome?.accepted ?? false,
        error: outcome?.error ?? "Concurrent client message delivery did not complete",
        admission: null,
      };
    }
    case "duplicate":
      return { kind: "duplicate", accepted: true, error: null, admission: null };
    case "conflict":
      return {
        kind: "conflict",
        accepted: false,
        error: `Client messageId '${replayAdmission.messageId}' was reused with a different payload`,
        admission: null,
      };
    case "pending":
    case "capacity":
    case "legacy_load_required":
    case "legacy_unverifiable": {
      let kind: ReplayAdmissionResolution["kind"] = "pending";
      if (replayAdmission.disposition === "capacity") {
        kind = "capacity";
      } else if (replayAdmission.disposition === "legacy_unverifiable") {
        kind = "legacy_unverifiable";
      }
      return {
        kind,
        accepted: false,
        error: replayAdmission.error ?? "Client message replay admission is unavailable",
        admission: null,
      };
    }
  }
}

export type PromptDispatchDisposition =
  | { kind: "started"; outOfBand: boolean }
  | { kind: "duplicate" }
  | { kind: "definitive_failure"; error: string }
  | { kind: "unknown"; error: string };

export async function dispatchPromptWithReplayAdmission(params: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  prompt: AgentPromptInput;
  replayAdmission: ClientMessageAdmission;
  logger: Logger;
  replaceRunning?: boolean;
  unarchive?: boolean;
  onDispatchFailure?: (error: unknown) => void;
}): Promise<PromptDispatchDisposition> {
  const {
    agentManager,
    agentStorage,
    agentId,
    prompt,
    replayAdmission,
    logger,
    replaceRunning,
    unarchive,
    onDispatchFailure,
  } = params;
  const normalizedMessageId = replayAdmission.messageId;
  let dispatchResult: Awaited<ReturnType<typeof sendPromptToAgent>>;
  try {
    dispatchResult = await sendPromptToAgent({
      agentManager,
      agentStorage,
      agentId,
      prompt,
      messageId: normalizedMessageId,
      replaceRunning,
      unarchive,
      logger,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await agentManager.releaseRecordedUserMessageAdmissionForAgent(
        agentId,
        replayAdmission,
        message,
      );
    } catch (releaseError) {
      logger.warn(
        { err: releaseError, agentId, messageId: normalizedMessageId },
        "Failed to release client message admission after dispatch failure",
      );
    }
    onDispatchFailure?.(error);
    return { kind: "definitive_failure", error: message };
  }

  if (dispatchResult.skippedReason === "archived") {
    const error = `Queued message target agent is archived: ${agentId}`;
    try {
      await agentManager.releaseRecordedUserMessageAdmissionForAgent(
        agentId,
        replayAdmission,
        error,
      );
    } catch (releaseError) {
      logger.warn(
        { err: releaseError, agentId, messageId: normalizedMessageId },
        "Failed to release client message admission after archived skip",
      );
    }
    return { kind: "definitive_failure", error };
  }

  if (dispatchResult.outOfBand) {
    try {
      await agentManager.commitRecordedUserMessageAdmissionForAgent(agentId, replayAdmission);
    } catch (error) {
      const message =
        "Provider dispatch succeeded but durable replay commit failed; delivery outcome is unknown";
      logger.error(
        { err: error, agentId, messageId: normalizedMessageId },
        "Failed to commit client message admission after out-of-band dispatch",
      );
      return { kind: "unknown", error: message };
    }
    return { kind: "started", outOfBand: true };
  }

  try {
    await waitForAgentRunStartWithTimeout(dispatchResult.startAcknowledged);
  } catch (error) {
    if (error instanceof AgentRunStartTimeoutError) {
      const message = "Provider start timed out; delivery outcome is unknown";
      agentManager.settleRecordedUserMessageAdmissionPendingForAgent(
        agentId,
        replayAdmission,
        message,
      );
      return { kind: "unknown", error: message };
    }
    try {
      await agentManager.releaseRecordedUserMessageAdmissionForAgent(
        agentId,
        replayAdmission,
        error instanceof Error ? error.message : String(error),
      );
    } catch (releaseError) {
      logger.warn(
        { err: releaseError, agentId, messageId: normalizedMessageId },
        "Failed to release client message admission after provider start rejection",
      );
    }
    return {
      kind: "definitive_failure",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    await agentManager.commitRecordedUserMessageAdmissionForAgent(agentId, replayAdmission);
  } catch (error) {
    const message =
      "Provider dispatch succeeded but durable replay commit failed; delivery outcome is unknown";
    logger.error(
      { err: error, agentId, messageId: normalizedMessageId },
      "Failed to commit client message admission after confirmed provider start",
    );
    return { kind: "unknown", error: message };
  }

  return { kind: "started", outOfBand: false };
}
