/**
 * 提案发布管线 (spec: docs/spec/05-分阶段计划.md 阶段 3 "发布管线:
 * shadow → regression → canary → publish 四档推进与回滚; 元规则（管线
 * 自身修改）只能人工发起并批准"; loop-engineering/loop-state-and-learning/
 * 提案验证与发布.md).
 *
 * 状态机 (持久化状态走 proposal-store 迁移表; regression 是 shadow→canary
 * 之间的验证档, 记 history.stage, 不是持久化状态):
 *
 * ```text
 *                 worker 自动推进 (advanceEligible)         人工闸门 (HTTP)
 *
 *   draft ──shadow 档──▶ shadow ──regression 档──▶ canary ──approve──▶ approved
 *                         │ 旁路评估记录            │ 复跑 eval 集        │
 *                         │ (不改装配)              ├ 全过 → canary       ▼
 *                         │                         └ 任一失败 → rolled_back
 *   任意档 ──rollback──▶ rolled_back (保留版本记录, 旧 published 版本仍生效)
 *   draft/shadow/canary ──rejected (终态)
 * ```
 *
 * 档位语义:
 * - shadow: 旁路评估 —— 复跑 eval 集落一份 mode=shadow 的 scorecard 作为
 *   "若启用会如何" 的评估记录, 装配不消费 shadow 提案 (不改装配)。
 * - regression: 调 eval-runner 复跑最小集, 全部通过 → canary; 任一失败 →
 *   rolled_back, scorecard 引用写进 history reason (可审计)。提案关联
 *   loop 的 card 声明了 eval.regression_scope 时, 复跑范围按该白名单
 *   过滤 (见 advanceOne)。
 * - canary: 小范围启用 —— 装配层只对打了 canary 标记的 loop 生效 (按
 *   loop_id 匹配, 见 assembly/proposal-effects.ts)。
 * - approved → published: 全量生效。**两个人工闸门不在本服务内** ——
 *   advanceEligible 推进到 canary 为止 (03 决策二: worker 只推进
 *   draft→shadow→canary); approve/publish 只有 routes/proposals.ts 的
 *   HTTP 端点, worker 无任何自动路径。
 *
 * 元规则保护 (提案验证与发布.md 三条, 阶段 3 验收 4):
 * 1. 人工发起: type 或 target 涉及发布管线自身 (验证要求/状态机/发布路径,
 *    实现为 isMetaRuleProposal) 的提案, 只有 created_by=human 才能进入
 *    管线 —— advanceEligible 拒绝推进 worker 来源的此类提案 (停在 draft,
 *    记日志)。approve/publish 端点对 worker 来源的元规则提案一律 403
 *    (routes/proposals.ts)。
 * 2. 不得降低验证强度: regression 档 fail-closed —— eval 集缺失/损坏/
 *    任一 case 不符预期都不得进 canary (没有 "跳过验证" 的推进路径)。
 * 3. 版本记录保留: 每次档位推进/回滚落提案 history 并持久化 scorecard;
 *    rolled_back 不删文件, 同 target 的旧 published 版本在装配层重新生效
 *    (assembly/proposal-effects.ts 取最新 published)。
 */

import type {
  ImprovementProposal,
  ProposalCreatedBy,
  ProposalType,
} from "@yep-anywhere/shared";
import type { LoopCardStore } from "../state/loop-card-store.js";
import type { ProposalStore } from "../state/proposal-store.js";
import type { EvalRunner, EvalScorecard } from "./eval-runner.js";

/**
 * 元规则提案判定: 修改对象是发布管线/验证层自身。
 * - 类型上: verification_rule_proposal (verifier rubric) 与
 *   eval_task_proposal (eval 基准) 是"尺子"本身的变更 (提案验证与发布.md
 *   验证层自身行: "尺子不能用尺子自己量");
 * - target 上: 命中 pipeline / eval / verifier 段的 (覆盖管线状态机与发布
 *   路径配置, 如 release_pipeline.stages)。loop id 恰好以这些词开头时
 *   会保守误判为元规则 —— 方向是更多人 Gate, 可接受 (fail-safe)。
 */
