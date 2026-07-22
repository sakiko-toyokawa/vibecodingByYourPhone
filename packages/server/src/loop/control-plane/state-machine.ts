/**
 * Run 状态机 — 7 态确定性转移表。
 * 权威定义：loop-engineering/control-plane/状态机.md 与
 * docs/spec/02-schema契约.md §7 的状态迁移表（两处一致）。
 *
 * 职责边界（状态机.md）：状态机只负责"走哪条路"——本模块是纯表 +
 * 合法性守卫，不做风险分级、不解释 bypass 规则、不审批。
 *
 * 转移表逐条对应 02 §7：
 *   active         → complete          judgment_report.overall == passed
 *   active         → retry             overall == failed 且可重试
 *   active         → needs_human       judgment_report.next_action == needs_human
 *   active         → failed            不可恢复错误
 *   active         → budget_limited    预算耗尽
 *   active         → paused            人工主动暂停
 *   retry          → active            生成新上下文或沿用当前上下文继续
 *   needs_human    → active            人类批准或补充上下文（恢复须携带人工响应）
 *   needs_human    → failed            人类拒绝
 *   needs_human    → paused            人工 pause 决策（03 迁移表）
 *   paused         → active            收到恢复信号
 *   budget_limited → active            人工补充预算并恢复
 *   complete       → (exit，无出边)
 *   failed         → (exit，无出边)
 */

import type { RunState } from "@yep-anywhere/shared";

/** 合法出边表；complete / failed 是终态（exit，无出边）。 */
export const RUN_STATE_TRANSITIONS: Readonly<
  Record<RunState, readonly RunState[]>
> = {
  active: [
    "complete",
    "retry",
    "needs_human",
    "paused",
    "failed",
    "budget_limited",
  ],
  retry: ["active"],
  needs_human: ["active", "failed", "paused"],
  paused: ["active"],
  budget_limited: ["active"],
  complete: [],
  failed: [],
};

export function isLegalTransition(from: RunState, to: RunState): boolean {
  return RUN_STATE_TRANSITIONS[from].includes(to);
}

/**
 * 非法转移：拒绝并记录。记录方式是带结构化上下文的 error 日志（决策账本
 * 只落合法转移，非法转移不产生账本条目——它不是一次决策，是一次被拦截
 * 的违规）；调用方把错误向上抛（API 层映射为 409 invalid_state）。
 */
export function assertLegalTransition(
  from: RunState,
  to: RunState,
  context: { runId: string; turn: number },
): void {
  if (!isLegalTransition(from, to)) {
    console.error(
      `[ControlPlane] illegal transition rejected: run=${context.runId} turn=${context.turn} ${from} -> ${to}`,
    );
    throw new IllegalTransitionError(from, to, context);
  }
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: RunState,
    readonly to: RunState,
    readonly context: { runId: string; turn: number },
  ) {
    super(
      `illegal run-state transition: ${from} -> ${to} (run ${context.runId}, turn ${context.turn})`,
    );
    this.name = "IllegalTransitionError";
  }
}
