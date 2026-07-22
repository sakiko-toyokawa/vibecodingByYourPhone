/**
 * Phase-0 intent contract construction (spec: docs/spec/02-schema契约.md §2,
 * 05-分阶段计划.md 阶段 0 "简化 IntentContract").
 *
 * Builds a v1 IntentContract from a LoopCard. Phase-0 simplifications:
 * - no clarification / ambiguity flow (requires_clarification = false)
 * - budget fields are transcribed from card.stop_rules but NOT enforced
 *   (05: "无 budget 强制"); max_tokens has no source in the LoopCard and is
 *   recorded as 0 = "untracked"
 * - the contract is validated against IntentContractSchema before use and
 *   snapshotted to the run's artifacts by the run service
 */

import {
  type IntentContract,
  IntentContractSchema,
  type LoopCard,
} from "@yep-anywhere/shared";

export type ContractSource = "cron" | "manual";

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
    budget: {
      // Phase 0: budget is recorded, not enforced. The LoopCard carries no
      // token budget — 0 means "untracked", not "zero allowed".
      max_tokens: 0,
      max_time_minutes: loop.stop_rules.max_time_minutes,
      max_turns: loop.stop_rules.max_turns,
      max_retries: loop.stop_rules.max_retries,
    },
  });
}
