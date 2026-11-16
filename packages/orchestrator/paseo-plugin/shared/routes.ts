import type { ControllerConfig, Route } from "./settings.ts";
import { claudeSubscriptionAccess, isClaudeProvider } from "./providers.ts";

export interface RouteProfile {
  id: string;
  name: string;
  provider: string;
  model?: string;
  thinkingOptionId?: string;
  modeId?: string;
  featureValues?: Record<string, unknown>;
}
export interface RouteModel {
  id: string;
  thinkingOptions?: readonly { id: string }[];
  defaultThinkingOptionId?: string;
}

export const reasoningOptions = ["", "off", "low", "medium", "high", "xhigh", "max", "ultracode"];

export function routeLabel(route: Route): string {
  return route.name ?? `${route.profileName ?? route.model} · ${route.reasoning || "Standard"}`;
}

export function createProfileRoute(
  profile: RouteProfile,
  models: readonly RouteModel[],
  existing: readonly Route[],
): Route {
  const provider = profile.provider.split("/")[0];
  if (provider !== "codex" && !isClaudeProvider(provider) && provider !== "pi")
    throw Error("PROFILE_PROVIDER_UNSUPPORTED");
  const modelId = profile.model ?? profile.provider.split("/").slice(1).join("/");
  const model = models.find((model) => model.id === modelId);
  if (!model) throw Error("PROFILE_MODEL_UNAVAILABLE");
  const supported =
    model.thinkingOptions
      ?.map((option) => option.id)
      .filter((id) => reasoningOptions.includes(id)) ?? [];
  let reasoning = profile.thinkingOptionId ?? model.defaultThinkingOptionId ?? supported[0] ?? "";
  if (model.thinkingOptions?.length && !supported.includes(reasoning))
    throw Error("PROFILE_REASONING_UNSUPPORTED");
  if (!model.thinkingOptions?.length) {
    if (profile.thinkingOptionId) throw Error("PROFILE_REASONING_UNSUPPORTED");
    if (!isClaudeProvider(provider)) throw Error("PROFILE_REASONING_UNSUPPORTED");
    reasoning = "";
  }
  const featureValues: NonNullable<Route["featureValues"]> = {};
  for (const [key, value] of Object.entries(profile.featureValues ?? {})) {
    if (value !== null && !["string", "boolean", "number"].includes(typeof value))
      throw Error("PROFILE_FEATURE_UNSUPPORTED");
    featureValues[key] = value as string | boolean | number | null;
  }
  let access: Route["access"];
  if (provider === "codex") access = "codex-pro200";
  else if (isClaudeProvider(provider)) access = claudeSubscriptionAccess[provider];
  else if (modelId.startsWith("opencode-go/")) access = "opencode-go";
  else access = "openai-api";
  const stem = `${provider}-${modelId}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60);
  let id = stem;
  let suffix = 1;
  while (existing.some((route) => route.id === id)) id = `${stem}-${suffix++}`;
  return {
    id,
    name: profile.name,
    provider,
    model: modelId,
    revision: "settings-snapshot:pending",
    access,
    reasoning,
    tier: access === "opencode-go" ? 1 : 2,
    enabled: false,
    maxConcurrent: 1,
    capabilities: ["code", "text"],
    profileId: profile.id,
    profileName: profile.name,
    modeId: profile.modeId,
    ...(profile.featureValues ? { featureValues } : {}),
    ...(access === "openai-api" ? { bucket: "implementation" } : {}),
  };
}

function withoutRoute(ids: string[], removed: string, fallback: string | undefined): string[] {
  const rest = ids.filter((id) => id !== removed);
  return rest.length || !fallback ? rest : [fallback];
}

/**
 * Deletes a route and every reference to it. A role or category that would be left
 * without a route falls back to the first remaining enabled route (UI falls back to
 * the default routing). The last route cannot be deleted.
 */
export function removeRoute(config: ControllerConfig, routeId: string): ControllerConfig {
  const routes = config.routes.filter((route) => route.id !== routeId);
  if (!routes.length || routes.length === config.routes.length) return config;
  const fallback = (routes.find((route) => route.enabled) ?? routes[0]).id;
  const roleRoutes = config.roleRoutes && {
    ...config.roleRoutes,
    ...Object.fromEntries(
      Object.entries(config.roleRoutes).map(([role, ids]) => [
        role,
        ids && withoutRoute(ids, routeId, role === "ui" ? undefined : fallback),
      ]),
    ),
  };
  if (roleRoutes && !roleRoutes.ui?.length) delete roleRoutes.ui;
  return {
    ...config,
    routes,
    ...(roleRoutes ? { roleRoutes: roleRoutes as ControllerConfig["roleRoutes"] } : {}),
    ...(config.workCategories
      ? {
          workCategories: config.workCategories.map((category) => ({
            ...category,
            routeIds: withoutRoute(category.routeIds, routeId, fallback),
          })),
        }
      : {}),
  };
}
