import { z } from "zod";
import type { HarnessContextEntry } from "@getpaseo/protocol/messages";

const McpPageSchema = z.object({
  data: z.array(
    z.object({
      name: z.string(),
      runtimeStatus: z.string().nullable().optional(),
      tools: z.record(z.string(), z.unknown()),
      toolsError: z.string().nullable().optional(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
const PluginsSchema = z.object({
  marketplaces: z.array(
    z.object({
      plugins: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          installed: z.boolean(),
          enabled: z.boolean(),
        }),
      ),
    }),
  ),
});
const AppsPageSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable().optional(),
      isAccessible: z.boolean().default(false),
      isEnabled: z.boolean().default(true),
    }),
  ),
  nextCursor: z.string().nullable(),
});

type CodexPlugin = z.infer<typeof PluginsSchema>["marketplaces"][number]["plugins"][number];

function isAvailablePlugin(plugin: CodexPlugin, disabledPluginIds: readonly string[] | null) {
  return plugin.installed && plugin.enabled && !disabledPluginIds?.includes(plugin.id);
}

export async function listCodexContext(options: {
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  cwd: string;
  threadId: string;
  disabledPluginIds: readonly string[] | null;
  kinds?: readonly HarnessContextEntry["kind"][];
}): Promise<HarnessContextEntry[]> {
  const entries: HarnessContextEntry[] = [];
  const kinds = options.kinds ?? ["mcp", "plugin", "connector"];
  let cursor: string | null = null;
  if (kinds.includes("mcp")) {
    do {
      const page = McpPageSchema.parse(
        await options.request("mcpServerStatus/list", {
          threadId: options.threadId,
          cursor,
          limit: 100,
        }),
      );
      for (const server of page.data) {
        if (server.runtimeStatus !== "connected" || server.toolsError) continue;
        entries.push({
          id: `mcp:${server.name}`,
          kind: "mcp",
          name: server.name,
          description: "",
          invocation: `MCP server ${server.name}`,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
  const canListPlugins = kinds.includes("plugin") && options.disabledPluginIds !== null;
  const plugins = canListPlugins
    ? PluginsSchema.parse(
        await options.request("plugin/list", { cwds: [options.cwd], forceRefetch: false }),
      )
    : { marketplaces: [] };
  for (const marketplace of plugins.marketplaces) {
    for (const plugin of marketplace.plugins) {
      if (!isAvailablePlugin(plugin, options.disabledPluginIds)) continue;
      entries.push({
        id: `plugin:${plugin.id}`,
        kind: "plugin",
        name: plugin.name,
        description: "",
        invocation: `plugin ${plugin.id}`,
      });
    }
  }
  if (!kinds.includes("connector")) return entries;
  cursor = null;
  do {
    const page = AppsPageSchema.parse(
      await options.request("app/list", {
        threadId: options.threadId,
        cursor,
        limit: 100,
        forceRefetch: false,
      }),
    );
    for (const app of page.data) {
      if (!app.isAccessible || !app.isEnabled) continue;
      entries.push({
        id: `connector:${app.id}`,
        kind: "connector",
        name: app.name,
        description: app.description ?? "",
        invocation: `connector ${app.id}`,
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return entries;
}
