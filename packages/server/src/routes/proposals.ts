/**
 * Proposal API routes (spec: docs/spec/03-API契约.md §REST 端点总表
 * createProposalsRoutes; 提案验证与发布.md 元规则保护).
 *
 * Endpoints:
 * - GET    /api/proposals/:id          详情 + history (管线账本可查)
 * - POST   /api/proposals/:id/approve  人工批准 (canary → approved)
 * - POST   /api/proposals/:id/publish  人工发布 (approved → published)
 * - POST   /api/proposals/:id/rollback 回滚 (任意非终态 → rolled_back)
 *
 * 人工闸门 (03 决策二): approve / publish 不存在任何自动路径 —— worker
 * 只经内部 pipeline 推进 draft→shadow→canary, 不暴露 HTTP; 这里两个端点
 * 是唯一入口。
 *
 * publish 仅人工 (元规则): 请求体必须带显式人类标记 `{ "by": "human" }`,
 * 缺失或其他值一律 403 human_required —— 不靠调用方自觉, 在 API 层钉死。
 *
 * 元规则保护 (提案验证与发布.md, 阶段 3 验收 4): type / target 涉及发布
 * 管线自身的提案 (isMetaRuleProposal) 若 created_by=worker, approve 与
 * publish 一律 403 meta_rule_requires_human —— 只有人工发起的元规则
 * 变更能被批准/发布 (pipeline 侧也已拒绝其进入管线, 这里是双保险)。
 *
 * rollback 端点是本实现对 03 的补充 (03 端点总表无 rollback): 05 阶段 3
 * 验收 3 要求 "任一档不通过可回滚, 全程账本可查", 回滚走
 * proposalStore.rollback → rolled_back, 提案文件与 history 不删, 同
 * target 的旧 published 版本在装配层重新生效。
 */

import type { ImprovementProposal } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { ProposalStoreError, isMetaRuleProposal } from "../loop/index.js";
import type { ProposalStore } from "../loop/index.js";
import type { IEventBus } from "../watcher/IEventBus.js";

export interface ProposalsRoutesDeps {
  proposalStore: ProposalStore;
  /** Optional: broadcast proposal-published (03 WS 契约, activity channel) */
  eventBus?: IEventBus;
}

function storeErrorStatus(error: ProposalStoreError): 404 | 409 {
  return error.code === "proposal_not_found" ? 404 : 409;
}

/** 解析请求体; 空 body / 非 JSON 合法 (03: approve/publish 空 body 合法). */
async function readBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 元规则保护: worker 来源的元规则提案不得被批准/发布. */
function isWorkerMetaRule(proposal: ImprovementProposal): boolean {
  return isMetaRuleProposal(proposal) && proposal.created_by !== "human";
}

