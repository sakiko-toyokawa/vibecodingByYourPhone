/**
 * Run query API routes (spec: docs/spec/03-API契约.md).
 *
 * Phase-0 scope: GET /api/runs/:id only — active run metadata, or the
 * finished run's run_ledger_entry. POST /api/runs/:id/decision arrives
 * with the control-plane in a later phase.
 */

import { Hono } from "hono";
import type { LoopRunService } from "../loop/index.js";

export interface RunsRoutesDeps {
  runService: LoopRunService;
}

export function createRunsRoutes(deps: RunsRoutesDeps): Hono {
  const app = new Hono();

  /**
   * GET /api/runs/:id
   * Active run: { run, ledger: null }. Finished run: { run, ledger } with
   * the run_ledger_entry. 404 run_not_found otherwise.
   */
  app.get("/:id", async (c) => {
    const found = await deps.runService.getRun(c.req.param("id"));
    if (!found) {
      return c.json({ error: "run_not_found", message: "Run not found" }, 404);
    }
    return c.json(found);
  });

  return app;
}
