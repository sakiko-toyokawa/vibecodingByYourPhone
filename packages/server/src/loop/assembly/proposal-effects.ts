/**
 * 装配消费已发布提案 (spec: docs/spec/05-分阶段计划.md 阶段 3 验收 5:
 * "提案发布后, 新 run 的装配 (memory packet / 策略) 确实使用新提案内容,
 * 且旧版本可回滚"; 覆盖表 runtime-input 行: "装配消费已发布提案").
 *
 * 生效规则 (按 loop_id 匹配):
 * - published: 全量生效 —— 对所有 loop 生效; payload.canary_loops 显式
 *   列出范围时仍按 loop_id 限定 (小范围语义可随发布保留)。
 * - canary: 小范围启用 —— 只对打了 canary 标记的 loop 生效:
 *   payload.canary_loops 命中, 或 target 以 `<loop_id>.` 为前缀 (worker
 *   生成的提案 target 本来就是 `<loop_id>.<hint>`)。
 * - draft / shadow / approved / rolled_back / rejected: 不消费 (shadow
 *   旁路不改装配; rolled_back 即回退)。
 *
 * 版本与回滚: 同一槽位 (memory packet 模板 / adapter policy /
 * policy profile) 可能有多份提案 —— 取最新 published (created_at 降序
 * 第一个); 最新版本 rolled_back 后, 旧的 published 版本自然重新生效
 * (回滚不删版本记录, 提案验证与发布.md 元规则保护 3)。
 */

import type { ImprovementProposal, ProposalStatus } from "@yep-anywhere/shared";

export interface AppliedProposal {
  proposal_id: string;
  status: ProposalStatus;
}

/** 装配层从生效提案解析出的覆盖内容 (全部可选; 无生效提案时全空). */
export interface ProposalEffects {
  /** 注入 prompt 的 memory packet 模板文本 */
  memoryPacketTemplate?: string;
  /** adapter 调用策略覆盖 (原样带上 RuntimeInput.adapterPolicy) */
  adapterPolicy?: Record<string, unknown>;
  /** 策略档名覆盖 (替换 resolvePolicyProfile 的 policy_profile) */
  policyProfileOverride?: string;
  /** 实际生效的提案 (审计/观测用) */
  applied: AppliedProposal[];
}

/** 提案是否对 loopId 生效 (见文件头生效规则). */
function appliesToLoop(proposal: ImprovementProposal, loopId: string): boolean {
  const canaryLoops = proposal.payload?.canary_loops;
  if (proposal.status === "published") {
    // 全量生效; 显式范围 (canary_loops) 随发布保留时仍按 loop_id 限定
    return canaryLoops?.length ? canaryLoops.includes(loopId) : true;
  }
  if (proposal.status === "canary") {
    return (
      canaryLoops?.includes(loopId) === true ||
      proposal.target.startsWith(`${loopId}.`)
    );
  }
  return false;
}

/**
 * 解析 loopId 的生效提案内容。槽位按提案类型取用 payload 字段, 每槽位
 * 取最新一份 (created_at 降序); rolled_back 的最新版本被过滤后旧
 * published 版本自动回补。
 */
export function resolveProposalEffects(
  loopId: string,
  proposals: ImprovementProposal[],
): ProposalEffects {
  const applicable = proposals
    .filter((proposal) => appliesToLoop(proposal, loopId))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  const effects: ProposalEffects = { applied: [] };
  for (const proposal of applicable) {
    const payload = proposal.payload;
    if (!payload) {
      continue;
    }
    let used = false;
    if (
      proposal.type === "memory_packet_template_proposal" &&
      payload.memory_packet_template !== undefined &&
      effects.memoryPacketTemplate === undefined
    ) {
      effects.memoryPacketTemplate = payload.memory_packet_template;
      used = true;
    }
    if (
      proposal.type === "runtime_adapter_proposal" &&
      payload.adapter_policy !== undefined &&
      effects.adapterPolicy === undefined
    ) {
      effects.adapterPolicy = payload.adapter_policy;
      used = true;
    }
    if (
      proposal.type === "policy_profile_proposal" &&
      payload.policy_profile !== undefined &&
      effects.policyProfileOverride === undefined
    ) {
      effects.policyProfileOverride = payload.policy_profile;
      used = true;
    }
    if (used) {
      effects.applied.push({
        proposal_id: proposal.proposal_id,
        status: proposal.status,
      });
    }
  }
  return effects;
}
