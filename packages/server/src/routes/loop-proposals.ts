/**
 * Loop proposal gate API routes (loop-self-proposal-gate 计划 P1-5)。
 *
 * - GET    /api/loop-proposals            提案列表（?state= 过滤）
 * - POST   /api/loop-proposals/:id/approve  人工批准：用钳制后的 card 创建 loop
 * - POST   /api/loop-proposals/:id/reject   人工拒绝：带 reason 进 learning 账本
 *
 * 错误语义照搬 routes/github.ts 的 approve-issue：400 invalid_request /
 * 404 proposal_not_found / 409 invalid_state / 409 loop_id_conflict /
 * 502 create_failed。
 */

import { Hono } from "hono";
import { z } from "zod";
import type {
  LoopProposalLifecycleService,
  LoopProposalStore,
} from "../loop/index.js";

const RejectBodySchema = z
  .object({
    reason: z.string().min(1).optional(),
  })
  .strict();

const PROPOSAL_STATES = new Set(["pending_approval", "approved", "rejected"]);

export interface LoopProposalsRoutesDeps {
  loopProposalStore?: LoopProposalStore;
  loopProposalLifecycle?: LoopProposalLifecycleService;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createLoopProposalsRoutes(deps: LoopProposalsRoutesDeps): Hono {
  const app = new Hono();
  const { loopProposalStore, loopProposalLifecycle } = deps;

  /** GET / — 提案列表（默认全部，?state=pending_approval 等过滤）。 */
  app.get("/", (c) => {
    if (!loopProposalStore) {
      return c.json({ error: "loop_proposal_store_unavailable" }, 503);
    }
    const state = c.req.query("state");
    if (state !== undefined && !PROPOSAL_STATES.has(state)) {
      return c.json(
        {
          error: "invalid_request",
          message: `unknown proposal state '${state}'`,
        },
        400,
      );
    }
    const proposals = loopProposalStore
      .list()
      .filter((proposal) => !state || proposal.state === state);
    return c.json({ proposals });
  });

  /**
   * POST /:id/approve — 人工批准并创建 loop。
   * Errors: 404 proposal_not_found；409 invalid_state / loop_id_conflict；
   * 502 create_failed。
   */
  app.post("/:id/approve", async (c) => {
    if (!loopProposalStore || !loopProposalLifecycle) {
      return c.json({ error: "loop_proposal_store_unavailable" }, 503);
    }
    const proposalId = c.req.param("id");
    if (!loopProposalStore.findById(proposalId)) {
      return c.json({ error: "proposal_not_found" }, 404);
    }
    try {
      const result = await loopProposalLifecycle.approve(proposalId);
      if (result === "invalid_state") {
        const proposal = loopProposalStore.findById(proposalId);
        return c.json(
          {
            error: "invalid_state",
            message: `proposal '${proposalId}' is '${proposal?.state}', not 'pending_approval'`,
          },
          409,
        );
      }
      if (result === "loop_exists") {
        return c.json(
          {
            error: "loop_id_conflict",
            message: "a loop with the proposed card id already exists",
          },
          409,
        );
      }
      if (!result) {
        return c.json({ error: "proposal_not_found" }, 404);
      }
      return c.json({ proposal: result, loop_id: result.created_loop_id });
    } catch (error) {
      return c.json(
        { error: "create_failed", message: errorMessage(error) },
        502,
      );
    }
  });

  /**
   * POST /:id/reject — 人工拒绝（body 可带 reason，进 learning 账本）。
   * Errors: 400 invalid_request；404 proposal_not_found；409 invalid_state。
   */
  app.post("/:id/reject", async (c) => {
    if (!loopProposalStore || !loopProposalLifecycle) {
      return c.json({ error: "loop_proposal_store_unavailable" }, 503);
    }
    let body: unknown = {};
    try {
      const text = await c.req.text();
      body = text.trim().length > 0 ? JSON.parse(text) : {};
    } catch {
      return c.json(
        { error: "invalid_request", message: "request body must be JSON" },
        400,
      );
    }
    const parsed = RejectBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", message: "reason must be a string" },
        400,
      );
    }
    const proposalId = c.req.param("id");
    if (!loopProposalStore.findById(proposalId)) {
      return c.json({ error: "proposal_not_found" }, 404);
    }
    const result = await loopProposalLifecycle.reject(
      proposalId,
      parsed.data.reason,
    );
    if (result === "invalid_state") {
      const proposal = loopProposalStore.findById(proposalId);
      return c.json(
        {
          error: "invalid_state",
          message: `proposal '${proposalId}' is '${proposal?.state}', not 'pending_approval'`,
        },
        409,
      );
    }
    if (!result) {
      return c.json({ error: "proposal_not_found" }, 404);
    }
    return c.json({ proposal: result });
  });

  return app;
}
