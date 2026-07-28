/**
 * loop 详情页 workspace 策略标识 (docs/plans/loop-spec-gap-fix-plan.md
 * backlog "UI 提示"):
 * - worktree: 隔离副本徽章 —— 验证在隔离目录进行, 无需提示;
 * - direct (缺省策略): 徽章 + 一行提示 —— verifier 直接作用于原工作区,
 *   run 期间在同一目录大改代码会让验证结果失真 (2026-07-27 实证:
 *   run-20260727T150455Z-a40e562e turn 1 误判 failed)。
 * 纯展示组件 (无 hooks / 路由依赖), 抽出来供 node:test 静态渲染断言。
 */
export function WorkspaceStrategyBadge(props: {
  strategy: string;
  directHint: string;
}) {
  if (props.strategy === "worktree") {
    return (
      <>
        <span className="rounded-[var(--radius-sm)] bg-[var(--accent-rust)]/15 px-1.5 py-0.5 text-xs font-medium text-[var(--accent-rust)]">
          worktree
        </span>
        {" · "}
      </>
    );
  }
  return (
    <>
      <span
        className="rounded-[var(--radius-sm)] bg-[var(--warning-color)]/15 px-1.5 py-0.5 text-xs font-medium text-[var(--warning-color)]"
        title={props.directHint}
      >
        direct
      </span>
      {" · "}
      <span className="text-[var(--warning-color)]">{props.directHint}</span>
      {" · "}
    </>
  );
}
