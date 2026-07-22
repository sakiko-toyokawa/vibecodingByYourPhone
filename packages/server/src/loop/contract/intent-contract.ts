/**
 * Intent contract construction (spec: docs/spec/02-schema契约.md §2,
 * 05-分阶段计划.md 阶段 2 "合约加停止规则与预算字段的完整校验").
 *
 * Builds a v1 IntentContract from a LoopCard. Budget validation (phase 2):
 * - stop_rules → budget 投影：max_turns / max_time_minutes / max_retries
 *   照抄 LoopCard.stop_rules（预算与停止规则.md: stop_rules 中的同名字段是
 *   budget 向执行侧的投影，不得另立数值）。LoopCardSchema 已强制 stop_rules
 *   必填并带 max_retries < max_turns 的 refine，contract 层再用共享
 *   BudgetSchema 复核（缺省 / 非法值在 API 层已被 400 拒绝，这里是构造期
 *   兜底，违例抛 ContractValidationError）。
 * - max_turns 必须 >= 1（含首轮——首轮都跑不了的合约无意义）、
 *   max_retries 必须 >= 0、max_time_minutes 必须 > 0。
 * - max_tokens：LoopCard 没有 token 预算来源，写 0 = "不跟踪"（不参与
 *   停止判定）；这是明确默认值，不是缺省拒绝。
 *
 * Other phase-0 simplifications still in effect:
 * - no clarification / ambiguity flow (requires_clarification = false)
 * - the contract is validated against IntentContractSchema before use and
 *   snapshotted to the run's artifacts by the run service
 */

import {
  type BudgetLimits,
  BudgetSchema,
  type IntentContract,
  IntentContractSchema,
  type LoopCard,
} from "@yep-anywhere/shared";

export type ContractSource = "cron" | "manual";

/** stop_rules / budget 校验失败（构造期兜底；正常路径 API 层已 400）。 */
export class ContractValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractValidationError";
  }
}

/**
 * Project LoopCard.stop_rules into the contract's budget (数值权威来源是
 * budget, 02 §2) with full validation. Returns the validated budget limits.
 */
export function buildBudgetLimits(card: LoopCard): BudgetLimits {
  const rules = card.loop.stop_rules;
  if (rules.max_turns < 1) {
    throw new ContractValidationError(
      `Loop '${card.loop.id}' stop_rules.max_turns must be >= 1 (max_turns 含首轮——首轮必须能跑)`,
    );
  }
  if (rules.max_retries < 0) {
    throw new ContractValidationError(
      `Loop '${card.loop.id}' stop_rules.max_retries must be >= 0 (max_retries 不含首轮)`,
    );
  }
  if (rules.max_time_minutes <= 0) {
    throw new ContractValidationError(
      `Loop '${card.loop.id}' stop_rules.max_time_minutes must be > 0`,
    );
  }
  // 复核 LoopCard refine（max_retries < max_turns）；used_* 缺省 0。
  // max_tokens = 0 = 不跟踪（LoopCard 无 token 预算来源，明确默认值）。
  const budget = BudgetSchema.parse({
    max_tokens: 0,
    max_time_minutes: rules.max_time_minutes,
    max_turns: rules.max_turns,
    max_retries: rules.max_retries,
  });
  return {
    max_tokens: budget.max_tokens,
    max_time_minutes: budget.max_time_minutes,
    max_turns: budget.max_turns,
    max_retries: budget.max_retries,
  };
}

export function buildIntentContract(
  card: LoopCard,
  options: { runId: string; source: ContractSource },
): IntentContract {
  const loop = card.loop;
  const discovery = loop.discovery ?? {};
  const handoff = loop.handoff ?? {};

  const rawGoal = [
    `Loop '${loop.id}' read-only scan`,
    discovery.source ? `source=${discovery.source}` : null,
    discovery.query ? `query=${discovery.query}` : null,
  ]
    .filter(Boolean)
    .join("; ");

  const constraints: string[] = ["read_only"];
  if (handoff.max_items_per_run !== undefined) {
    constraints.push(`max_items_per_run=${handoff.max_items_per_run}`);
  }

  return IntentContractSchema.parse({
    intent_id: `intent-${options.runId}`,
    source: options.source === "cron" ? "cron" : "ui",
    raw_goal: rawGoal,
    task_type: {
      primary: handoff.default_task_type ?? "read_only_report",
      confidence: 1,
      requires_clarification: false,
    },
    outcome:
      "一份只读扫描报告：列出发现与建议，不对工作区做任何修改（报告即结果，无验证层）",
    success_criteria: ["只读扫描完成并产出报告文本", "工作区未产生任何写改动"],
    constraints,
    budget: buildBudgetLimits(card),
  });
}
