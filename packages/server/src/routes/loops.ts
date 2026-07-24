/**
 * Loop registry API routes (spec: docs/spec/03-API契约.md)
 *
 * Phase-0 scope: POST /api/loops, GET /api/loops, GET /api/loops/:id,
 * POST /api/loops/:id/runs (manual trigger), GET /api/loops/:id/runs
 * (run list). Phase 2 adds PATCH /api/loops/:id (pause / resume / archive).
 * Phase 3 adds GET /api/loops/:id/proposals (改进提案列表; approve /
 * publish / rollback 走 routes/proposals.ts).
 */

import { LoopActionRequestSchema, LoopCardSchema } from "@yep-anywhere/shared";
import type { ProposalStatus } from "@yep-anywhere/shared";
import { Hono } from "hono";
import {
  type ControlPlane,
  ControlPlaneError,
  type LoopCardStore,
  LoopRunError,
  type LoopRunService,
  type ProposalStore,
} from "../loop/index.js";

export interface LoopsRoutesDeps {
  loopCardStore: LoopCardStore;
  /** Optional so tests mounting the registry alone still work */
  runService?: LoopRunService;
  /** Optional so phase-0 tests mounting the registry alone still work */
  controlPlane?: ControlPlane;
  /** Optional: 阶段 3 提案列表端点 (GET /:id/proposals) */
  proposalStore?: ProposalStore;
}

function runErrorStatus(error: LoopRunError): 400 | 404 | 409 {
  switch (error.code) {
    case "loop_not_found":
      return 404;
    case "run_active":
    case "loop_archived":
    case "loop_paused":
      return 409;
    case "loop_not_runnable":
      return 400;
  }
}

function controlErrorStatus(error: ControlPlaneError): 400 | 404 | 409 {
  switch (error.code) {
    case "invalid_decision":
      return 400;
    case "run_not_found":
      return 404;
    case "invalid_state":
      return 409;
  }
}

