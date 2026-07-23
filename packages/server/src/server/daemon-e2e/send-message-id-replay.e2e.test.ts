import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

describe("send message id replay", () => {
  let ctx: DaemonTestContext;
  let ctxNeedsCleanup: boolean;
  let providerStarts: number;

  async function startContext(options?: { paseoHomeRoot?: string; cleanup?: boolean }) {
    return await createDaemonTestContext({
      ...options,
      agentClients: createTestAgentClients({
        onStartTurn: () => {
          providerStarts += 1;
        },
      }),
    });
  }

  beforeEach(async () => {
    providerStarts = 0;
    ctx = await startContext();
    ctxNeedsCleanup = true;
  });

  afterEach(async () => {
    if (ctxNeedsCleanup) {
      await ctx.cleanup();
    }
  });

  async function createAgent(provider: "codex" | "claude" = "codex") {
    return await ctx.client.createAgent({
      provider,
      cwd: ctx.daemon.paseoHome,
      modeId: "full-access",
    });
  }

  test("admits concurrent identical sends once without touching activity on replay", async () => {
    const agent = await createAgent();
    const messageId = "client-message-concurrent";

    await Promise.all([
      ctx.client.sendMessage(agent.id, "  apply the selected patch  ", { messageId }),
      ctx.client.sendMessage(agent.id, "apply the selected patch", { messageId }),
    ]);
    await ctx.client.waitForFinish(agent.id, 5_000);
    await ctx.daemon.daemon.agentManager.flush();
    expect(providerStarts).toBe(1);

    const beforeReplay = ctx.daemon.daemon.agentManager.getAgent(agent.id)?.updatedAt.toISOString();
    await ctx.client.sendMessage(agent.id, "apply the selected patch", { messageId });
    const afterReplay = ctx.daemon.daemon.agentManager.getAgent(agent.id)?.updatedAt.toISOString();
    expect(afterReplay).toBe(beforeReplay);
    expect(providerStarts).toBe(1);
  });

  test("fingerprints images and attachments as part of the normalized payload", async () => {
    const agent = await createAgent();
    const messageId = "client-message-structured";
    const attachments = [
      { type: "text" as const, text: "review context", contextKind: "chat_history" as const },
    ];

    await ctx.client.sendMessage(agent.id, "  inspect this  ", {
      messageId,
      images: [{ data: "image-a", mimeType: "image/png" }],
      attachments,
    });
    await ctx.client.waitForFinish(agent.id, 5_000);
    await ctx.client.sendMessage(agent.id, "inspect this", {
      messageId,
      images: [{ data: "image-a", mimeType: "image/png" }],
      attachments,
    });
    expect(providerStarts).toBe(1);

    await expect(
      ctx.client.sendMessage(agent.id, "inspect this", {
        messageId,
        images: [{ data: "image-b", mimeType: "image/png" }],
        attachments,
      }),
    ).rejects.toThrow(`Client messageId '${messageId}' was reused with a different payload`);
    expect(providerStarts).toBe(1);
  });

  test("suppresses a replay after a daemon restart", async () => {
    const paseoHomeRoot = mkdtempSync(path.join(tmpdir(), "paseo-replay-home-"));
    try {
      await ctx.cleanup();
      ctxNeedsCleanup = false;
      ctx = await startContext({ paseoHomeRoot, cleanup: false });
      ctxNeedsCleanup = true;
      const agent = await createAgent();
      const messageId = "client-message-restart";

      await ctx.client.sendMessage(agent.id, "persist this send", { messageId });
      await ctx.client.waitForFinish(agent.id, 5_000);
      expect(providerStarts).toBe(1);

      await ctx.cleanup();
      ctxNeedsCleanup = false;
      ctx = await startContext({ paseoHomeRoot, cleanup: false });
      ctxNeedsCleanup = true;
      await ctx.client.sendMessage(agent.id, "persist this send", { messageId });
      expect(providerStarts).toBe(1);
    } finally {
      if (ctxNeedsCleanup) {
        await ctx.cleanup();
        ctxNeedsCleanup = false;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      await rm(paseoHomeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 30_000);

  test("suppresses a non-Codex replay after a daemon restart", async () => {
    const paseoHomeRoot = mkdtempSync(path.join(tmpdir(), "paseo-replay-home-"));
    try {
      await ctx.cleanup();
      ctxNeedsCleanup = false;
      ctx = await startContext({ paseoHomeRoot, cleanup: false });
      ctxNeedsCleanup = true;
      const agent = await createAgent("claude");
      const messageId = "client-message-restart-claude";

      await ctx.client.sendMessage(agent.id, "persist this send", { messageId });
      await ctx.client.waitForFinish(agent.id, 5_000);
      expect(providerStarts).toBe(1);

      await ctx.cleanup();
      ctxNeedsCleanup = false;
      ctx = await startContext({ paseoHomeRoot, cleanup: false });
      ctxNeedsCleanup = true;
      await ctx.client.sendMessage(agent.id, "persist this send", { messageId });
      expect(providerStarts).toBe(1);
    } finally {
      if (ctxNeedsCleanup) {
        await ctx.cleanup();
        ctxNeedsCleanup = false;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      await rm(paseoHomeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 30_000);
});
