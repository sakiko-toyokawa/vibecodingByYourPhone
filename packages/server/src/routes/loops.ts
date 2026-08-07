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
import { RunStateSchema } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { z } from "zod";
import {
  checkInteractionDependencies,
  inferPlaywrightInstallCommand,
} from "../loop/verification/strategies/interaction/dependency-check.js";
import { runCommand } from "../loop/verification/subprocess-verifier.js";
import {
  type ControlPlane,
  ControlPlaneError,
  type LoopCardStore,
  LoopRunError,
  type LoopRunService,
  type ProposalStore,
  isGitWorkTree,
} from "../loop/index.js";

/** POST /:id/runs 请求体 (03): intent_overrides 对 handoff 的本轮覆盖。 */
const TriggerRunBodySchema = z
  .object({
    intent_overrides: z
      .object({
        task: z.string().optional(),
        default_task_type: z.string().optional(),
        max_items_per_run: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const InstallInteractionDepsBodySchema = z
  .object({
    install_command: z.string().optional(),
  })
  .strict();

export interface LoopsRoutesDeps {
  loopCardStore: LoopCardStore;
  /** Optional so tests mounting the registry alone still work */
  runService?: LoopRunService;
  /** Optional so phase-0 tests mounting the registry alone still work */
  controlPlane?: ControlPlane;
  /** Optional: 阶段 3 提案列表端点 (GET /:id/proposals) */
  proposalStore?: ProposalStore;
  /** Test seam for dependency installation; production uses runCommand. */
  installInteractionDependencies?: (
    workspacePath: string,
    command: string,
  ) => Promise<{ ok: boolean; output: string }>;
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
  const {
    loopCardStore,
    runService,
    controlPlane,
    proposalStore,
    installInteractionDependencies = defaultInstallInteractionDependencies,
  } = deps;

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
    // worktree 策略创建期校验 (fail-fast): workspace.path 必填且是 git
    // 工作区 — 不留到 run 启动时才以 setup 失败落账。
    if (card.loop.workspace.strategy === "worktree") {
      const repoPath = card.loop.workspace.path;
      if (!repoPath) {
        return c.json(
          {
            error: "invalid_loop_card",
            message:
              "workspace.strategy is worktree but workspace.path is missing",
          },
          400,
        );
      }
      if (!(await isGitWorkTree(repoPath))) {
        return c.json(
          {
            error: "invalid_loop_card",
            message: `workspace.strategy is worktree but '${repoPath}' is not a git work tree`,
          },
          400,
        );
      }
    }
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
   * List registered loops (archived ones are hidden), full StoredLoop
   * shape (06 偏差 #30: 03 写的是 LoopSummary 投影, 但前端渲染需要
   * LoopCard 本体 —— 保留全卡, 另补 03 的分页与状态过滤)。
   * 查询参数: status? (paused/active/idle, active = 最近 run 在飞或等
   * 人工) / limit? / offset? (默认 50/0, 非法值忽略取默认)。
   */
  app.get("/", async (c) => {
    const limit = Number(c.req.query("limit")) || 50;
    const offset = Number(c.req.query("offset")) || 0;
    const statusQuery = c.req.query("status");
    const loops = loopCardStore.listLoops();
    if (!statusQuery) {
      return c.json({ loops: loops.slice(offset, offset + limit) });
    }
    // 状态过滤需要 run 信息 (paused 看注册表, active 看最近 run 状态)
    const withStatus = await Promise.all(
      loops.map(async (stored) => {
        let status: "paused" | "active" | "idle" = "idle";
        if (stored.paused) {
          status = "paused";
        } else if (runService) {
          const latest = (await runService.listRuns(stored.id))[0];
          if (
            latest &&
            (latest.state === "active" ||
              latest.state === "retry" ||
              latest.state === "needs_human")
          ) {
            status = "active";
          }
        }
        return { stored, status };
      }),
    );
    return c.json({
      loops: withStatus
        .filter((entry) => entry.status === statusQuery)
        .slice(offset, offset + limit)
        .map((entry) => entry.stored),
    });
  });

  /**
   * GET /api/loops/:id
   * Loop detail (03): current_run_state 来自 control-plane 的 run_state
   * 持久化记录 (无记录时为 null), last_run_summary 取最近一次 run 的
   * 摘要 (无 run 时为 null)。
   */
  app.get("/:id", async (c) => {
    const stored = loopCardStore.getLoop(c.req.param("id"));
    if (!stored || stored.archived) {
      return c.json(
        { error: "loop_not_found", message: "Loop not found" },
        404,
      );
    }
    const currentRunState = controlPlane
      ? await controlPlane.getRunState(stored.id)
      : null;
    const runs = runService ? await runService.listRuns(stored.id) : [];
    return c.json({
      loop: stored,
      current_run_state: currentRunState,
      last_run_summary: runs[0] ?? null,
    });
  });

  app.get("/:id/interaction-deps", async (c) => {
    const stored = loopCardStore.getLoop(c.req.param("id"));
    if (!stored || stored.archived) {
      return c.json(
        { error: "loop_not_found", message: "Loop not found" },
        404,
      );
    }
    const workspacePath = stored.card.loop.workspace.path;
    if (!workspacePath) {
      return c.json({
        status: "unsupported",
        message: "interaction verification requires a local workspace path",
      });
    }
    return c.json(await checkInteractionDependencies(workspacePath));
  });

  app.post("/:id/interaction-deps/install", async (c) => {
    const stored = loopCardStore.getLoop(c.req.param("id"));
    if (!stored || stored.archived) {
      return c.json(
        { error: "loop_not_found", message: "Loop not found" },
        404,
      );
    }
    const workspacePath = stored.card.loop.workspace.path;
    if (!workspacePath || workspacePath.startsWith("managed://")) {
      return c.json(
        {
          error: "unsupported_workspace",
          message: "interaction dependency install requires a local workspace",
        },
        400,
      );
    }

    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const parsed = InstallInteractionDepsBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json(
        { error: "invalid_install_request", message: "Invalid request body" },
        400,
      );
    }
    const command =
      parsed.data.install_command ??
      stored.card.loop.verification.interaction?.install_command ??
      inferPlaywrightInstallCommand(workspacePath);
    if (!isAllowedInteractionInstallCommand(command)) {
      return c.json(
        {
          error: "install_command_not_allowed",
          message:
            "Install command must add @playwright/test and playwright as dev dependencies with pnpm/npm/yarn/bun",
        },
        400,
      );
    }

    const result = await installInteractionDependencies(workspacePath, command);
    return c.json(
      {
        ok: result.ok,
        command,
        output: result.output.slice(-8000),
      },
      result.ok ? 200 : 500,
    );
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
   * 请求体 intent_overrides (03): 对 handoff 的本轮覆盖, 不写回注册表;
   * 空 body 合法。
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
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      // empty / non-JSON body is legal
    }
    const parsed = TriggerRunBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      return c.json({ error: "invalid_loop_card", message }, 400);
    }
    try {
      const run = await runService.startRun(
        c.req.param("id"),
        "manual",
        parsed.data.intent_overrides,
      );
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
   * first. Optional state? (7 枚举过滤, 03) + limit/offset (defaults 50/0).
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
    const stateQuery = c.req.query("state");
    if (stateQuery && !RunStateSchema.safeParse(stateQuery).success) {
      return c.json(
        {
          error: "invalid_state",
          message: `state must be one of ${RunStateSchema.options.join(", ")}`,
        },
        400,
      );
    }
    const limit = Number(c.req.query("limit")) || 50;
    const offset = Number(c.req.query("offset")) || 0;
    const runs = (await runService.listRuns(loopId)).filter(
      (run) => !stateQuery || run.state === stateQuery,
    );
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

function isAllowedInteractionInstallCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, " ");
  const allowedPrefix =
    /^(pnpm add -D|npm install -D|yarn add -D|bun add -d) /;
  return (
    allowedPrefix.test(normalized) &&
    normalized.includes("@playwright/test") &&
    normalized.includes("playwright") &&
    !/[;&|<>]/.test(normalized)
  );
}

async function defaultInstallInteractionDependencies(
  workspacePath: string,
  command: string,
): Promise<{ ok: boolean; output: string }> {
  const outcome = await runCommand(command, {
    cwd: workspacePath,
    timeoutMs: 5 * 60 * 1000,
  });
  return {
    ok: outcome.kind === "exit" && outcome.exitCode === 0,
    output: outcome.output,
  };
}
