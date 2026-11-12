import { expect, it } from "vitest";
import { listCodexContext } from "./context.js";

it("lists only connected MCPs, enabled installed plugins and accessible enabled connectors", async () => {
  const request = async (method: string) => {
    if (method === "mcpServerStatus/list")
      return {
        data: [
          { name: "live", runtimeStatus: "connected", tools: {} },
          { name: "offline", runtimeStatus: "failed", tools: { retained: {} } },
        ],
        nextCursor: null,
      };
    if (method === "plugin/list")
      return {
        marketplaces: [
          {
            plugins: [
              { id: "on", name: "Available", installed: true, enabled: true },
              { id: "off", name: "Disabled", installed: true, enabled: false },
              { id: "catalog", name: "Not installed", installed: false, enabled: true },
              { id: "thread-off", name: "Excluded in this thread", installed: true, enabled: true },
            ],
          },
        ],
      };
    if (method === "app/list")
      return {
        data: [
          { id: "connected", name: "Connected", isAccessible: true, isEnabled: true },
          { id: "signed-out", name: "Not connected", isAccessible: false, isEnabled: true },
          { id: "disabled", name: "Disabled", isAccessible: true, isEnabled: false },
        ],
        nextCursor: null,
      };
    throw new Error(`Unexpected method ${method}`);
  };
  const entries = await listCodexContext({
    request,
    cwd: "/repo",
    threadId: "source",
    disabledPluginIds: ["thread-off"],
  });
  expect(entries.map((entry) => entry.id)).toEqual([
    "mcp:live",
    "plugin:on",
    "connector:connected",
  ]);
});
