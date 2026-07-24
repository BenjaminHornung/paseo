import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { MissingAgentCwdError } from "./agent-cwd.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";

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
  );
  expect(hydrate).toHaveBeenCalledWith("agent-1");
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
