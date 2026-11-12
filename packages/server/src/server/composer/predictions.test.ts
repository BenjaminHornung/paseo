import { expect, it, onTestFinished, vi } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { AgentManager } from "../agent/agent-manager.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { ComposerPredictions } from "./predictions.js";

async function conversation() {
  const manager = new AgentManager({
    clients: { codex: createTestAgentClient("codex") },
    logger: createTestLogger(),
  });
  const agent = await manager.createAgent({ provider: "codex", cwd: process.cwd() }, undefined, {
    workspaceId: undefined,
    persistSession: false,
  });
  onTestFinished(() => manager.closeAgent(agent.id));
  await manager.runAgent(agent.id, "passt, mach bitte weiter");
  const rows = await manager.getTimelineRows(agent.id);
  const sourceTurnId = rows.findLast((row) => row.turnId)?.turnId;
  if (!sourceTurnId) throw new Error("Fixture turn has no source identity");
  const config = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    agentProfiles: [
      {
        id: "composer",
        name: "Composer",
        provider: "claude",
        model: "haiku",
        thinkingOptionId: "high",
      },
    ],
    composerPredictions: { enabled: true, profileId: "composer" },
  });
  return { manager, agent, sourceTurnId, config };
}

it("uses the assigned profile rather than the chat provider and deduplicates the same turn", async () => {
  const { manager, agent, sourceTurnId, config } = await conversation();
  const generate = vi
    .spyOn(manager, "generateText")
    .mockResolvedValue('{"suggestion":"ja, bitte umsetzen"}');
  const service = new ComposerPredictions(manager, () => config);
  expect(await service.predict(agent.id, sourceTurnId)).toBe("ja, bitte umsetzen");
  expect(await service.predict(agent.id, sourceTurnId)).toBe("ja, bitte umsetzen");
  expect(generate).toHaveBeenCalledTimes(1);
  expect(generate.mock.calls[0][0]).toMatchObject({
    provider: "claude",
    model: "haiku",
    thinkingOptionId: "high",
  });
});

it("reports temporary capacity exhaustion rather than caching an empty prediction", async () => {
  const { manager, agent, sourceTurnId, config } = await conversation();
  const generate = vi.spyOn(manager, "generateText").mockImplementation(
    (_config, _prompt, signal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
  const service = new ComposerPredictions(manager, () => config);
  const first = service.predict(agent.id, sourceTurnId);
  await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
  config.agentProfiles![0].model = "second";
  const second = service.predict(agent.id, sourceTurnId);
  await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
  config.agentProfiles![0].model = "third";
  try {
    await expect(service.predict(agent.id, sourceTurnId)).rejects.toMatchObject({
      code: "unavailable",
    });
  } finally {
    service.cancelAll();
    await Promise.all([first, second]);
  }
});

it.each(["profile", "provider"])(
  "discards a result from an older %s and stops owned generation on cancellation",
  async (changed) => {
    const { manager, agent, sourceTurnId, config } = await conversation();
    let complete!: (text: string) => void;
    const generate = vi.spyOn(manager, "generateText").mockImplementation(
      (_profile, _prompt, signal) =>
        new Promise<string>((resolve, reject) => {
          complete = resolve;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const service = new ComposerPredictions(manager, () => config);
    const first = service.predict(agent.id, sourceTurnId);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    if (changed === "profile") config.agentProfiles![0].model = "sonnet";
    else config.providers = { claude: { enabled: false } };
    complete('{"suggestion":"old profile result"}');
    expect(await first).toBeNull();
    const second = service.predict(agent.id, sourceTurnId);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    service.cancelAgent(agent.id);
    expect(await second).toBeNull();
    expect(generate.mock.calls[1][2].aborted).toBe(true);
  },
);