export function createLoopsRoutes(deps: LoopsRoutesDeps): Hono {
  const app = new Hono();
  const { loopCardStore, runService, controlPlane, proposalStore } = deps;

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
   * PATCH /api/loops/:id — pause / resume / archive (03-API契约.md, 阶段 2).
   *
   *  - pause: 主动暂停 — 当前有 active run 时 run 进入 paused（执行进程被
   *    杀，选项 A，见 run-service 文件头），不走审批管线（审批队列无新增
   *    排队项）；无活跃 run 时仅置 loop 级 paused 标记阻止后续触发。
   *  - resume: 恢复信号 — paused → active（resumePaused，从下一轮继续），
   *    或清除 loop 级 paused 标记。归档 loop 不可 resume。
   *  - archive: 软删除（loops.json 置 archived，文件不删）；有活跃 run
   *    （active/retry，含首轮在飞尚无 state 记录）时 409，须先 pause。
   *
   * Errors: 400 invalid_action（body 非法）；404 loop_not_found；
   * 409 invalid_state（对非 active run pause、对非 paused run resume、
   * 对已归档 loop 操作、archive 有活跃 run）。
   */
  app.patch("/:id", async (c) => {
    const loopId = c.req.param("id");
    const stored = loopCardStore.getLoop(loopId);
    if (!stored) {
      return c.json(
        { error: "loop_not_found", message: "Loop not found" },
        404,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: "invalid_action", message: "Request body must be valid JSON" },
        400,
      );
    }
    const parsed = LoopActionRequestSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      return c.json({ error: "invalid_action", message }, 400);
    }
    const { action } = parsed.data;

    // 对已归档 loop 的任何操作都是 409 invalid_state（03）。
    if (stored.archived) {
      return c.json(
        {
          error: "invalid_state",
          message: `Loop '${loopId}' is archived`,
        },
        409,
      );
    }

    if (action === "archive") {
      // 有活跃 run 时 409，须先 pause。active/retry 是在飞状态；暂停家族
      // （paused/needs_human/budget_limited）不执行，可归档。首轮在飞的
      // run 还没有 state 记录，用 run-service 的注册位兜底。
      const record = controlPlane
        ? await controlPlane.getRunState(loopId)
        : null;
      const executing = record
        ? record.state === "active" || record.state === "retry"
        : (runService?.isRunActive(loopId) ?? false);
      if (executing) {
        return c.json(
          {
            error: "invalid_state",
            message: `Loop '${loopId}' has an active run; pause it before archiving (03: 须先 pause)`,
          },
          409,
        );
      }
      await loopCardStore.archiveLoop(loopId);
      return c.json(
        { loop_id: loopId, current_run_state: record?.state ?? null },
        200,
      );
    }

    // pause / resume need the control-plane + run service.
    if (!controlPlane || !runService) {
      return c.json(
        {
          error: "run_service_unavailable",
          message: "Control plane / run service not registered",
        },
        503,
      );
    }

    if (action === "pause") {
      try {
        const updated = await runService.pauseActiveRun(loopId);
        // 无活跃 run（updated === null）时仅阻止后续触发 —— loop 级标记
        // 持久化在 loops.json，重启后仍生效。run 级 pause 同样置标记，
        // resume 时清除。
        await loopCardStore.setPaused(loopId, true);
        return c.json(
          { loop_id: loopId, current_run_state: updated?.state ?? null },
          200,
        );
      } catch (error) {
        if (error instanceof ControlPlaneError) {
          return c.json(
            { error: error.code, message: error.message },
            controlErrorStatus(error),
          );
        }
        if (error instanceof LoopRunError) {
          return c.json(
            { error: error.code, message: error.message },
            runErrorStatus(error),
          );
        }
        throw error;
      }
    }

    // action === "resume"
    const record = await controlPlane.getRunState(loopId);
    if (record?.state === "paused") {
      try {
        // paused → active（恢复只需信号，不携带人工响应）；ResumeSignal
        // 驱动 run service 从下一轮继续（resumeSession 语义沿用 2-1）。
        const updated = await controlPlane.resumePaused(loopId);
        await loopCardStore.setPaused(loopId, false);
        return c.json(
          { loop_id: loopId, current_run_state: updated.state },
          200,
        );
      } catch (error) {
        if (error instanceof ControlPlaneError) {
          return c.json(
            { error: error.code, message: error.message },
            controlErrorStatus(error),
          );
        }
        throw error;
      }
    }
    if (stored.paused) {
      // Loop-level pause with no paused run: clearing the flag re-enables
      // triggers. (A needs_human run CANNOT resume here — 03: its resume
      // must carry a human response via POST /api/runs/:id/decision.)
      await loopCardStore.setPaused(loopId, false);
      return c.json(
        { loop_id: loopId, current_run_state: record?.state ?? null },
        200,
      );
    }
    return c.json(
      {
        error: "invalid_state",
        message: `Loop '${loopId}' run is '${record?.state ?? "none"}', not paused (resume requires a paused run; needs_human runs resume via POST /api/runs/:id/decision)`,
      },
      409,
    );
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

  /**
   * GET /api/loops/:id/proposals — 该 loop 相关改进提案列表
   * (03-API契约.md; 阶段 3). 关联规则: 提案 target 以 `<loop_id>.` 为前缀
   * (worker 提案 target=<loop_id>.<hint>), 或 payload.canary_loops 命中
   * 该 loop。查询参数 status? (7 值) / limit? / offset? (默认 50/0),
   * 按 created_at 倒序。
   */
  app.get("/:id/proposals", (c) => {
    if (!proposalStore) {
      return c.json(
        {
          error: "proposal_store_unavailable",
          message: "Proposal store not registered",
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
    const status = c.req.query("status") as ProposalStatus | undefined;
    const limit = Number(c.req.query("limit")) || 50;
    const offset = Number(c.req.query("offset")) || 0;
    const proposals = proposalStore
      .listProposals(status)
      .filter(
        (proposal) =>
          proposal.target.startsWith(`${loopId}.`) ||
          proposal.payload?.canary_loops?.includes(loopId) === true,
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return c.json({ proposals: proposals.slice(offset, offset + limit) });
  });

  return app;
}
