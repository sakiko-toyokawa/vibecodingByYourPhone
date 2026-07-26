/**
 * Run query + human-decision API routes (spec: docs/spec/03-API契约.md).
 *
 * GET  /api/runs/:id          — { run, run_state, ledger_summary } (03
 *                               形状, 06 偏差 #30: 全量账本不经 API 暴露,
 *                               明细按 ledger:// / artifact:// 解析).
 * POST /api/runs/:id/decision — human answer for a needs_human run. All
 *                               state transitions go through the
 *                               control-plane (03: 所有状态迁移只经它发起).
 * POST /api/runs/:id/budget   — 人工补充预算 (06 偏差 #26).
 */

import { RunDecisionRequestSchema } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { z } from "zod";
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

/**
 * POST /:id/budget 请求体 (06 偏差 #26): 至少一项预算上限字段;
 * max_retries < max_turns 的联合约束由 control-plane supplementBudget
 * 在合并现有快照后统一校验。
 */
const BudgetSupplementSchema = z
  .object({
    max_turns: z.number().positive().optional(),
    max_retries: z.number().min(0).optional(),
    max_tokens: z.number().min(0).optional(),
    max_time_minutes: z.number().positive().optional(),
  })
  .refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    {
      message: "at least one budget field is required",
    },
  );

export function createRunsRoutes(deps: RunsRoutesDeps): Hono {
  const app = new Hono();

  /**
   * GET /api/runs/:id
   * 03 形状 (06 偏差 #30 确认): { run, run_state, ledger_summary } —
   * run_state 是 02 §7 状态机快照 (无记录时 null); 全量账本不经 API 暴
   * 露, 明细按 ledger:// / artifact:// 引用解析 (readUri)。404
   * run_not_found otherwise.
   */
  app.get("/:id", async (c) => {
    const found = await deps.runService.getRun(c.req.param("id"));
    if (!found) {
      return c.json({ error: "run_not_found", message: "Run not found" }, 404);
    }
    const runState = deps.controlPlane
      ? await deps.controlPlane.getRunState(found.run.loop_id)
      : null;
    return c.json({
      run: found.run,
      run_state: runState,
      ledger_summary: found.ledger_summary,
    });
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

  /**
   * POST /api/runs/:id/budget — 人工补充预算并恢复 (06 偏差 #26, 03 未定
   * 义此端点): budget_limited → active, control-plane supplementBudget
   * 的唯一生产入口 (此前状态机该分支不可达, budget_limited 实为终态)。
   *
   * Errors: 400 invalid_decision (body 非法 / 至少一项预算字段);
   * 404 run_not_found; 409 invalid_state (run 不是 budget_limited)。
   */
  app.post("/:id/budget", async (c) => {
    if (!deps.controlPlane) {
      return c.json(
        {
          error: "run_service_unavailable",
          message: "Control plane not registered",
        },
        503,
      );
    }

    const found = await deps.runService.getRun(c.req.param("id"));
    if (!found) {
      return c.json({ error: "run_not_found", message: "Run not found" }, 404);
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
    const parsed = BudgetSupplementSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      return c.json({ error: "invalid_decision", message }, 400);
    }

    try {
      const runState = await deps.controlPlane.supplementBudget(
        found.run.loop_id,
        parsed.data,
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
