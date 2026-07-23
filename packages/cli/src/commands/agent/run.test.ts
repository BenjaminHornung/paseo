import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveExistingRunWorkspace,
  resolveRunCallerAgentId,
  runRunCommand,
  type AgentRunOptions,
} from "./run";

function createAgentRejectedError(message: string, requestId: string): Error {
  return Object.assign(new Error(message), {
    name: "AgentCreateRejectedError",
    code: "AGENT_CREATE_REJECTED" as const,
    requestId,
  });
}

const daemonClient = vi.hoisted(() => ({
  listProviderModes: vi.fn(),
  fetchWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
  archiveWorkspace: vi.fn(),
  createAgent: vi.fn(),
  waitForFinish: vi.fn(),
  close: vi.fn(),
}));

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => daemonClient),
  getDaemonHost: vi.fn(() => "ws://127.0.0.1:6767"),
}));

describe("managed agent caller context", () => {
  it("propagates a trimmed PASEO_AGENT_ID", () => {
    expect(resolveRunCallerAgentId({ PASEO_AGENT_ID: "  parent-agent  " })).toBe("parent-agent");
  });

  it("omits blank caller ids", () => {
    expect(resolveRunCallerAgentId({ PASEO_AGENT_ID: "   " })).toBeUndefined();
  });
});

describe("existing run workspace resolution", () => {
  it("queries the daemon for an exact workspace id and uses its directory", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [{ id: "workspace-2", workspaceDirectory: "/workspace/two" }],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "workspace-2")).resolves.toEqual({
      id: "workspace-2",
      cwd: "/workspace/two",
    });
    expect(fetchWorkspaces).toHaveBeenCalledWith({
      filter: { query: "workspace-2" },
      page: { limit: 200 },
    });
  });

  it("rejects a workspace id absent from daemon state", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "missing")).rejects.toMatchObject(
      {
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace not found: missing",
      },
    );
  });
});

// validateRunOptions runs before the CLI ever connects to a daemon, so these
// invalid combinations reject without one running.
describe("runRunCommand option validation", () => {
  const originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;

  beforeEach(() => {
    delete process.env.PASEO_WORKSPACE_ID;
  });

  afterEach(() => {
    if (originalWorkspaceId === undefined) {
      delete process.env.PASEO_WORKSPACE_ID;
    } else {
      process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
    }
  });

  async function expectInvalidOptions(options: AgentRunOptions, messageMatch: RegExp) {
    await expect(runRunCommand("do something", options, {} as never)).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: expect.stringMatching(messageMatch),
    });
  }

  it("rejects --isolation combined with --workspace", async () => {
    await expectInvalidOptions(
      { isolation: "worktree", workspace: "ws-1" },
      /--isolation and --workspace cannot be combined/,
    );
  });

  it("allows explicit worktree isolation through validation", async () => {
    // Explicit isolation with no --workspace
    // must clear validation. It still fails later (provider resolution), which
    // is enough to prove the new guard did not reject it.
    await expect(
      runRunCommand("do something", { isolation: "worktree", provider: undefined }, {} as never),
    ).rejects.not.toMatchObject({ code: "INVALID_OPTIONS" });
  });

  it("rejects unknown workspace isolation", async () => {
    await expectInvalidOptions({ isolation: "container" }, /Unsupported workspace isolation/);
  });
});

