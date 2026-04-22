/**
 * Browser Profiles API - Track browser profile origins
 *
 * GET /api/browser-profiles - List all browser profiles with their origins
 * DELETE /api/browser-profiles/:id - Delete a browser profile
 */

import type { BrowserProfilesResponse } from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { PushService } from "../push/index.js";
import type { BrowserProfileService } from "../services/BrowserProfileService.js";

export interface BrowserProfilesDeps {
  browserProfileService: BrowserProfileService;
  pushService?: PushService;
}

export function createBrowserProfilesRoutes(deps: BrowserProfilesDeps) {
  const { browserProfileService, pushService } = deps;
  const app = new Hono();

  /**
   * GET / - List all browser profiles with their origins
   */
  app.get("/", async (c) => {
    // Get push subscriptions for device names
    const subscriptions = pushService?.getSubscriptions() ?? {};

    // Get profiles enriched with device names
    const profiles =
      browserProfileService.getProfilesWithDeviceNames(subscriptions);

    // Sort by lastActiveAt (most recent first)
    profiles.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));

    const response: BrowserProfilesResponse = { profiles };
    return c.json(response);
  });

  /**
   * DELETE /:id - Delete a browser profile (forget device)
   */
  app.delete("/:id", async (c) => {
    const browserProfileId = c.req.param("id");
    const deleted = await browserProfileService.deleteProfile(browserProfileId);
    return c.json({ deleted });
  });

  return app;
}
