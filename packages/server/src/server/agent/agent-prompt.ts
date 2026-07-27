import type { Logger } from "pino";

import type { AgentPromptInput, AgentRunOptions } from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { assertAgentCwdExists } from "./agent-cwd.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";

export type AgentUnarchiveController = Pick<AgentManager, "notifyAgentState" | "unarchiveSnapshot">;

export type AgentRunController = Pick<
  AgentManager,
  | "getAgent"
  | "tryRunOutOfBand"
  | "hasInFlightRun"
  | "replaceAgentRun"
  | "streamAgent"
  | "waitForAgentRunStart"
>;

export interface StartAgentRunOptions {
  replaceRunning?: boolean;
  runOptions?: AgentRunOptions;
}

export interface StartAgentRunResult {
  outOfBand: boolean;
  startAcknowledged: AgentRunStartAcknowledgement;
}

export interface AgentRunStartAcknowledgement {
  promise: Promise<void>;
  abort: (reason?: unknown) => void;
}

export async function startAgentRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<StartAgentRunResult> {
  const snapshot = agentManager.getAgent(agentId);
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
      turnId: snapshot?.activeForegroundTurnId ?? undefined,
      promptType: typeof prompt === "string" ? "string" : "structured",
      hasRunOptions: Boolean(options?.runOptions),
      replaceRunning: Boolean(options?.replaceRunning),
    },
    "agent.session.start_stream.request",
  );
  // Out-of-band commands (e.g. /goal pause) must run WITHOUT canceling an
  // in-flight turn — replaceAgentRun would interrupt the running turn. The
  // intercept lives at this layer so it covers every prompt entrypoint.
  if (agentManager.tryRunOutOfBand(agentId, prompt)) {
    return {
      outOfBand: true,
      startAcknowledged: createResolvedStartAcknowledgement(),
    };
  }
  const shouldReplace = Boolean(options?.replaceRunning && agentManager.hasInFlightRun(agentId));
  const runOptions = options?.runOptions;
  const iterator = shouldReplace
    ? await agentManager.replaceAgentRun(agentId, prompt, runOptions)
    : agentManager.streamAgent(agentId, prompt, runOptions);
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
      shouldReplace,
    },
    "agent.session.start_stream.iterator_returned",
  );
  const startAcknowledgedAbort = new AbortController();
  const startAcknowledged = {
    promise: agentManager.waitForAgentRunStart(agentId, { signal: startAcknowledgedAbort.signal }),
    abort: (reason?: unknown) => {
      if (!startAcknowledgedAbort.signal.aborted) {
        startAcknowledgedAbort.abort(reason ?? "aborted");
      }
    },
  } satisfies AgentRunStartAcknowledgement;
  void (async () => {
    try {
      for await (const _ of iterator) {
        // Events are broadcast via AgentManager subscribers.
      }
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
        },
        "agent.session.iterator.drained",
      );
    } catch (error) {
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
          err: error,
        },
        "agent.session.iterator.error",
      );
      logger.error({ err: error, agentId }, "Agent stream failed");
    }
  })();
  return { outOfBand: false, startAcknowledged };
}

/**
 * Clear the archived flag from a stored agent record.
 * Shared across Session (app/WS), MCP, and CLI so every surface that acts on
 * an archived agent unarchives it the same way.
 */
export async function unarchiveAgentState(
  _agentStorage: AgentStorage,
  agentManager: AgentUnarchiveController,
  agentId: string,
  updates?: { workspaceId?: string; labels?: Record<string, string | null> },
): Promise<boolean> {
  const unarchived = await agentManager.unarchiveSnapshot(agentId, updates);
  if (!unarchived) return false;
  agentManager.notifyAgentState(agentId);
  return true;
}

/**
 * Wrap a body in <paseo-system>…</paseo-system> so the receiving agent
 * recognizes the prompt as system-injected context — not a user turn.
 * Used by chat mentions, schedule fires, and notify-on-finish.
 */
export function formatSystemNotificationPrompt(reason: string): string {
  return `<paseo-system>\n${reason}\n</paseo-system>`;
}

const SYSTEM_ENVELOPE_PATTERN = /^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/;

export function isSystemInjectedEnvelope(text: string): boolean {
  return SYSTEM_ENVELOPE_PATTERN.test(text);
}

// Matches a <paseo-system> block at the START of a message that has further
// content after it (spawn-context injection: envelope + blank line + prompt).
// Non-greedy so the first closing tag ends the envelope.
const LEADING_SYSTEM_ENVELOPE_PATTERN = /^<paseo-system>\n[\s\S]*?\n<\/paseo-system>\n\n/;

/**
 * Resolve what a user_message should display in the timeline once daemon-injected
 * context is accounted for:
 * - `null` when the whole message is a system envelope (hide it entirely).
 * - the trailing body when an envelope only prefixes real content, so the
 *   visible first message is exactly what the parent/user asked for.
 * - the text unchanged otherwise.
 *
 * The provider still receives the full text; this only shapes the display echo.
 */
