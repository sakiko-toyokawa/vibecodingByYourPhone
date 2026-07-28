/**
 * direct 策略验证期间的工作区稳定性标注 (docs/plans/
 * loop-spec-gap-fix-plan.md backlog "过渡方案 (更便宜)")。
 *
 * 背景: direct 策略下 verifier (static/runtime 子进程) 直接对原工作区
 * 跑命令; 用户/其他进程在验证期间改动同一目录时, 验证读到的不是 run
 * 产出的状态, 失败判定可能是环境噪音而非代码问题 (2026-07-27 实证:
 * run-20260727T150455Z-a40e562e turn 1 撞上开发者编辑中间态误判
 * failed)。worktree 策略已用隔离根治该问题, 本机制是 direct 策略的
 * 廉价兜底: 验证前后各取一次 git 快照比对, 有变动且本轮未判过时在
 * judgment evidence 里标注, 供人工分辨真失败与环境噪音。
 *
 * 口径钉死 (与 B3 required_artifacts 标注同款):
 * - 只标注, 不改 verdict 语义 (不降级、不升级 needs_human);
 * - 只在验证未通过时标注 —— 失真风险只在失败判定时影响判断, 通过的
 *   结果标注是纯噪音;
 * - 非 git 工作区 / git 不可用 → 快照为 null, 整个机制跳过, 不报错。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 追加进 judgment evidence 的标注: 标签前缀 + 一句人读说明 (参照
 * `missing_required_artifact:<name>` 的单字符串形态)。
 */
export const WORKSPACE_UNSTABLE_ANNOTATION =
  "workspace_unstable_during_verification: workspace changed while the verifier ran (HEAD or git status differs); a non-passed verdict may be environment noise rather than the run's own output";

/** 验证前/后的工作区快照: HEAD 提交 + porcelain 状态文本。 */
export interface WorkspaceSnapshot {
  head: string;
  status: string;
}

/**
 * 取工作区 git 快照 (rev-parse HEAD + status --porcelain)。与
 * captureGitDiff 同口径: 非 git 仓库 / git 不可用 / 命令超时返回
 * null, 不伪造、不抛错 —— 该机制是辅助标注, 失败即跳过。
 */
export async function captureWorkspaceSnapshot(
  workspacePath: string,
): Promise<WorkspaceSnapshot | null> {
  try {
    const [headResult, statusResult] = await Promise.all([
      execFileAsync("git", ["-C", workspacePath, "rev-parse", "HEAD"], {
        timeout: 30_000,
      }),
      execFileAsync("git", ["-C", workspacePath, "status", "--porcelain"], {
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      }),
    ]);
    return {
      head: headResult.stdout.trim(),
      status: statusResult.stdout,
    };
  } catch {
    return null;
  }
}

/** 两次快照是否不同: HEAD 移动或工作区/暂存区状态变化都算变动。 */
export function workspaceSnapshotChanged(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): boolean {
  return before.head !== after.head || before.status !== after.status;
}
