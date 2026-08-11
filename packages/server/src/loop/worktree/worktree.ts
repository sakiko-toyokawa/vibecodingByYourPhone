/**
 * Run 级 git worktree 隔离（LoopCard workspace.strategy: "worktree"）。
 *
 * worktree 目录集中在 <dataDir>/worktrees/<loop_id>/<run_id> —— 不放在
 * 被测仓库内（避免污染主 checkout 的 git status），与 loops 存储同根
 * 便于统一清理（06 偏差登记）。同一 run 的所有 turn（含 retry）复用同
 * 一目录：路径按 run_id 确定，目录已存在即复用；进程重启后目录仍在磁
 * 盘上，rebuildContext 走同一路径天然恢复。
 *
 * worktree 从主仓库 HEAD 拉取 —— 主 checkout 的未提交改动对 loop 不可
 * 见（稳定基线，是特性不是缺陷）。合并回主目录是人工动作（硬闸门语
 * 义），本模块只管创建/复用/清理。
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { AssemblyError } from "../assembly/runtime-input.js";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_AGE_DAYS = 7;

/** 与 RunLedgerStore 同口径的默认数据目录 (~/.yep-anywhere)。 */
function defaultDataDir(): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".yep-anywhere",
  );
}

export interface RunWorktree {
  /** worktree 目录（run 的执行/验证 cwd） */
  path: string;
  /** 分支名 loop/<run_id> */
  branch: string;
  /** 拉取 worktree 时主仓库的 HEAD */
  baseSha: string;
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

/** 一个 run 的 worktree 目录（集中存储约定，见文件头）。 */
export function runWorktreeDir(
  dataDir: string,
  loopId: string,
  runId: string,
): string {
  return path.join(dataDir, "worktrees", loopId, runId);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** repoPath 是否是 git 工作区（创建期校验与 ensure 共用）。 */
export async function isGitWorkTree(repoPath: string): Promise<boolean> {
  const inside = await git([
    "-C",
    repoPath,
    "rev-parse",
    "--is-inside-work-tree",
  ]).catch(() => null);
  return inside === "true";
}

/**
 * 创建（或复用）一个 run 的隔离 worktree。repoPath 必须是 git 工作区，
 * 否则 AssemblyError —— fail-closed：卡片声明了隔离就不能静默降级为
 * direct（setup 失败落 failed + 原因可审计）。
 */
export async function ensureRunWorktree(opts: {
  repoPath: string;
  loopId: string;
  runId: string;
  dataDir: string;
}): Promise<RunWorktree> {
  const { repoPath, loopId, runId, dataDir } = opts;
  if (!(await isGitWorkTree(repoPath))) {
    throw new AssemblyError(
      `Loop '${loopId}' workspace.strategy is worktree but '${repoPath}' is not a git work tree`,
    );
  }
  const branch = `loop/${runId}`;
  const dir = runWorktreeDir(dataDir, loopId, runId);
  const baseSha = await git(["-C", repoPath, "rev-parse", "HEAD"]);

  // 复用：同一 run 的后续 turn、以及进程重启后 rebuildContext 的重建。
  if (await exists(dir)) {
    return { path: dir, branch, baseSha };
  }

  await fs.mkdir(path.dirname(dir), { recursive: true });
  try {
    await git(["-C", repoPath, "worktree", "add", dir, "-b", branch]);
  } catch (error) {
    // 分支残留（目录被外部删除但 loop/<run_id> 分支还在）：挂载既有分支。
    if (!/already exists/.test(String(error))) {
      throw error;
    }
    await git(["-C", repoPath, "worktree", "add", dir, branch]);
  }
  return { path: dir, branch, baseSha };
}

/** worktree 相对基线是否有改动（未提交变更或 loop 分支上的新提交）。 */
export async function worktreeHasChanges(
  worktreePath: string,
  baseSha: string,
): Promise<boolean> {
  const status = await git(["-C", worktreePath, "status", "--porcelain"]);
  if (status.length > 0) {
    return true;
  }
  const count = await git([
    "-C",
    worktreePath,
    "rev-list",
    `${baseSha}..HEAD`,
    "--count",
  ]);
  return count !== "0";
}

/**
 * Remove one run's worktree and its loop branch. Used by the discard flow;
 * unlike pruneStaleWorktrees this is an immediate, targeted cleanup.
 */
export async function discardRunWorktree(opts: {
  dataDir: string;
  loopId: string;
  runId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const dir = runWorktreeDir(opts.dataDir, opts.loopId, opts.runId);
  if (!(await exists(dir))) {
    return { ok: true };
  }
  try {
    const commonDir = await git([
      "-C",
      dir,
      "rev-parse",
      "--git-common-dir",
    ]).catch(() => null);
    if (!commonDir) {
      await fs.rm(dir, { recursive: true, force: true });
      return { ok: true };
    }
    const repoPath = path.dirname(path.resolve(dir, commonDir));
    await git(["-C", repoPath, "worktree", "remove", "--force", dir]);
    await git(["-C", repoPath, "branch", "-D", `loop/${opts.runId}`]).catch(
      () => {},
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 合并闸门批准后执行合并：worktree 的未提交改动先落到 loop 分支
 * （executor 只写文件不提交是常态；commit 身份用 loop 专用，不依赖
 * 仓库的 user 配置），然后在原仓库 merge --no-ff。冲突时 abort 并抛
 * 错 —— worktree 与分支保留供人工处理。
 */
export async function mergeRunWorktree(opts: {
  worktreePath: string;
  originPath: string;
  branch: string;
  runId: string;
}): Promise<{ mergeCommitSha: string }> {
  const { worktreePath, originPath, branch, runId } = opts;
  const status = await git(["-C", worktreePath, "status", "--porcelain"]);
  if (status.length > 0) {
    await git(["-C", worktreePath, "add", "-A"]);
    await git([
      "-c",
      "user.name=yep-loop",
      "-c",
      "user.email=loop@yep-anywhere",
      "-C",
      worktreePath,
      "commit",
      "-m",
      `loop run ${runId}: worktree changes`,
    ]);
  }
  try {
    await git([
      "-C",
      originPath,
      "merge",
      "--no-ff",
      branch,
      "-m",
      `Merge loop run ${runId} (worktree)`,
    ]);
  } catch (error) {
    await git(["-C", originPath, "merge", "--abort"]).catch(() => {});
    throw error;
  }
  const mergeCommitSha = await git(["-C", originPath, "rev-parse", "HEAD"]);
  return { mergeCommitSha };
}

/**
 * 04 容量与清理：清理超过 maxAgeDays（默认 7 天）未动的 run worktree
 * （目录 + loop/<run_id> 分支）。单条失败仅 warn 不中断；返回清理数量。
 * protectedRunIds 命中的 run（活跃/阻塞态，恢复依赖 worktree）跳过且
 * 不计入 pruned —— 调用方从 run_state 扫描装配（04: 不动任何当前活跃
 * run 引用的对象）。
 */
export async function pruneStaleWorktrees(opts: {
  dataDir?: string;
  maxAgeDays?: number;
  protectedRunIds?: ReadonlySet<string>;
}): Promise<number> {
  const root = path.join(opts.dataDir ?? defaultDataDir(), "worktrees");
  const cutoff =
    Date.now() - (opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 86_400_000;
  let pruned = 0;
  let loopIds: string[];
  try {
    loopIds = await fs.readdir(root);
  } catch {
    return 0; // 尚无 worktrees 目录
  }
  for (const loopId of loopIds) {
    let runIds: string[];
    try {
      runIds = await fs.readdir(path.join(root, loopId));
    } catch {
      continue;
    }
    for (const runId of runIds) {
      // run 态保护: 活跃/阻塞 run 的 worktree 恢复时还要用, 超龄也不清
      if (opts.protectedRunIds?.has(runId)) {
        continue;
      }
      const dir = path.join(root, loopId, runId);
      try {
        const stat = await fs.stat(dir);
        if (!stat.isDirectory() || stat.mtimeMs > cutoff) {
          continue;
        }
        // 经 git-common-dir 找回主仓库：规范 remove + 删分支；找回失败
        // (主仓库已消失) 退化为直接删目录。
        const commonDir = await git([
          "-C",
          dir,
          "rev-parse",
          "--git-common-dir",
        ]).catch(() => null);
        if (commonDir) {
          const repoPath = path.dirname(path.resolve(dir, commonDir));
          await git([
            "-C",
            repoPath,
            "worktree",
            "remove",
            "--force",
            dir,
          ]).catch((error) =>
            console.warn(`[worktree] remove failed for ${dir}:`, error),
          );
          await git(["-C", repoPath, "branch", "-D", `loop/${runId}`]).catch(
            () => {},
          );
        } else {
          await fs.rm(dir, { recursive: true, force: true });
        }
        pruned += 1;
      } catch (error) {
        console.warn(`[worktree] prune failed for ${dir}:`, error);
      }
    }
  }
  return pruned;
}
