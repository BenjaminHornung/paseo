import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager, type ManagedAgent } from "./agent-manager.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { MissingAgentCwdError } from "./agent-cwd.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentResumeSessionOptions,
  AgentSession,
  AgentSessionConfig,
} from "./agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function record(id: string, cwd: string, persistence: object | null) {
  return {
    id,
    provider: "codex" as const,
    cwd,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    lastActivityAt: "2026-07-01T00:00:00.000Z",
    lastUserMessageAt: null,
    persistence,
    labels: {},
  };
}

test("allowMissingCwd resumes persistence and hydrates history", async () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-loading-"));
  tempDirs.push(root);
  const missingCwd = join(root, "deleted-worktree");
  const agent = { id: "agent-1", provider: "codex", cwd: missingCwd } as ManagedAgent;
  let live: ManagedAgent | null = null;
  const resume = vi.fn(async () => (live = agent));
  const hydrate = vi.fn(async () => undefined);
  const manager = {
    getAgent: vi.fn(() => live),
    getRegisteredProviderIds: () => ["codex"],
    resumeAgentFromPersistence: resume,
    createAgent: vi.fn(),
    hydrateTimelineFromProvider: hydrate,
    touchAgentActivity: vi.fn(() => live),
    waitForAgentClose: vi.fn(async () => undefined),
  } as unknown as AgentManager;
  const storage = {
    get: vi.fn(async () =>
      record("agent-1", missingCwd, {
        provider: "codex",
        sessionId: "thread-1",
        metadata: { provider: "codex", cwd: missingCwd },
      }),
    ),
  } as unknown as AgentStorage;

  await expect(
    ensureAgentLoaded("agent-1", {
      agentManager: manager,
      agentStorage: storage,
      logger: createTestLogger(),
      allowMissingCwd: true,
    }),
  ).resolves.toBe(agent);
  expect(resume).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ cwd: missingCwd }),
    "agent-1",
    expect.objectContaining({ allowMissingCwd: true }),
    undefined,
  );
  expect(hydrate).toHaveBeenCalledWith(
    "agent-1",
    expect.objectContaining({ broadcast: expect.any(Function) }),
  );
});

test("missing cwd never creates new provider work from storage", async () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-loading-create-"));
  tempDirs.push(root);
  const missingCwd = join(root, "deleted-worktree");
  const manager = {
    getAgent: vi.fn(() => null),
    getRegisteredProviderIds: () => ["codex"],
    resumeAgentFromPersistence: vi.fn(),
    createAgent: vi.fn(),
    hydrateTimelineFromProvider: vi.fn(),
    touchAgentActivity: vi.fn(() => null),
    waitForAgentClose: vi.fn(async () => undefined),
  } as unknown as AgentManager;
  const storage = {
    get: vi.fn(async () => record("agent-2", missingCwd, null)),
  } as unknown as AgentStorage;

  await expect(
    ensureAgentLoaded("agent-2", {
      agentManager: manager,
      agentStorage: storage,
      logger: createTestLogger(),
      allowMissingCwd: true,
    }),
  ).rejects.toBeInstanceOf(MissingAgentCwdError);
  expect(manager.createAgent).not.toHaveBeenCalled();
});

test("loads archived records for history and active records with the interactive default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-purpose-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }

  const resumeOptions: Array<AgentResumeSessionOptions | undefined> = [];
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (
      config: AgentSessionConfig,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> => await baseClient.createSession(config, launchContext),
    resumeSession: async (
      handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
      options?: AgentResumeSessionOptions,
    ): Promise<AgentSession> => {
      resumeOptions.push(options);
      return await baseClient.resumeSession(handle, overrides, launchContext);
    },
    fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
    isAvailable: async () => await baseClient.isAvailable(),
  };
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });

  const archivedId = "00000000-0000-4000-8000-000000000301";
  const activeId = "00000000-0000-4000-8000-000000000302";

  try {
    const archived = await manager.createAgent({ provider: "codex", cwd: root }, archivedId, {
      workspaceId: "workspace-archived",
    });
    await manager.archiveAgent(archived.id);

    const active = await manager.createAgent({ provider: "codex", cwd: root }, activeId, {
      workspaceId: "workspace-active",
    });
    await manager.closeAgent(active.id);

    await ensureAgentLoaded(archived.id, { agentManager: manager, agentStorage: storage, logger });
    await ensureAgentLoaded(active.id, { agentManager: manager, agentStorage: storage, logger });

    expect(resumeOptions).toEqual([{ purpose: "history" }, undefined]);
  } finally {
    await Promise.all([
      manager.closeAgent(archivedId).catch(() => undefined),
      manager.closeAgent(activeId).catch(() => undefined),
    ]);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