const META_RULE_TYPES: ReadonlySet<ProposalType> = new Set([
  "verification_rule_proposal",
  "eval_task_proposal",
]);
const META_RULE_TARGET = /(^|[._-])(pipeline|eval|verifier)([._-]|$)/i;

export function isMetaRuleProposal(proposal: ImprovementProposal): boolean {
  return (
    META_RULE_TYPES.has(proposal.type) || META_RULE_TARGET.test(proposal.target)
  );
}

export interface ProposalPipelineDeps {
  proposalStore: ProposalStore;
  evalRunner: EvalRunner;
  /** regression 档按提案 target 关联 loop 读 card (eval.regression_scope 消费) */
  loopCardStore: LoopCardStore;
}

/** 格式化 scorecard.applied 供提案 history 引用 (评估了什么可审计). */
function formatApplied(applied: EvalScorecard["applied"]): string {
  if (!applied) {
    return "applied: none (no proposal payload evaluated)";
  }
  const parts = [
    `applied: ${applied.slots.length > 0 ? applied.slots.join(", ") : "none"}`,
  ];
  if (applied.skipped.length > 0) {
    parts.push(
      `skipped: ${applied.skipped.map((s) => `${s.slot} (${s.reason})`).join(", ")}`,
    );
  }
  return parts.join("; ");
}

export class ProposalPipeline {
  private readonly deps: ProposalPipelineDeps;
  /** worker 来源的元规则提案只告警一次 (worker 每 tick 都会调 advanceEligible) */
  private readonly metaRuleBlocked = new Set<string>();

  constructor(deps: ProposalPipelineDeps) {
    this.deps = deps;
  }

  /**
   * worker 驱动的自动推进: 把所有可推进的提案向前走一档 (draft→shadow,
   * shadow→regression→canary/rolled_back)。单个提案的失败只记日志,
   * 不阻塞其他提案; 推进到 canary 为止 —— approved/published 无自动路径。
   */
  async advanceEligible(): Promise<void> {
    for (const proposal of this.deps.proposalStore.listProposals()) {
      if (proposal.status !== "draft" && proposal.status !== "shadow") {
        continue;
      }
      // 元规则保护 1: worker 来源的元规则提案不得进入管线 (停在 draft)
      if (isMetaRuleProposal(proposal) && proposal.created_by !== "human") {
        if (!this.metaRuleBlocked.has(proposal.proposal_id)) {
          this.metaRuleBlocked.add(proposal.proposal_id);
          console.warn(
            `[ProposalPipeline] 元规则保护: 提案 '${proposal.proposal_id}' (type=${proposal.type}, target=${proposal.target}) 涉及发布管线自身且 created_by=worker, 拒绝进入管线 (仅人工发起的元规则变更可推进)`,
          );
        }
        continue;
      }
      try {
        await this.advanceOne(proposal);
      } catch (error) {
        console.error(
          `[ProposalPipeline] failed to advance proposal '${proposal.proposal_id}' (${proposal.status}):`,
          error,
        );
      }
    }
  }