export function displayTextForUserMessage(text: string): string | null {
  if (isSystemInjectedEnvelope(text)) {
    return null;
  }
  const leadingEnvelope = LEADING_SYSTEM_ENVELOPE_PATTERN.exec(text);
  return leadingEnvelope ? text.slice(leadingEnvelope[0].length) : text;
}

export interface SendPromptToAgentParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  /** Prompt to dispatch to the provider (may include image blocks or wrapped text). */
  prompt: AgentPromptInput;
  messageId?: string;
  runOptions?: AgentRunOptions;
  /** Whether this send may interrupt an active foreground run. Defaults to true. */
  replaceRunning?: boolean;
  /** Optional mode to set on the agent before the run starts. */
  sessionMode?: string;
  /**
   * Default true. When false, archived agents are skipped instead of being
   * unarchived. Use false for system-injected prompts (chat mentions,
   * schedule fires, notify-on-finish).
   */
  unarchive?: boolean;
  logger: Logger;
}

export interface SendPromptToAgentResult {
  outOfBand: boolean;
  startAcknowledged: AgentRunStartAcknowledgement;
  skippedReason?: "archived";
}

export interface StartCreatedAgentInitialPromptParams {
  agentManager: AgentManager;
  agentId: string;
  snapshot?: ManagedAgent;
  prompt: AgentPromptInput | null;
  runOptions?: AgentRunOptions;
  logger: Logger;
}

const AGENT_RUN_START_TIMEOUT_MS = 15_000;

export class AgentRunStartTimeoutError extends Error {
  constructor() {
    super(`Agent run start timed out after ${AGENT_RUN_START_TIMEOUT_MS}ms`);
    this.name = "AgentRunStartTimeoutError";
  }
}

export async function waitForAgentRunStartWithTimeout(
  startAcknowledged: AgentRunStartAcknowledgement,
): Promise<void> {
  const startTimeout = setTimeout(
    () => startAcknowledged.abort("timeout"),
    AGENT_RUN_START_TIMEOUT_MS,
  );

  try {
    await startAcknowledged.promise;
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "AbortError" &&
      error.message.toLowerCase().includes("timeout")
    ) {
      throw new AgentRunStartTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(startTimeout);
  }
}

interface BackgroundAgentRunStartOwnershipParams {
  startAcknowledged: AgentRunStartAcknowledgement;
  logger: Logger;
  context: Record<string, unknown>;
  timeoutMessage: string;
  failureMessage: string;
}

function logAgentRunStartOwnershipFailure(
  logger: Logger,
  level: "warn" | "error",
  context: Record<string, unknown>,
  message: string,
): void {
  try {
    logger[level](context, message);
  } catch {
    // Detached ownership must never rethrow from logging.
  }
}

export function ownBackgroundAgentRunStart(params: BackgroundAgentRunStartOwnershipParams): void {
  void (async () => {
    try {
      await waitForAgentRunStartWithTimeout(params.startAcknowledged);
    } catch (error) {
      if (error instanceof AgentRunStartTimeoutError) {
        logAgentRunStartOwnershipFailure(
          params.logger,
          "warn",
          { ...params.context, err: error },
          params.timeoutMessage,
        );
        return;
      }
      logAgentRunStartOwnershipFailure(
        params.logger,
        "warn",
        { ...params.context, err: error },
        params.failureMessage,
      );
    }
  })();
}

/**
 * Full send-prompt orchestration: (optional unarchive) → load → (optional
 * mode change) → start run.
 *
 * Every surface that sends a prompt to an agent (Session/WS, MCP, CLI-through-MCP,
 * chat mentions, notify-on-finish) MUST go through this so behavior can never
 * drift between them.
 *
 * When `unarchive` is false and the agent is archived, the call is a no-op
 * with `skippedReason: "archived"` — the agent is not run.
 */
export async function sendPromptToAgent(
  params: SendPromptToAgentParams,
): Promise<SendPromptToAgentResult> {
  const unarchive = params.unarchive ?? true;

  const record = await params.agentStorage.get(params.agentId);
  if (record?.archivedAt) {
    if (!unarchive) {
      return {
        outOfBand: false,
        startAcknowledged: createResolvedStartAcknowledgement(),
        skippedReason: "archived",
      };
    }
  }

  const liveBeforeLoad = params.agentManager.getAgent(params.agentId);
  const cwd = liveBeforeLoad?.cwd ?? record?.cwd;
  if (cwd) {
    await assertAgentCwdExists(params.agentId, cwd);
  } else if (!record && !liveBeforeLoad) {
    throw new Error(`Agent not found: ${params.agentId}`);
  }

  if (record?.archivedAt && unarchive) {
    await unarchiveAgentState(params.agentStorage, params.agentManager, params.agentId);
  }

  await ensureAgentLoaded(params.agentId, {
    agentManager: params.agentManager,
    agentStorage: params.agentStorage,
    logger: params.logger,
    allowMissingCwd: false,
  });

  if (params.sessionMode) {
    await params.agentManager.setAgentMode(params.agentId, params.sessionMode);
  }

  const runOptions = params.messageId
    ? { ...params.runOptions, messageId: params.messageId }
    : params.runOptions;

  return await startAgentRun(params.agentManager, params.agentId, params.prompt, params.logger, {
    replaceRunning: params.replaceRunning ?? true,
    runOptions,
  });
}

