import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SendAgentMessageRequest } from "@getpaseo/protocol/messages";
import { expect, test } from "../support/fixtures";
import {
  attachFileFromMenu,
  composerLocator,
  expectComposerVisible,
} from "../support/helpers/composer";
import { connectDaemonClient, loadProtocolSchemas } from "../support/helpers/daemon-client-loader";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { seedWorkspace } from "../support/helpers/seed-client";

const PLUGIN_ID = "paseo-orchestrator";
const PREPARE_INPUT_METHOD = "orchestrator.prepare-input";
const READ_RECEIPTS_METHOD = "e2e.read-prepared-inputs";
const RELEASE_PREPARES_METHOD = "e2e.release-prepares";
const ATTACHED_FILE = {
  name: "orchestrator-context.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("The selected context must remain with the submitted message."),
};
const PROMPT = "Review the attached context and summarize its purpose.";

const TEST_PLUGIN_SERVER_SOURCE = `
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const preparedInputSchema = z.object({
  agentId: z.string(),
  messageId: z.string(),
  text: z.string(),
});
const prepareInput = defineRpc({
  name: ${JSON.stringify(PREPARE_INPUT_METHOD)},
  input: preparedInputSchema,
  output: z.object({ recorded: z.literal(true) }),
});
const readPreparedInputs = defineRpc({
  name: ${JSON.stringify(READ_RECEIPTS_METHOD)},
  input: z.object({}),
  output: z.object({
    receipts: z.array(preparedInputSchema),
    pendingMessageIds: z.array(z.string()),
  }),
});
const releasePrepares = defineRpc({
  name: ${JSON.stringify(RELEASE_PREPARES_METHOD)},
  input: z.object({}),
  output: z.object({ releasedCount: z.number().int().nonnegative() }),
});

export default function contribute(server) {
  const receipts = [];
  const pending = new Map();

  server.handle(prepareInput, ({ agentId, messageId, text }) => {
    receipts.push({ agentId, messageId, text });
    return new Promise((resolve) => {
      pending.set(messageId, () => {
        pending.delete(messageId);
        resolve({ recorded: true });
      });
    });
  });
  server.handle(readPreparedInputs, () => ({
    receipts: [...receipts],
    pendingMessageIds: [...pending.keys()],
  }));
  server.handle(releasePrepares, () => {
    const releases = [...pending.values()];
    for (const release of releases) release();
    return { releasedCount: releases.length };
  });

  return () => {
    for (const release of [...pending.values()]) release();
  };
}
`;

type OrchestratorComposerClient = Pick<
  DaemonClient,
  | "close"
  | "connect"
  | "fetchAgentTimeline"
  | "getDaemonConfig"
  | "installDirectoryPlugin"
  | "invokePluginRpc"
  | "patchDaemonConfig"
  | "removePlugin"
>;

const preparedInputStateSchema = z.object({
  receipts: z.array(z.object({ agentId: z.string(), messageId: z.string(), text: z.string() })),
  pendingMessageIds: z.array(z.string()),
});
type PreparedInputState = z.infer<typeof preparedInputStateSchema>;

async function readPreparedInputs(client: OrchestratorComposerClient): Promise<PreparedInputState> {
  return preparedInputStateSchema.parse(
    await client.invokePluginRpc(PLUGIN_ID, READ_RECEIPTS_METHOD, {}),
  );
}

