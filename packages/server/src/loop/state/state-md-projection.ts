/**
 * .loop/STATE.md 人可读投影 (04-存储约定.md: 项目仓库内布局)。
 *
 * 口径钉死:
 * - 事实源在 ~/.yep-anywhere/loops/ (run_state / decision 账本), 本文件
 *   只是给人看的人可读投影 —— 读它不改变任何行为, 写它失败绝不影响
 *   run 主链路 (projectStateMd 内部捕获一切错误, 只 console.warn)。
 * - 单写者: control-plane 的状态迁移 (control-plane.ts transition) 是
 *   唯一调用方; 每次迁移后整体重写。
 * - 并发写不加锁: 靠"每次全量重写 + 最后一次赢"。STATE.md 是最终一致
 *   的展示面, 短暂旧值无害, 下一次迁移会覆盖。
 * - worktree 策略下 run 执行在 worktree, 但投影写**原 workspace**
 *   (card.loop.workspace.path 即原仓库路径) —— 04 口径是"项目仓库内
 *   布局", 让人在原仓库就能看到状态。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Budget, RunState } from "@yep-anywhere/shared";

/** 投影所需的 run 状态快照 (取自迁移后的 RunStateRecord)。 */
export interface StateMdSnapshot {
  loopId: string;
  runId: string;
  state: RunState;
  turn: number;
  /** 预算快照; 首轮在飞被暂停等场景可能尚无预算 (null)。 */
  budget: Budget | null;
  sessionRef: string | null;
  updatedAt: string;
}

export interface ProjectStateMdOptions {
  /** 原仓库工作区路径 (card.loop.workspace.path)。 */
  workspacePath: string;
  /**
   * card.persistence.state_file 的值 (示例 ".loop/STATE.md")。相对路径
   * resolve 到 workspacePath; 空值、或 resolve 后逃逸出 workspace 的
   * 绝对/相对路径 (如 "../x.md") 跳过并 warn —— 投影不得写出仓库外。
   */
  stateFile: string;
  snapshot: StateMdSnapshot;
}

function budgetLine(label: string, used: number, max: number): string {
  return `| ${label} | ${used} | ${max} |`;
}

function renderStateMd(snapshot: StateMdSnapshot): string {
  const lines: string[] = [
    `# Loop State: ${snapshot.loopId}`,
    "",
    "<!-- 人可读投影: 事实源在 ~/.yep-anywhere/loops/, 本文件由 control-plane 状态迁移时整体重写, 请勿手改。 -->",
    "",
    `- **loop_id**: ${snapshot.loopId}`,
    `- **run_id**: ${snapshot.runId}`,
    `- **state**: ${snapshot.state}`,
    `- **turn**: ${snapshot.turn}`,
    `- **session_ref**: ${snapshot.sessionRef ?? "none"}`,
    `- **updated_at**: ${snapshot.updatedAt}`,
    "",
  ];
  if (snapshot.budget) {
    const b = snapshot.budget;
    lines.push(
      "## Budget",
      "",
      "| field | used | max |",
      "| --- | --- | --- |",
      budgetLine("turns", b.used_turns, b.max_turns),
      budgetLine("retries", b.used_retries, b.max_retries),
      budgetLine("tokens", b.used_tokens, b.max_tokens),
      budgetLine("time_minutes", b.used_time_minutes, b.max_time_minutes),
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 把 <workspacePath>/<stateFile> 整体重写为当前 run 状态的人可读
 * markdown。幂等 (每次全量重写); 目录不存在先 mkdir -p。
 *
 * 绝不抛: 任何失败 (路径非法、IO 错误) 只 console.warn —— 投影不是
 * 事实源, 不得影响主链路。
 */
export async function projectStateMd(
  opts: ProjectStateMdOptions,
): Promise<void> {
  try {
    const stateFile = opts.stateFile.trim();
    if (!stateFile) {
      console.warn(
        `[StateMdProjection] loop '${opts.snapshot.loopId}': persistence.state_file 为空, 跳过投影`,
      );
      return;
    }
    const workspaceRoot = path.resolve(opts.workspacePath);
    const target = path.resolve(workspaceRoot, stateFile);
    // 逃逸守卫: resolve 后必须仍在 workspace 内 (相对路径 ../ 或指向
    // 别处的绝对路径都会被这里拦下)。
    if (
      target !== workspaceRoot &&
      !target.startsWith(workspaceRoot + path.sep)
    ) {
      console.warn(
        `[StateMdProjection] loop '${opts.snapshot.loopId}': state_file '${opts.stateFile}' 逃逸出 workspace '${opts.workspacePath}', 跳过投影`,
      );
      return;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, renderStateMd(opts.snapshot), "utf-8");
  } catch (error) {
    console.warn(
      `[StateMdProjection] loop '${opts.snapshot.loopId}' STATE.md 投影失败 (不影响主链路):`,
      error,
    );
  }
}