describe("runRunCommand explicit mode preflight", () => {
  beforeEach(() => {
    vi.stubEnv("PASEO_AGENT_ID", "");
    vi.stubEnv("PASEO_WORKSPACE_ID", "");
    vi.clearAllMocks();
    daemonClient.listProviderModes.mockResolvedValue({
      provider: "claude",
      modes: [
        { id: "default", label: "Default" },
        { id: "bypassPermissions", label: "Bypass Permissions" },
      ],
      error: null,
      fetchedAt: "2026-07-22T00:00:00.000Z",
      requestId: "modes-request",
    });
    daemonClient.fetchWorkspaces.mockResolvedValue({
      entries: [{ id: "workspace-existing", workspaceDirectory: "/workspace/actual" }],
      pageInfo: { nextCursor: null },
    });
    daemonClient.createWorkspace.mockResolvedValue({
      workspace: {
        id: "workspace-1",
        name: "Project",
        workspaceDirectory: "/project",
      },
    });
    daemonClient.createAgent.mockResolvedValue({
      id: "agent-1",
      status: "running",
      provider: "claude",
      cwd: "/project",
      title: null,
    });
    daemonClient.archiveWorkspace.mockResolvedValue({
      workspaceId: "workspace-1",
      archivedAt: "2026-07-22T00:01:00.000Z",
      error: null,
    });
    daemonClient.close.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const runInBackground = (options: Partial<AgentRunOptions> = {}) =>
    runRunCommand(
      "do something",
      { provider: "claude", cwd: "/project", background: true, ...options },
      {} as never,
    );

  it("rejects an unavailable explicit mode before creating a workspace", async () => {
    await expect(runInBackground({ mode: "bypass" })).rejects.toMatchObject({
      code: "INVALID_MODE",
      message:
        "Invalid mode 'bypass' for provider 'claude'. Available modes: default, bypassPermissions",
    });

    expect(daemonClient.listProviderModes).toHaveBeenCalledWith("claude", { cwd: "/project" });
    expect(daemonClient.createWorkspace).not.toHaveBeenCalled();
    expect(daemonClient.createAgent).not.toHaveBeenCalled();
    expect(daemonClient.close).toHaveBeenCalledTimes(1);
  });

  it("creates the workspace after validating an explicit mode", async () => {
    await expect(runInBackground({ mode: "bypassPermissions" })).resolves.toMatchObject({
      data: { agentId: "agent-1" },
    });

    expect(daemonClient.listProviderModes).toHaveBeenCalledWith("claude", { cwd: "/project" });
    expect(daemonClient.createWorkspace).toHaveBeenCalledTimes(1);
    expect(daemonClient.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ modeId: "bypassPermissions", workspaceId: "workspace-1" }),
    );
    expect(daemonClient.listProviderModes.mock.invocationCallOrder[0]).toBeLessThan(
      daemonClient.createWorkspace.mock.invocationCallOrder[0]!,
    );
  });

  it("does not fetch provider modes when no explicit mode was supplied", async () => {
    await expect(runInBackground()).resolves.toMatchObject({ data: { agentId: "agent-1" } });

    expect(daemonClient.listProviderModes).not.toHaveBeenCalled();
    expect(daemonClient.createWorkspace).toHaveBeenCalledTimes(1);
  });

  it("preserves the generic default alias when the provider catalog has different ids", async () => {
    daemonClient.listProviderModes.mockResolvedValue({
      provider: "codex",
      modes: [
        { id: "auto", label: "Auto" },
        { id: "full-access", label: "Full Access" },
      ],
      error: null,
      fetchedAt: "2026-07-22T00:00:00.000Z",
      requestId: "modes-request",
    });

    await expect(runInBackground({ provider: "codex", mode: "default" })).resolves.toMatchObject({
      data: { agentId: "agent-1" },
    });

    expect(daemonClient.listProviderModes).not.toHaveBeenCalled();
    expect(daemonClient.createWorkspace).toHaveBeenCalledTimes(1);
    expect(daemonClient.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "codex", modeId: "default" }),
    );
    expect(daemonClient.archiveWorkspace).not.toHaveBeenCalled();
  });

  it("uses the resolved explicit workspace directory for the mode catalog", async () => {
    await expect(
      runInBackground({
        cwd: "/source",
        workspace: "workspace-existing",
        mode: "bypassPermissions",
      }),
    ).resolves.toMatchObject({ data: { agentId: "agent-1" } });

    expect(daemonClient.fetchWorkspaces).toHaveBeenCalledWith({
      filter: { query: "workspace-existing" },
      page: { limit: 200 },
    });
    expect(daemonClient.listProviderModes).toHaveBeenCalledWith("claude", {
      cwd: "/workspace/actual",
    });
    expect(daemonClient.createWorkspace).not.toHaveBeenCalled();
    expect(daemonClient.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/workspace/actual", workspaceId: "workspace-existing" }),
    );
    expect(daemonClient.archiveWorkspace).not.toHaveBeenCalled();
  });

  it("uses the resolved ambient workspace directory for the mode catalog", async () => {
    vi.stubEnv("PASEO_WORKSPACE_ID", "workspace-existing");

    await expect(
      runInBackground({ cwd: "/source", mode: "bypassPermissions" }),
    ).resolves.toMatchObject({ data: { agentId: "agent-1" } });

    expect(daemonClient.listProviderModes).toHaveBeenCalledWith("claude", {
      cwd: "/workspace/actual",
    });
    expect(daemonClient.createWorkspace).not.toHaveBeenCalled();
    expect(daemonClient.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/workspace/actual", workspaceId: "workspace-existing" }),
    );
  });

  it("leaves cwd-scoped mode validation to the daemon for caller-managed workspaces", async () => {
    vi.stubEnv("PASEO_AGENT_ID", "parent-agent");

    await expect(
      runInBackground({ cwd: "/source", mode: "provider-specific" }),
    ).resolves.toMatchObject({ data: { agentId: "agent-1" } });

    expect(daemonClient.fetchWorkspaces).not.toHaveBeenCalled();
    expect(daemonClient.listProviderModes).not.toHaveBeenCalled();
    expect(daemonClient.createWorkspace).not.toHaveBeenCalled();
    expect(daemonClient.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        callerAgentId: "parent-agent",
        cwd: "/source",
        modeId: "provider-specific",
        workspaceId: undefined,
      }),
    );
    expect(daemonClient.archiveWorkspace).not.toHaveBeenCalled();
  });

  it("validates worktree modes against the created target workspace, not the source catalog", async () => {
    await expect(
      runInBackground({ isolation: "worktree", base: "target", mode: "target-only" }),
    ).resolves.toMatchObject({ data: { agentId: "agent-1" } });

    expect(daemonClient.listProviderModes).not.toHaveBeenCalled();
    expect(daemonClient.createWorkspace).toHaveBeenCalledTimes(1);
    expect(daemonClient.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/project",
        workspaceId: "workspace-1",
        modeId: "target-only",
      }),
    );
    expect(daemonClient.archiveWorkspace).not.toHaveBeenCalled();
  });

  it("rolls back a newly created local workspace when createAgent rejects", async () => {
    daemonClient.createAgent.mockRejectedValue(
      createAgentRejectedError("mode rejected by server", "create-agent-request"),
    );

    await expect(runInBackground()).rejects.toMatchObject({
      code: "AGENT_CREATE_FAILED",
      message: "Failed to create agent: mode rejected by server",
    });

    expect(daemonClient.archiveWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(daemonClient.close).toHaveBeenCalledTimes(1);
  });

  it("rolls back a new worktree when target-branch mode validation rejects", async () => {
    daemonClient.createAgent.mockRejectedValue(
      createAgentRejectedError("No advertised default mode", "create-agent-request"),
    );

    await expect(
      runInBackground({ isolation: "worktree", base: "target", mode: "default" }),
    ).rejects.toMatchObject({
      code: "AGENT_CREATE_FAILED",
      message: "Failed to create agent: No advertised default mode",
    });

    expect(daemonClient.listProviderModes).not.toHaveBeenCalled();
    expect(daemonClient.archiveWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(daemonClient.close).toHaveBeenCalledTimes(1);
  });

  it("keeps newly created workspaces when a literal default mode is accepted", async () => {
    await expect(runInBackground({ mode: "default" })).resolves.toMatchObject({
      data: { agentId: "agent-1" },
    });

    expect(daemonClient.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "claude", modeId: "default" }),
    );
    expect(daemonClient.archiveWorkspace).not.toHaveBeenCalled();
  });

  it("never archives an existing user-selected workspace when createAgent rejects", async () => {
    daemonClient.createAgent.mockRejectedValue(
      createAgentRejectedError("mode rejected by server", "create-agent-request"),
    );

    await expect(
      runInBackground({ workspace: "workspace-existing", mode: "bypassPermissions" }),
    ).rejects.toMatchObject({
      code: "AGENT_CREATE_FAILED",
      message: "Failed to create agent: mode rejected by server",
    });

    expect(daemonClient.createWorkspace).not.toHaveBeenCalled();
    expect(daemonClient.archiveWorkspace).not.toHaveBeenCalled();
    expect(daemonClient.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the primary createAgent error and reports rollback failure as details", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    daemonClient.createAgent.mockRejectedValue(
      createAgentRejectedError("No advertised default mode", "create-agent-request"),
    );
    daemonClient.archiveWorkspace.mockResolvedValue({
      workspaceId: "workspace-1",
      archivedAt: null,
      error: "archive failed",
    });

    await expect(runInBackground({ mode: "default" })).rejects.toMatchObject({
      code: "AGENT_CREATE_FAILED",
      message: "Failed to create agent: No advertised default mode",
      details: {
        workspaceRollback: "archive failed",
      },
    });
    expect(consoleError).toHaveBeenCalledWith(
      "Warning: failed to roll back workspace workspace-1: archive failed",
    );
    expect(daemonClient.close).toHaveBeenCalledTimes(1);
  });

  it("retains a new workspace when createAgent transport outcome is ambiguous", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    daemonClient.createAgent.mockRejectedValue(new Error("connection lost after send"));

    await expect(runInBackground()).rejects.toMatchObject({
      code: "AGENT_CREATE_FAILED",
      message: "Failed to create agent: connection lost after send",
    });

    expect(daemonClient.archiveWorkspace).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "Warning: retained workspace workspace-1 because agent creation outcome is unknown.",
    );
    expect(daemonClient.close).toHaveBeenCalledTimes(1);
  });

  it("closes the client when an explicit workspace cannot be resolved", async () => {
    daemonClient.fetchWorkspaces.mockResolvedValue({
      entries: [],
      pageInfo: { nextCursor: null },
    });

    await expect(runInBackground({ workspace: "missing", mode: "default" })).rejects.toMatchObject({
      code: "WORKSPACE_NOT_FOUND",
    });

    expect(daemonClient.listProviderModes).not.toHaveBeenCalled();
    expect(daemonClient.createWorkspace).not.toHaveBeenCalled();
    expect(daemonClient.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ label: ["missing-separator"], mode: "bypassPermissions" }, "INVALID_LABEL"],
    [{ env: ["missing-separator"], mode: "bypassPermissions" }, "INVALID_ENV"],
  ] as const)("reports deterministic %s errors before mode lookup", async (extraOptions, code) => {
    await expect(runInBackground(extraOptions)).rejects.toMatchObject({ code });

    expect(daemonClient.listProviderModes).not.toHaveBeenCalled();
    expect(daemonClient.createWorkspace).not.toHaveBeenCalled();
    expect(daemonClient.createAgent).not.toHaveBeenCalled();
  });

  it("reports image loading errors before mode lookup", async () => {
    await expect(
      runInBackground({
        image: ["definitely-missing-run-image.png"],
        mode: "bypassPermissions",
      }),
    ).rejects.toMatchObject({
      code: "AGENT_CREATE_FAILED",
      message: expect.stringContaining("Failed to read image definitely-missing-run-image.png"),
    });

    expect(daemonClient.listProviderModes).not.toHaveBeenCalled();
    expect(daemonClient.createWorkspace).not.toHaveBeenCalled();
    expect(daemonClient.createAgent).not.toHaveBeenCalled();
  });

  it("passes an explicit mode through when the daemon has no mode catalog", async () => {
    daemonClient.listProviderModes.mockResolvedValue({
      provider: "claude",
      error: null,
      fetchedAt: "2026-07-22T00:00:00.000Z",
      requestId: "modes-request",
    });

    await expect(runInBackground({ mode: "provider-specific" })).resolves.toMatchObject({
      data: { agentId: "agent-1" },
    });
    expect(daemonClient.createWorkspace).toHaveBeenCalledTimes(1);
  });

  it("surfaces provider catalog errors before creating a workspace", async () => {
    daemonClient.listProviderModes.mockResolvedValue({
      provider: "claude",
      error: "provider executable is unavailable",
      fetchedAt: "2026-07-22T00:00:00.000Z",
      requestId: "modes-request",
    });

    await expect(runInBackground({ mode: "bypassPermissions" })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: "Failed to fetch modes for claude: provider executable is unavailable",
    });
    expect(daemonClient.createWorkspace).not.toHaveBeenCalled();
    expect(daemonClient.close).toHaveBeenCalledTimes(1);
  });

  it("closes the client when provider mode lookup rejects", async () => {
    daemonClient.listProviderModes.mockRejectedValue(new Error("catalog request timed out"));

    await expect(runInBackground({ mode: "bypassPermissions" })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: "Failed to fetch modes for claude: catalog request timed out",
    });
    expect(daemonClient.createWorkspace).not.toHaveBeenCalled();
    expect(daemonClient.close).toHaveBeenCalledTimes(1);
  });
});
