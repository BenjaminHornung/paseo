import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { OmpHistoryMapper } from "./message-history.js";
import type { OmpAgentMessage, OmpAgentSessionEvent } from "./rpc-types.js";
import { OMP_HISTORY_MAPPER_HOOKS } from "./history-hooks.js";
import { formatOmpSubagentTitle } from "./subagent-title.js";
import type {
  OmpSubagentEventPayload,
  OmpSubagentLifecyclePayload,
  OmpSubagentProgressPayload,
  OmpSubagentSnapshot,
} from "./rpc-types.js";

type OmpMappedSubagentStatus = "running" | "completed" | "failed" | "canceled";

interface OmpSubagentDescriptor {
  title: string;
  description: string | null;
  status: OmpMappedSubagentStatus;
  toolCallId: string | null;
}

interface OmpSubagentState {
  title: string;
  description: string | null;
  resolvedModel: string | null;
  toolCallId: string | null;
  status: OmpMappedSubagentStatus;
  lastEmitted: OmpSubagentDescriptor | null;
  mapper: OmpHistoryMapper;
}

export class OmpSubagentIndex {
  private readonly statesByParent = new WeakMap<object, Map<string, OmpSubagentState>>();

  handleLifecycle(parent: object, payload: OmpSubagentLifecyclePayload): AgentStreamEvent[] {
    const state = this.stateFor(parent, payload.id, payload.agent);
    state.title = payload.agent || state.title;
    state.description = payload.description ?? state.description;
    state.toolCallId = payload.parentToolCallId ?? state.toolCallId;
    setMonotonicStatus(state, mapLifecycleStatus(payload.status));
    return this.changedUpsert(payload.id, state);
  }

  handleProgress(parent: object, payload: OmpSubagentProgressPayload): AgentStreamEvent[] {
    const id = payload.progress.id;
    const state = this.stateFor(parent, id, payload.agent);
    state.title = payload.agent || state.title;
    state.description = payload.progress.description ?? payload.assignment ?? state.description;
    if (payload.progress.resolvedModel?.trim()) {
      state.resolvedModel = payload.progress.resolvedModel;
    }
    state.toolCallId = payload.parentToolCallId ?? state.toolCallId;
    setMonotonicStatus(state, mapProgressStatus(payload.progress.status));
    return this.changedUpsert(id, state);
  }

  handleEvent(parent: object, payload: OmpSubagentEventPayload): AgentStreamEvent[] {
    const state = this.stateFor(parent, payload.id, "OMP subagent");
    const messages = messagesFromSessionEvent(payload.event);
    return state.mapper.mapMessages(messages).flatMap((mapped) =>
      mapped.type === "timeline"
        ? [
            {
              type: "provider_subagent" as const,
              provider: "omp",
              event: {
                type: "timeline" as const,
                id: payload.id,
                item: mapped.item,
                ...(mapped.timestamp ? { timestamp: mapped.timestamp } : {}),
              },
            },
          ]
        : [],
    );
  }

  terminalizeRunning(parent: object): AgentStreamEvent[] {
    const states = this.statesByParent.get(parent);
    if (!states) {
      return [];
    }
    const events: AgentStreamEvent[] = [];
    for (const [id, state] of states) {
      if (state.status !== "running") {
        continue;
      }
      state.status = "canceled";
      events.push(...this.changedUpsert(id, state));
    }
    return events;
  }

  hasRunning(parent: object): boolean {
    const states = this.statesByParent.get(parent);
    if (!states) {
      return false;
    }
    for (const state of states.values()) {
      if (state.status === "running") {
        return true;
      }
    }
    return false;
  }

  reconcileSnapshots(
    parent: object,
    snapshots: readonly OmpSubagentSnapshot[],
  ): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];
    for (const snapshot of snapshots) {
      const state = this.stateFor(parent, snapshot.id, snapshot.agent);
      state.title = snapshot.agent || state.title;
      state.description = snapshot.description ?? snapshot.assignment ?? state.description;
      state.toolCallId = snapshot.parentToolCallId ?? state.toolCallId;
      setMonotonicStatus(state, mapSnapshotStatus(snapshot.status));
      events.push(...this.changedUpsert(snapshot.id, state));
    }
    return events;
  }

  clear(parent: object): void {
    this.statesByParent.delete(parent);
  }

  private stateFor(parent: object, id: string, title: string): OmpSubagentState {
    const states = this.statesByParent.get(parent) ?? new Map<string, OmpSubagentState>();
    const existing = states.get(id);
    if (existing) return existing;
    const state: OmpSubagentState = {
      title,
      description: null,
      resolvedModel: null,
      toolCallId: null,
      status: "running",
      lastEmitted: null,
      mapper: new OmpHistoryMapper("omp", [], OMP_HISTORY_MAPPER_HOOKS),
    };
    states.set(id, state);
    this.statesByParent.set(parent, states);
    return state;
  }

  private changedUpsert(id: string, state: OmpSubagentState): AgentStreamEvent[] {
    const descriptor: OmpSubagentDescriptor = {
      title: formatOmpSubagentTitle(state.title, state.resolvedModel),
      description: state.description,
      status: state.status,
      toolCallId: state.toolCallId,
    };
    if (sameDescriptor(state.lastEmitted, descriptor)) {
      return [];
    }
    state.lastEmitted = descriptor;
    return [
      {
        type: "provider_subagent",
        provider: "omp",
        event: {
          type: "upsert",
          id,
          ...descriptor,
        },
      },
    ];
  }
}

function sameDescriptor(left: OmpSubagentDescriptor | null, right: OmpSubagentDescriptor): boolean {
  return (
    left?.title === right.title &&
    left.description === right.description &&
    left.status === right.status &&
    left.toolCallId === right.toolCallId
  );
}

function setMonotonicStatus(state: OmpSubagentState, status: OmpMappedSubagentStatus): void {
  if (state.status !== "running" && status === "running") {
    return;
  }
  state.status = status;
}

function messagesFromSessionEvent(event: OmpAgentSessionEvent): OmpAgentMessage[] {
  if (event.type === "message_end") return [event.message];
  return [];
}

function mapLifecycleStatus(
  status: OmpSubagentLifecyclePayload["status"],
): "running" | "completed" | "failed" | "canceled" {
  if (status === "started") return "running";
  return status === "aborted" ? "canceled" : status;
}

function mapProgressStatus(
  status: OmpSubagentProgressPayload["progress"]["status"],
): "running" | "completed" | "failed" | "canceled" {
  if (status === "completed" || status === "failed") return status;
  return status === "aborted" ? "canceled" : "running";
}

function mapSnapshotStatus(status: OmpSubagentSnapshot["status"]): OmpMappedSubagentStatus {
  if (status === "completed" || status === "failed") return status;
  return status === "aborted" ? "canceled" : "running";
}
