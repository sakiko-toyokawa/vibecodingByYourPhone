import { Hono } from "hono";
import type { SharingService } from "../services/SharingService.js";

export interface SharingRoutesDeps {
  sharingService: SharingService;
}

export function createSharingRoutes(deps: SharingRoutesDeps): Hono {
  const app = new Hono();

  app.get("/status", (c) => {
    return c.json(deps.sharingService.getPublicConfig());
  });

  app.post("/upload", async (c) => {
    if (!deps.sharingService.isConfigured()) {
      return c.json({ error: "Sharing not configured" }, 400);
    }

    const body = await c.req.json<{ html: string; title?: string }>();
    if (!body.html || typeof body.html !== "string") {
      return c.json({ error: "html is required" }, 400);
    }

    try {
      const result = await deps.sharingService.uploadHtml(
        body.html,
        body.title,
      );
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed";
      console.error("[sharing] Upload failed:", message);
      return c.json({ error: message }, 500);
    }
  });

  return app;
}
