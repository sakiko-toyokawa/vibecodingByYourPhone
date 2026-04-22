import type { ProviderInfo, ProviderName } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { getAllProviders } from "../sdk/providers/index.js";
import type { ModelInfoService } from "../services/ModelInfoService.js";

interface ProviderRouteDeps {
  modelInfoService?: ModelInfoService;
  /** If non-empty, only these provider names are exposed. */
  enabledProviders?: string[];
}

/**
 * Creates provider-related API routes.
 *
 * GET /api/providers - Get all providers with their auth status
 * GET /api/providers/:name - Get specific provider status
 */
export function createProvidersRoutes(deps: ProviderRouteDeps = {}): Hono {
  const routes = new Hono();
  // GET /api/providers - Get all available providers with auth status and models
  routes.get("/", async (c) => {
    let providers = getAllProviders();
    if (deps.enabledProviders && deps.enabledProviders.length > 0) {
      const enabled = new Set(deps.enabledProviders);
      providers = providers.filter((p) => enabled.has(p.name));
    }
    const providerInfos: ProviderInfo[] = [];

    for (const provider of providers) {
      const [authStatus, models] = await Promise.all([
        provider.getAuthStatus(),
        provider.getAvailableModels(),
      ]);
      deps.modelInfoService?.ingestModels(
        provider.name as ProviderName,
        models,
      );
      providerInfos.push({
        name: provider.name,
        displayName: provider.displayName,
        installed: authStatus.installed,
        authenticated: authStatus.authenticated,
        enabled: authStatus.enabled,
        expiresAt: authStatus.expiresAt?.toISOString(),
        user: authStatus.user,
        models,
        supportsPermissionMode: provider.supportsPermissionMode,
        supportsThinkingToggle: provider.supportsThinkingToggle,
        supportsSlashCommands: provider.supportsSlashCommands,
      });
    }

    return c.json({ providers: providerInfos });
  });

  // GET /api/providers/:name - Get specific provider status with models
  routes.get("/:name", async (c) => {
    const name = c.req.param("name");
    const providers = getAllProviders();
    const provider = providers.find((p) => p.name === name);

    if (!provider) {
      return c.json({ error: "Provider not found" }, 404);
    }

    const [authStatus, models] = await Promise.all([
      provider.getAuthStatus(),
      provider.getAvailableModels(),
    ]);
    deps.modelInfoService?.ingestModels(provider.name as ProviderName, models);
    const providerInfo: ProviderInfo = {
      name: provider.name,
      displayName: provider.displayName,
      installed: authStatus.installed,
      authenticated: authStatus.authenticated,
      enabled: authStatus.enabled,
      expiresAt: authStatus.expiresAt?.toISOString(),
      user: authStatus.user,
      models,
      supportsPermissionMode: provider.supportsPermissionMode,
      supportsThinkingToggle: provider.supportsThinkingToggle,
      supportsSlashCommands: provider.supportsSlashCommands,
    };

    return c.json({ provider: providerInfo });
  });

  return routes;
}
