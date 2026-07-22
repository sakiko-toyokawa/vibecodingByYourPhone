/**
 * Loop registry API routes (spec: docs/spec/03-API契约.md)
 *
 * Phase-0 scope: POST /api/loops, GET /api/loops, GET /api/loops/:id,
 * POST /api/loops/:id/runs (manual trigger), GET /api/loops/:id/runs
 * (run list). PATCH / proposals endpoints come in later phases.
 */

import { LoopCardSchema } from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { LoopCardStore, LoopRunService } from "../loop/index.js";
import { LoopRunError } from "../loop/index.js";

export interface LoopsRoutesDeps {
  loopCardStore: LoopCardStore;
  /** Optional so tests mounting the registry alone still work */
  runService?: LoopRunService;
}

function runErrorStatus(error: LoopRunError): 400 | 404 | 409 {
  switch (error.code) {
    case "loop_not_found":
      return 404;
    case "run_active":
    case "loop_archived":
      return 409;
    case "loop_not_runnable":
      return 400;
  }
}

export function createLoopsRoutes(deps: LoopsRoutesDeps): Hono {
  const app = new Hono();
  const { loopCardStore, runService } = deps;

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

  /**
   * POST /api/loops/:id/runs
   * Manually trigger one run. The run executes in the background; the
   * ledger entry lands in ~/.yep-anywhere/loops/runs/<run_id>.jsonl when
   * it finishes. 409 run_active guards same-loop concurrency.
   */
  app.post("/:id/runs", async (c) => {
    if (!runService) {
      return c.json(
        {
          error: "run_service_unavailable",
          message: "Run service not registered",
        },
        503,
      );
    }
    // Body is optional in phase 0 (intent_overrides arrive with later phases)
    try {
      await c.req.json();
    } catch {
      // empty / non-JSON body is legal
    }
    try {
      const run = await runService.startRun(c.req.param("id"), "manual");
      return c.json({ run: { ...run, turn: 1 } }, 201);
    } catch (error) {
      if (error instanceof LoopRunError) {
        return c.json(
          { error: error.code, message: error.message },
          runErrorStatus(error),
        );
      }
      throw error;
    }
  });

  /**
   * GET /api/loops/:id/runs
   * Run list projection (active runs + finished ledger entries), newest
   * first. Optional limit/offset (defaults 50/0).
   */
  app.get("/:id/runs", async (c) => {
    if (!runService) {
      return c.json(
        {
          error: "run_service_unavailable",
          message: "Run service not registered",
        },
        503,
      );
    }
    const loopId = c.req.param("id");
    const stored = loopCardStore.getLoop(loopId);
    if (!stored || stored.archived) {
      return c.json(
        { error: "loop_not_found", message: "Loop not found" },
        404,
      );
    }
    const limit = Number(c.req.query("limit")) || 50;
    const offset = Number(c.req.query("offset")) || 0;
    const runs = await runService.listRuns(loopId);
    return c.json({ runs: runs.slice(offset, offset + limit) });
  });

  return app;
}