export async function startCreatedAgentInitialPrompt(
  params: StartCreatedAgentInitialPromptParams,
): Promise<ManagedAgent> {
  const currentSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!currentSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }

  if (params.prompt === null) {
    return currentSnapshot;
  }

  const dispatchResult = await startAgentRun(
    params.agentManager,
    params.agentId,
    params.prompt,
    params.logger,
    {
      runOptions: params.runOptions,
    },
  );

  if (!dispatchResult.outOfBand) {
    await waitForAgentRunStartWithTimeout(dispatchResult.startAcknowledged);
  }

  const refreshedSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!refreshedSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }
  return refreshedSnapshot;
}

function createResolvedStartAcknowledgement(): AgentRunStartAcknowledgement {
  return {
    promise: Promise.resolve(),
    abort: () => {},
  };
}

export interface SetupFinishNotificationParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  childAgentId: string;
  callerAgentId: string;
  requireParentOwnership?: boolean;
  logger: Logger;
}

interface FinishNotificationBodyInput {
  childAgentId: string;
  title: string;
  reason: "finished" | "errored" | "needs permission";
  lastAssistantMessage: string | null;
}

function formatFinishNotificationBody(params: FinishNotificationBodyInput): string {
  const statusLine = `Agent ${params.childAgentId} (${params.title}) ${params.reason}.`;
  const lastAssistantMessage = params.lastAssistantMessage?.trim();
  if (!lastAssistantMessage) {
    return statusLine;
  }
  return `${statusLine}\n\n<agent-response>\n${lastAssistantMessage}\n</agent-response>`;
}

export function setupFinishNotification(params: SetupFinishNotificationParams): void {
  const {
    agentManager,
    agentStorage,
    childAgentId,
    callerAgentId,
    requireParentOwnership = false,
    logger,
  } = params;
  let hasSeenRunning = false;
  let fired = false;
  let unsubscribe: (() => void) | null = null;

  async function notify(reason: "finished" | "errored" | "needs permission"): Promise<void> {
    if (fired) {
      return;
    }
    fired = true;
    unsubscribe?.();

    const callerRecord = await agentStorage.get(callerAgentId);
    if (callerRecord?.archivedAt) {
      return;
    }

    const record = await agentStorage.get(childAgentId);
    if (requireParentOwnership && getParentAgentIdFromLabels(record?.labels) !== callerAgentId) {
      return;
    }
    const title = record?.title ?? childAgentId;
    const lastAssistantMessage = await agentManager.getLastAssistantMessage(childAgentId);
    const body = formatFinishNotificationBody({
      childAgentId,
      title,
      reason,
      lastAssistantMessage,
    });

    const dispatchResult = await sendPromptToAgent({
      agentManager,
      agentStorage,
      agentId: callerAgentId,
      prompt: formatSystemNotificationPrompt(body),
      unarchive: false,
      logger,
    });
    if (!dispatchResult.outOfBand && !dispatchResult.skippedReason) {
      ownBackgroundAgentRunStart({
        startAcknowledged: dispatchResult.startAcknowledged,
        logger,
        context: { childAgentId, callerAgentId, reason },
        timeoutMessage: "Caller agent notification run did not acknowledge start before timeout",
        failureMessage: "Caller agent notification run failed before start acknowledgement",
      });
    }
  }

  function notifySafely(reason: "finished" | "errored" | "needs permission"): void {
    void notify(reason).catch((error) => {
      logger.error(
        { err: error, childAgentId, callerAgentId, reason },
        "Failed to notify caller agent",
      );
    });
  }

  unsubscribe = agentManager.subscribe(
    (event) => {
      if (fired) {
        return;
      }

      if (event.type === "agent_state") {
        if (event.agent.lifecycle === "running") {
          hasSeenRunning = true;
          return;
        }
        if (event.agent.lifecycle === "error") {
          notifySafely("errored");
          return;
        }
        if (event.agent.lifecycle === "idle" && hasSeenRunning) {
          notifySafely("finished");
          return;
        }
        if (event.agent.lifecycle === "closed") {
          fired = true;
          unsubscribe?.();
          return;
        }
        return;
      }

      if (event.event.type === "permission_requested") {
        notifySafely("needs permission");
      }
    },
    { agentId: childAgentId, replayState: false },
  );

  // Check if the child is already running (catches the case where
  // the lifecycle flipped before our subscribe call was processed).
  // Do NOT treat an immediate "idle" as "finished" — the agent may
  // not have started yet (streamAgent sets a pending run before
  // transitioning to "running").
  const childSnapshot = agentManager.getAgent(childAgentId);
  if (!childSnapshot || childSnapshot.lifecycle === "closed") {
    unsubscribe();
    return;
  }
  if (childSnapshot.lifecycle === "running") {
    hasSeenRunning = true;
  } else if (childSnapshot.lifecycle === "error") {
    notifySafely("errored");
  }
}
