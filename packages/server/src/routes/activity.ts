import { Hono } from "hono";
import type {
  BrowserProfileService,
  ConnectedBrowsersService,
} from "../services/index.js";
import type { EventBus } from "../watcher/index.js";

export interface ActivityDeps {
  eventBus: EventBus;
  connectedBrowsers?: ConnectedBrowsersService;
  browserProfileService?: BrowserProfileService;
}

export function createActivityRoutes(deps: ActivityDeps): Hono {
  const routes = new Hono();

  // GET /api/activity/status - Get watcher status
  routes.get("/status", (c) => {
    return c.json({
      subscribers: deps.eventBus.subscriberCount,
      timestamp: new Date().toISOString(),
    });
  });

  // GET /api/activity/connections - Get snapshot of connected browser tabs
  routes.get("/connections", (c) => {
    if (!deps.connectedBrowsers) {
      return c.json({
        connections: [],
        deviceCount: 0,
        totalTabCount: 0,
      });
    }

    return c.json({
      connections: deps.connectedBrowsers.getAllConnections(),
      browserProfileCount:
        deps.connectedBrowsers.getConnectedBrowserProfileIds().length,
      totalTabCount: deps.connectedBrowsers.getTotalTabCount(),
    });
  });

  return routes;
}