export function createProposalsRoutes(deps: ProposalsRoutesDeps): Hono {
  const app = new Hono();
  const { proposalStore, eventBus } = deps;

  /**
   * GET /api/proposals/:id — 详情 + history (05 阶段 3 验收 3: 全程账本可查).
   */
  app.get("/:id", (c) => {
    const proposal = proposalStore.get(c.req.param("id"));
    if (!proposal) {
      return c.json(
        { error: "proposal_not_found", message: "Proposal not found" },
        404,
      );
    }
    return c.json({
      proposal,
      history: proposalStore.getHistory(proposal.proposal_id),
    });
  });

  /**
   * POST /api/proposals/:id/approve — 人工批准 (03: 仅 shadow / canary 可
   * approve; 迁移表当前落地为 canary → approved, draft 缺 eval 证据不得
   * 跳过管线 → 409 invalid_transition).
   */
  app.post("/:id/approve", async (c) => {
    const proposalId = c.req.param("id");
    const proposal = proposalStore.get(proposalId);
    if (!proposal) {
      return c.json(
        { error: "proposal_not_found", message: "Proposal not found" },
        404,
      );
    }
    if (isWorkerMetaRule(proposal)) {
      return c.json(
        {
          error: "meta_rule_requires_human",
          message: `Proposal '${proposalId}' touches the release pipeline itself (type=${proposal.type}, target=${proposal.target}) and was created by the worker — 元规则变更仅人工发起并批准 (提案验证与发布.md)`,
        },
        403,
      );
    }
    const body = await readBody(c);
    try {
      const updated = await proposalStore.transitionStatus(
        proposalId,
        "approved",
        {
          by: "human",
          reason:
            typeof body.feedback === "string" && body.feedback.trim()
              ? body.feedback.trim()
              : "human approved via POST /api/proposals/:id/approve",
        },
      );
      return c.json({ proposal: updated }, 200);
    } catch (error) {
      if (error instanceof ProposalStoreError) {
        return c.json(
          { error: error.code, message: error.message },
          storeErrorStatus(error),
        );
      }
      throw error;
    }
  });

  /**
   * POST /api/proposals/:id/publish — 人工发布 (approved → published).
   * 仅人工: 必须带显式人类标记 { by: "human" }, 否则 403 (元规则).
   */
  app.post("/:id/publish", async (c) => {
    const proposalId = c.req.param("id");
    const proposal = proposalStore.get(proposalId);
    if (!proposal) {
      return c.json(
        { error: "proposal_not_found", message: "Proposal not found" },
        404,
      );
    }
    const body = await readBody(c);
    // publish 仅人工: 无显式人类标记一律 403 (worker / 无标记 / 其他值)
    if (body.by !== "human") {
      return c.json(
        {
          error: "human_required",
          message:
            'publish 仅人工: request body must carry an explicit human marker { "by": "human" } (03: publish 仅人工, 元规则)',
        },
        403,
      );
    }
    if (isWorkerMetaRule(proposal)) {
      return c.json(
        {
          error: "meta_rule_requires_human",
          message: `Proposal '${proposalId}' touches the release pipeline itself (type=${proposal.type}, target=${proposal.target}) and was created by the worker — 元规则变更仅人工发起并批准 (提案验证与发布.md)`,
        },
        403,
      );
    }
    try {
      const updated = await proposalStore.transitionStatus(
        proposalId,
        "published",
        {
          stage: "publish",
          by: "human",
          reason:
            typeof body.feedback === "string" && body.feedback.trim()
              ? body.feedback.trim()
              : "human published via POST /api/proposals/:id/publish",
        },
      );
      const publishedAt = new Date().toISOString();
      // 03 WS 契约 proposal-published (activity channel); loop_id 从
      // target 前缀 / canary 范围派生 (worker 提案 target=<loop_id>.<hint>)
      const loopId =
        updated.payload?.canary_loops?.[0] ??
        updated.target.split(".")[0] ??
        "";
      eventBus?.emit({
        type: "proposal-published",
        loop_id: loopId,
        proposal_id: updated.proposal_id,
        proposal_type: updated.type,
        from_status: "approved",
        to_status: "published",
        published_by: "human",
        published_at: publishedAt,
        timestamp: publishedAt,
      });
      return c.json({ proposal: updated }, 200);
    } catch (error) {
      if (error instanceof ProposalStoreError) {
        return c.json(
          { error: error.code, message: error.message },
          storeErrorStatus(error),
        );
      }
      throw error;
    }
  });

  /**
   * POST /api/proposals/:id/rollback — 回滚 (任意非终态 → rolled_back).
   * 本端点是对 03 的补充 (03 端点总表无 rollback; 05 阶段 3 验收 3 要求
   * 管线可回滚且账本可查)。版本记录保留: 文件与 history 不删, 同 target
   * 的旧 published 版本在装配层重新生效。
   */
  app.post("/:id/rollback", async (c) => {
    const proposalId = c.req.param("id");
    if (!proposalStore.get(proposalId)) {
      return c.json(
        { error: "proposal_not_found", message: "Proposal not found" },
        404,
      );
    }
    const body = await readBody(c);
    try {
      const updated = await proposalStore.rollback(proposalId, {
        by: "human",
        reason:
          typeof body.reason === "string" && body.reason.trim()
            ? body.reason.trim()
            : "human rollback via POST /api/proposals/:id/rollback",
      });
      return c.json({ proposal: updated }, 200);
    } catch (error) {
      if (error instanceof ProposalStoreError) {
        return c.json(
          { error: error.code, message: error.message },
          storeErrorStatus(error),
        );
      }
      throw error;
    }
  });

  return app;
}
