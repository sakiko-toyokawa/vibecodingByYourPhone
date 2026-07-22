/**
 * Run query + human-decision API routes (spec: docs/spec/03-API契约.md).
 *
 * GET  /api/runs/:id          — run metadata + ledger entry + the 03
 *                               LedgerSummary projection (incl.
 *                               judgment_report 摘要).
 * POST /api/runs/:id/decision — human answer for a needs_human run. All
 *                               state transitions go through the
 *                               control-plane (03: 所有状态迁移只经它发起).
 */

import { RunDecisionRequestSchema } from "@yep-anywhere/shared";
import { Hono } from "hono";
import {
  type ControlPlane,
  ControlPlaneError,
} from "../loop/control-plane/control-plane.js";
import type { LoopRunService } from "../loop/index.js";

export interface RunsRoutesDeps {
  runService: LoopRunService;
  /** Optional so phase-0 tests mounting queries alone still work */
  controlPlane?: ControlPlane;
}

function decisionErrorStatus(error: ControlPlaneError): 400 | 404 | 409 {
  switch (error.code) {
    case "invalid_decision":
      return 400;
    case "run_not_found":
      return 404;
    case "invalid_state":
      return 409;
  }
}

export function createRunsRoutes(deps: RunsRoutesDeps): Hono {
  const app = new Hono();

  /**
   * GET /api/runs/:id
   * Active run: { run, ledger: null, ledger_summary }. Finished run adds the
   * run_ledger_entry. 404 run_not_found otherwise.
   */
  app.get("/:id", async (c) => {
    const found = await deps.runService.getRun(c.req.param("id"));
    if (!found) {
      return c.json({ error: "run_not_found", message: "Run not found" }, 404);
    }
    return c.json(found);
  });

  /**
   * POST /api/runs/:id/decision
   * Human response for a needs_human run (03: approve / reject /
   * request_changes / pause + optional feedback). Every call appends a
   * decision_entry to runs/<run_id>.jsonl (override 记录进决策账本).
   *
   * Errors: 400 invalid_decision (bad body, or request_changes without
   * feedback); 404 run_not_found; 409 invalid_state (run is not in
   * needs_human).
   */
  app.post("/:id/decision", async (c) => {
    if (!deps.controlPlane) {
      return c.json(
        {
          error: "run_service_unavailable",
          message: "Control plane not registered",
        },
        503,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          error: "invalid_decision",
          message: "Request body must be valid JSON",
        },
        400,
      );
    }

    const parsed = RunDecisionRequestSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      return c.json({ error: "invalid_decision", message }, 400);
    }

    try {
      const runState = await deps.controlPlane.submitDecision(
        c.req.param("id"),
        parsed.data.decision,
        parsed.data.feedback,
      );
      return c.json({ run_state: runState }, 200);
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        return c.json(
          { error: error.code, message: error.message },
          decisionErrorStatus(error),
        );
      }
      throw error;
    }
  });

  return app;
}