test("normal composer prepares a labeled message before send and keeps its file attachment", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const { SendAgentMessageRequestSchema } = await loadProtocolSchemas();
  const sendEnvelopeSchema = z.object({
    type: z.literal("session"),
    message: SendAgentMessageRequestSchema,
  });
  const nativeRequests: SendAgentMessageRequest[] = [];
  const daemonSocket = daemonWsRoutePattern();
  page.on("websocket", (socket) => {
    if (!daemonSocket.test(socket.url())) return;
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const envelope = sendEnvelopeSchema.safeParse(JSON.parse(payload));
      if (envelope.success) nativeRequests.push(envelope.data.message);
    });
  });
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "paseo-orchestrator-composer-e2e-"));
  let client: OrchestratorComposerClient | undefined;
  let workspace: Awaited<ReturnType<typeof seedWorkspace>> | undefined;
  let previousPluginsEnabled: boolean | undefined;
  let pluginInstallAttempted = false;

  try {
    await writeFile(
      path.join(pluginDirectory, "paseo-plugin.json"),
      JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
    );
    await writeFile(path.join(pluginDirectory, "index.server.ts"), TEST_PLUGIN_SERVER_SOURCE);

    client = await connectDaemonClient<OrchestratorComposerClient>({
      clientIdPrefix: "orchestrator-composer-e2e",
    });
    const previousConfig = await client.getDaemonConfig();
    previousPluginsEnabled = previousConfig.config.pluginsEnabled ?? false;
    await client.patchDaemonConfig({ pluginsEnabled: true });
    pluginInstallAttempted = true;
    await client.installDirectoryPlugin(pluginDirectory);

    workspace = await seedWorkspace({ repoPrefix: "orchestrator-composer-" });
    const agent = await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Prepared composer input",
      model: "e2e-fast-stream",
      modeId: "load-test",
      labels: { orchestratorPreparation: "test" },
    });

    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });
    await expectComposerVisible(page);
    await attachFileFromMenu(page, ATTACHED_FILE);
    await expect(page.getByTestId("composer-file-attachment-pill")).toContainText(
      ATTACHED_FILE.name,
    );
    await composerLocator(page).fill(PROMPT);
    await composerLocator(page).press("Enter");

    const pluginClient = client;
    await expect
      .poll(async () => (await readPreparedInputs(pluginClient)).receipts.length, {
        timeout: 15_000,
      })
      .toBe(1);
    const preparedState = await readPreparedInputs(client);
    expect(preparedState.receipts).toHaveLength(1);
    const [receipt] = preparedState.receipts;
    if (!receipt) throw new Error("The orchestrator prepare-input RPC did not record its input");
    expect(receipt).toEqual({
      agentId: agent.id,
      messageId: expect.any(String),
      text: PROMPT,
    });
    expect(preparedState.pendingMessageIds).toEqual([receipt.messageId]);
    expect(nativeRequests).toHaveLength(0);

    const historyBeforeRelease = await client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      projection: "canonical",
    });
    expect(
      historyBeforeRelease.entries.some(
        ({ item }) =>
          item.type === "user_message" &&
          (item.messageId === receipt.messageId || item.clientMessageId === receipt.messageId),
      ),
    ).toBe(false);

    expect(await client.invokePluginRpc(PLUGIN_ID, RELEASE_PREPARES_METHOD, {})).toEqual({
      releasedCount: 1,
    });

    await expect.poll(() => nativeRequests.length).toBe(1);
    const [nativeRequest] = nativeRequests;
    expect(nativeRequest).toMatchObject({
      agentId: agent.id,
      messageId: receipt.messageId,
      text: PROMPT,
      attachments: [
        {
          type: "uploaded_file",
          fileName: ATTACHED_FILE.name,
          mimeType: ATTACHED_FILE.mimeType,
          size: ATTACHED_FILE.buffer.length,
        },
      ],
    });

    await expect
      .poll(
        async () => {
          const history = await pluginClient.fetchAgentTimeline(agent.id, {
            direction: "tail",
            projection: "canonical",
          });
          return history.entries.filter(
            ({ item }) =>
              item.type === "user_message" &&
              (item.messageId === receipt.messageId || item.clientMessageId === receipt.messageId),
          ).length;
        },
        { timeout: 30_000 },
      )
      .toBe(1);
    const canonicalHistory = await client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      projection: "canonical",
    });
    const canonicalMessages = canonicalHistory.entries.filter(
      ({ item }) =>
        item.type === "user_message" &&
        (item.messageId === receipt.messageId || item.clientMessageId === receipt.messageId),
    );
    expect(canonicalMessages).toHaveLength(1);
    expect(canonicalMessages[0]?.item).toMatchObject({ type: "user_message", text: PROMPT });

    await workspace.client.waitForFinish(agent.id, 30_000);
    const userMessage = page.getByTestId("user-message").filter({ hasText: PROMPT }).last();
    await expect(userMessage).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
    await expect(userMessage).toContainText(ATTACHED_FILE.name);
    await testInfo.attach("orchestrator-prepared-composer-send", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  } finally {
    try {
      if (client && pluginInstallAttempted) {
        await client.invokePluginRpc(PLUGIN_ID, RELEASE_PREPARES_METHOD, {}).catch(() => undefined);
        await client.removePlugin(PLUGIN_ID).catch(() => undefined);
      }
      if (client && previousPluginsEnabled !== undefined) {
        await client.patchDaemonConfig({ pluginsEnabled: previousPluginsEnabled });
      }
    } finally {
      await client?.close();
      try {
        await workspace?.cleanup();
      } finally {
        await rm(pluginDirectory, { recursive: true, force: true });
      }
    }
  }
});
