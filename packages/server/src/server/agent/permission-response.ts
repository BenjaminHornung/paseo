import type { Logger } from "pino";

import type { AgentPermissionResponse, AgentPermissionResult } from "./agent-sdk-types.js";
import {
  ownBackgroundAgentRunStart,
  startAgentRun,
  type AgentRunController,
} from "./agent-prompt.js";

export interface PermissionResponseAgentManager extends AgentRunController {
  respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void>;
}

export interface RespondToAgentPermissionParams {
  agentManager: PermissionResponseAgentManager;
  agentId: string;
  requestId: string;
  response: AgentPermissionResponse;
  logger: Logger;
}

export async function respondToAgentPermission(
  params: RespondToAgentPermissionParams,
): Promise<void> {
  const { agentManager, agentId, requestId, response, logger } = params;
  logger.debug(
    { agentId, requestId },
    `Handling permission response for agent ${agentId}, request ${requestId}`,
  );

  const result = await agentManager.respondToPermission(agentId, requestId, response);
  logger.debug({ agentId }, `Permission response forwarded to agent ${agentId}`);

  if (result?.followUpPrompt) {
    logger.debug({ agentId }, "Permission response requires follow-up turn, starting agent stream");
    const dispatchResult = await startAgentRun(
      agentManager,
      agentId,
      result.followUpPrompt,
      logger,
      {
        replaceRunning: true,
      },
    );
    if (!dispatchResult.outOfBand) {
      ownBackgroundAgentRunStart({
        startAcknowledged: dispatchResult.startAcknowledged,
        logger,
        context: { agentId, requestId },
        timeoutMessage: "Permission follow-up run did not acknowledge start before timeout",
        failureMessage: "Permission follow-up run failed before start acknowledgement",
      });
    }
  }
}
