import { z } from "zod";
import { isClaudeProvider } from "../paseo-plugin/shared/providers.ts";
import { configSchema, hash, type Config } from "./contracts.ts";

const profileSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
  featureValues: z
    .record(z.string(), z.union([z.string(), z.boolean(), z.number(), z.null()]))
    .optional(),
});
export type Profile = z.infer<typeof profileSchema>;
export function syncProfiles(config: Config, input: unknown): Config {
  const profiles = z.array(profileSchema).parse(input);
  return configSchema.parse({
    ...config,
    routes: config.routes.map((route) => {
      if (!route.profileId) return route;
      const p = profiles.find((p) => p.id === route.profileId);
      const provider = p?.provider.split("/")[0];
      const model = p?.model ?? p?.provider.split("/").slice(1).join("/");
      if (
        !p ||
        !model ||
        provider !== route.provider ||
        (!p.thinkingOptionId && !isClaudeProvider(route.provider))
      )
        throw Error(`Profile unavailable or provider changed for ${route.id}`);
      if (model !== route.model)
        throw Error(
          `Profile model changed for ${route.id}; approve its tier and route model before syncing`,
        );
      const settings = {
        profileId: p.id,
        provider: route.provider,
        model,
        reasoning: p.thinkingOptionId ?? route.reasoning,
        modeId: p.modeId,
        featureValues: p.featureValues,
      };
      return {
        ...route,
        ...settings,
        profileName: p.name,
        revision: `profile-snapshot:${hash(settings)}`,
      };
    }),
  });
}
