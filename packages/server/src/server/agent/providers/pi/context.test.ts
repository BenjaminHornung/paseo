import { expect, it } from "vitest";
import { connectedPiMcpServers, isPiMcpStatusMessage } from "./context.js";

it("offers connected usable MCPs but not disconnected, signed-out, disabled or hidden definitions", () => {
  const status = [
    "live: connected, 3 tools (codemode)",
    "offline: disconnected, reconnects on next call (codemode)",
    "signed-out: needs sign-in, run /mcp login signed-out (direct)",
    "off: disabled (direct)",
    "hidden: connected, 4 tools (hidden)",
  ].join("\n");
  expect(connectedPiMcpServers(status).map((entry) => entry.name)).toEqual(["live"]);
  expect(isPiMcpStatusMessage(status)).toBe(true);
  expect(isPiMcpStatusMessage("Build: failed")).toBe(false);
  expect(isPiMcpStatusMessage(`Unrelated notice\n${status}`)).toBe(false);
  expect(isPiMcpStatusMessage("config error: unavailable")).toBe(false);
  expect(
    isPiMcpStatusMessage(
      "No MCP servers configured. Add them to C:\\agent\\mcp.json or .pi/mcp.json.",
    ),
  ).toBe(true);
});
