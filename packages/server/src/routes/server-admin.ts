import { Hono } from "hono";
import type { NotificationService } from "../notifications/index.js";
import type { Supervisor } from "../supervisor/Supervisor.js";

export interface ServerAdminDeps {
  supervisor: Supervisor;
  notificationService?: NotificationService;
  /** Returns active/retry loop runs that would be interrupted by restart. */
  activeLoopRuns?: () => Promise<
    Array<{ loop_id: string; run_id: string; state: string }>
  >;
}

/**
 * Administrative routes for server management.
 * Always mounted (not dev-mode-only), so remote relay clients can use them.
 */
export function createServerAdminRoutes(deps: ServerAdminDeps): Hono {
  const routes = new Hono();

  // POST /api/server/restart - Trigger graceful server restart
  routes.post("/restart", async (c) => {
    const active = (await deps.activeLoopRuns?.()) ?? [];
    if (active.length > 0 && c.req.query("force") !== "true") {
      return c.json(
        {
          error: "active_loop_runs",
          message:
            "Active loop runs would be interrupted by a server restart; pause them first or use ?force=true",
          active_loop_runs: active,
        },
        409,
      );
    }
    console.log("[ServerAdmin] Restart requested via API");

    await deps.notificationService?.flush();

    // Respond before exiting
    const response = c.json({
      ok: true,
      message: "Server restarting...",
    });

    // Schedule exit after response is sent.
    // Process supervisor (scripts/dev.js, systemd, pm2) will restart the process.
    setTimeout(() => {
      process.exit(0);
    }, 100);

    return response;
  });

  return routes;
}
