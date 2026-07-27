import type { LoopDecisionOption } from "../lib/activityBus.js";

/**
 * LoopApprovalCards 的纯展示/纯逻辑部分, 与组件本体分离以便在无浏览器
 * 环境下做 SSR 渲染测试 (同 FilePathLink.shared 的模式): 不依赖 i18n
 * context 与 activityBus 单例, 文案全部由调用方注入。
 */

/** 决策按钮的基础样式 (按选项着色)。 */
export function decisionButtonClass(option: LoopDecisionOption): string {
  switch (option) {
    case "approve":
      return "bg-[var(--primary)] text-[var(--on-primary)]";
    case "reject":
      return "bg-[var(--error-color)]/15 text-[var(--error-color)] border border-[var(--error-color)]/40";
    case "request_changes":
      return "bg-[var(--warning-color)]/15 text-[var(--warning-color)] border border-[var(--warning-color)]/40";
    case "pause":
      return "bg-[var(--bg-hover)] text-[var(--text-primary)] border border-[var(--border-color)]";
  }
}

/**
 * 事件的 recommended 值 → 需要视觉强调的决策按钮。manual_review 与未知
 * 值不映射到任何按钮 (返回 null, 不高亮) — 与控制面 recommendedDecision
 * 的口径对应: manual_review 表示"无可靠建议"。
 */
export function recommendedDecisionOption(
  recommended: string | undefined,
): LoopDecisionOption | null {
  switch (recommended) {
    case "approve":
    case "reject":
    case "request_changes":
    case "pause":
      return recommended;
    default:
      return null;
  }
}

/** 可折叠的工作区 diff 摘要块 (git diff --stat 文本)。 */
export function DiffSummaryBlock({
  label,
  summary,
}: {
  label: string;
  summary: string;
}) {
  return (
    <details className="mt-1 rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1.5">
      <summary className="cursor-pointer text-xs text-[var(--text-muted)]">
        {label}
      </summary>
      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-[var(--text-secondary)]">
        {summary}
      </pre>
    </details>
  );
}

/**
 * 决策按钮组。recommended 命中某个选项时该按钮加主色描边与"建议"徽标;
 * recommended 为 null (manual_review / 缺省) 时无任何高亮。
 */
export function DecisionButtons({
  options,
  labels,
  recommended,
  recommendedBadge,
  disabled,
  onSelect,
}: {
  options: LoopDecisionOption[];
  labels: Record<LoopDecisionOption, string>;
  recommended: LoopDecisionOption | null;
  recommendedBadge: string;
  disabled: boolean;
  onSelect: (option: LoopDecisionOption) => void;
}) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-2">
      {options.map((option) => {
        const isRecommended = option === recommended;
        return (
          <button
            key={option}
            type="button"
            data-recommended={isRecommended ? "true" : undefined}
            className={`rounded-md px-3 py-2.5 text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-50 ${decisionButtonClass(option)}${
              isRecommended ? " ring-2 ring-[var(--primary)]" : ""
            }`}
            disabled={disabled}
            onClick={() => onSelect(option)}
          >
            {labels[option]}
            {isRecommended && (
              <span className="ml-1.5 rounded-[var(--radius-sm)] border border-current px-1 py-px align-middle text-[10px] font-semibold uppercase">
                {recommendedBadge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