  /** 推进单个提案一档 (draft→shadow 旁路评估; shadow→regression 闸门). */
  private async advanceOne(proposal: ImprovementProposal): Promise<void> {
    if (proposal.status === "draft") {
      // shadow 档: 旁路评估 —— 复跑 eval 集并真实应用提案 payload
      // (behavior case) 作为 "若启用会如何" 的观察记录, 不作为放行判据,
      // 装配也不消费 shadow 提案 (不改装配)。
      const scorecard = await this.deps.evalRunner.run({
        mode: "shadow",
        proposalId: proposal.proposal_id,
        proposal,
      });
      await this.deps.proposalStore.transitionStatus(
        proposal.proposal_id,
        "shadow",
        {
          stage: "shadow",
          by: "worker",
          reason: `shadow 旁路评估记录 eval/results/${scorecard.scorecard_id}.json (${scorecard.passed}/${scorecard.total} 符合预期); 不改装配; ${formatApplied(scorecard.applied)}`,
        },
      );
      return;
    }
    // shadow → regression 档: eval 最小集复跑是发布闸门, 全过才放行。
    // LoopCard eval.regression_scope 消费 (spec 02 §1): 提案 target 形态
    // 是 "<loop_id>.<槽位>" (worker buildProposal 拼装; 无关联 loop 时
    // 仅槽位名), 取首段作 loop id 经 LoopCardStore 读 card; card 声明了
    // 非空 regression_scope 时作为 case id 白名单传给 eval-runner ——
    // 只复跑该 loop 关心的 case (过滤口径与 fail-closed 语义见
    // eval-runner run 的 scope 注释)。无 card 或未声明 → 不传 scope,
    // 全量复跑 (现状行为不变)。
    const loopId = proposal.target.split(".")[0];
    const regressionScope = loopId
      ? this.deps.loopCardStore.getLoop(loopId)?.card.loop.eval
          ?.regression_scope
      : undefined;
    let scorecard: EvalScorecard;
    try {
      scorecard = await this.deps.evalRunner.run({
        mode: "regression",
        proposalId: proposal.proposal_id,
        proposal,
        ...(regressionScope && regressionScope.length > 0
          ? { scope: regressionScope }
          : {}),
      });
    } catch (error) {
      // fail-closed (元规则保护 2): eval 集缺失/损坏视为闸门不通过
      await this.deps.proposalStore.rollback(proposal.proposal_id, {
        stage: "regression",
        by: "worker",
        reason: `regression 无法执行 (eval 集不可用), fail-closed 回滚: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    // scope 白名单参与时如实写进 history (命中/未知 id 可审计; 0 命中即
    // fail-closed 不通过的原因也由此可见)
    const scopeInfo = scorecard.scope
      ? `; regression_scope 白名单: 请求 ${scorecard.scope.requested.length} 命中 ${scorecard.scope.matched.length}${scorecard.scope.unknown_ids.length > 0 ? `, 未知 id: ${scorecard.scope.unknown_ids.join(", ")}` : ""}`
      : "";
    if (scorecard.ok) {
      await this.deps.proposalStore.transitionStatus(
        proposal.proposal_id,
        "canary",
        {
          stage: "regression",
          by: "worker",
          reason: `regression 通过 (${scorecard.passed}/${scorecard.total}): scorecard eval/results/${scorecard.scorecard_id}.json; ${formatApplied(scorecard.applied)}${scopeInfo}`,
        },
      );
    } else {
      const failedCases = scorecard.results
        .filter((r) => !r.ok)
        .map((r) => `${r.case_id}(expect=${r.expect},actual=${r.actual})`)
        .join(", ");
      await this.deps.proposalStore.rollback(proposal.proposal_id, {
        stage: "regression",
        by: "worker",
        reason: `regression 未通过 (${scorecard.failed}/${scorecard.total} 失败: ${failedCases}): scorecard eval/results/${scorecard.scorecard_id}.json${scopeInfo}`,
      });
    }
  }

  /**
   * 回滚: 任意非终态 → rolled_back, 保留版本记录 (文件与 history 不删;
   * 同 target 的旧 published 版本在装配层重新生效)。API 回滚默认记
   * by=human; 管线内部失败回滚显式传 by=worker。
   */
  async rollback(
    proposalId: string,
    options: { by?: ProposalCreatedBy; reason?: string } = {},
  ): Promise<ImprovementProposal> {
    return this.deps.proposalStore.rollback(proposalId, {
      by: options.by ?? "human",
      reason: options.reason,
    });
  }
}
