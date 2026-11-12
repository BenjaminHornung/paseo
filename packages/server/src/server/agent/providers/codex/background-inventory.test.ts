import { afterEach, expect, test, vi } from "vitest";
import { CodexBackgroundInventory } from "./background-inventory.js";

const inventories: CodexBackgroundInventory[] = [];
afterEach(() => {
  for (const inventory of inventories.splice(0)) inventory.stop();
});

function createInventory(request: (method: string, params?: unknown) => Promise<unknown>) {
  const inventory = new CodexBackgroundInventory(() => {});
  inventories.push(inventory);
  inventory.start({ client: { request }, thread: "native-session-a" });
  return inventory;
}

test("refresh waits for a native query started after the request and preserves native process identity", async () => {
  const replies: Array<(value: unknown) => void> = [];
  const request = vi.fn(() => new Promise<unknown>((resolve) => replies.push(resolve)));
  const inventory = createInventory(request);
  const pending = inventory.refreshNow();
  let settled = false;
  void pending.then(() => {
    settled = true;
    return undefined;
  });

  // This older in-flight result must not certify an empty inventory.
  replies[0]({ data: [], nextCursor: null });
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(settled).toBe(false);
  expect(request.mock.calls[1]).toEqual([
    "thread/backgroundTerminals/list",
    { threadId: "native-session-a" },
    10_000,
  ]);
  replies[1]({ data: [{ processId: "42", command: "sleep 30" }], nextCursor: null });
  const observation = await pending;
  expect(observation).toMatchObject({
    providerSessionId: "native-session-a",
    observationId: expect.any(String),
    coverage: "codex_background_terminals",
    queriedProviderSessionIds: ["native-session-a"],
    items: [{ providerSessionId: "native-session-a", processId: "42", command: "sleep 30" }],
  });

  const second = inventory.refreshNow();
  expect(request).toHaveBeenCalledTimes(3);
  replies[2]({ data: [], nextCursor: null });
  const empty = await second;
  expect(empty.items).toEqual([]);
  expect(empty.observationId).not.toBe(observation.observationId);
});

test("a failed refresh rejects even when an earlier inventory was empty", async () => {
  const request = vi.fn().mockResolvedValueOnce({ data: [], nextCursor: null });
  const inventory = createInventory(request);
  await vi.waitFor(() => expect(inventory.snapshot()?.items).toEqual([]));
  request.mockRejectedValueOnce(new Error("native query failed"));
  await expect(inventory.refreshNow()).rejects.toThrow("BACKGROUND_WORK_REFRESH_FAILED");
});

test("a session change rejects a pending observation", async () => {
  const inventory = createInventory(() => new Promise(() => {}));
  const pending = inventory.refreshNow();
  const rejected = expect(pending).rejects.toThrow("BACKGROUND_WORK_SESSION_CHANGED");
  inventory.stop();
  await rejected;
});
