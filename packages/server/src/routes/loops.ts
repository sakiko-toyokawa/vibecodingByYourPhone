/**
 * Loop registry API routes (spec: docs/spec/03-API契约.md)
 *
 * Phase-0 scope: POST /api/loops, GET /api/loops, GET /api/loops/:id only.
 * PATCH / runs / proposals endpoints come in later steps.
 */

import { LoopCardSchema } from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { LoopCardStore } from "../loop/index.js";

export interface LoopsRoutesDeps {
  loopCardStore: LoopCardStore;
}

export function createLoopsRoutes(deps: LoopsRoutesDeps): Hono {
  const app = new Hono();
  const { loopCardStore } = deps;

  /**
   * POST /api/loops
   * Create a loop from a LoopCard (request body is the LoopCard JSON).
   */
  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          error: "invalid_loop_card",
          message: "Request body must be valid JSON",
        },
        400,
      );
    }

    const parsed = LoopCardSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      return c.json({ error: "invalid_loop_card", message }, 400);
    }

    const card = parsed.data;
    const id = card.loop.id;
    if (loopCardStore.getLoop(id)) {
      return c.json(
        { error: "loop_exists", message: `Loop '${id}' is already registered` },
        409,
      );
    }

    const stored = await loopCardStore.createLoop(card);
    return c.json({ loop: stored }, 201);
  });

  /**
   * GET /api/loops
   * List registered loops (archived ones are hidden).
   */
  app.get("/", (c) => {
    return c.json({ loops: loopCardStore.listLoops() });
  });

  /**
   * GET /api/loops/:id
   * Loop detail. current_run_state / last_run_summary are null until the
   * control-plane lands in a later phase.
   */
  app.get("/:id", (c) => {
    const stored = loopCardStore.getLoop(c.req.param("id"));
    if (!stored || stored.archived) {
      return c.json(
        { error: "loop_not_found", message: "Loop not found" },
        404,
      );
    }
    return c.json({
      loop: stored,
      current_run_state: null,
      last_run_summary: null,
    });
  });

  return app;
}
