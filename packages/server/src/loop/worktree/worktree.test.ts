/**
 * worktree 隔离策略单元测试（run 级 git worktree 的创建/复用/清理）。
 *
 * 用临时 git 仓库真实执行 git 命令；git 不可用时整套跳过（CI 环境兜底）。
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  ensureRunWorktree,
  isGitWorkTree,
  pruneStaleWorktrees,
  runWorktreeDir,
} from "./worktree.js";

const execFileAsync = promisify(execFile);

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

/** 建一个带一次提交的临时 git 仓库（worktree add 需要 HEAD 存在）。 */
async function makeTempRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "yep-wt-repo-"));
  await git(["init"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  await writeFile(path.join(repo, "README.md"), "hello\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  return repo;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

test("ensureRunWorktree: 非 git 目录 → AssemblyError (fail-closed)", async (t) => {
  if (!(await gitAvailable())) {
    t.skip("git not available");
    return;
  }
  const notRepo = await mkdtemp(path.join(tmpdir(), "yep-wt-notrepo-"));
  const dataDir = await mkdtemp(path.join(tmpdir(), "yep-wt-data-"));
  try {
    assert.equal(await isGitWorkTree(notRepo), false);
    await assert.rejects(
      () =>
        ensureRunWorktree({
          repoPath: notRepo,
          loopId: "loop-it",
          runId: "run-1",
          dataDir,
        }),
      /not a git work tree/,
    );
  } finally {
    await rm(notRepo, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("ensureRunWorktree: 创建后复用同一路径; 主仓库 git status 不被污染", async (t) => {
  if (!(await gitAvailable())) {
    t.skip("git not available");
    return;
  }
  const repo = await makeTempRepo();
  const dataDir = await mkdtemp(path.join(tmpdir(), "yep-wt-data-"));
  try {
    const first = await ensureRunWorktree({
      repoPath: repo,
      loopId: "loop-it",
      runId: "run-1",
      dataDir,
    });
    assert.equal(first.path, runWorktreeDir(dataDir, "loop-it", "run-1"));
    assert.equal(first.branch, "loop/run-1");
    assert.ok(first.baseSha.length > 0);
    assert.ok(await pathExists(path.join(first.path, "README.md")));

    // worktree 里的改动不进入主仓库的 git status
    await writeFile(path.join(first.path, "scratch.txt"), "wip\n");
    const status = await git(["status", "--porcelain"], repo);
    assert.equal(status, "", "主 checkout 不受 worktree 影响");

    // 二次调用复用同一目录 (retry / 重启重建路径), 且改动还在
    const second = await ensureRunWorktree({
      repoPath: repo,
      loopId: "loop-it",
      runId: "run-1",
      dataDir,
    });
    assert.equal(second.path, first.path);
    assert.ok(await pathExists(path.join(second.path, "scratch.txt")));
  } finally {
    await git(
      [
        "worktree",
        "remove",
        "--force",
        runWorktreeDir(dataDir, "loop-it", "run-1"),
      ],
      repo,
    ).catch(() => {});
    await rm(repo, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("pruneStaleWorktrees: 超期目录连同分支一起清理, 未超期保留", async (t) => {
  if (!(await gitAvailable())) {
    t.skip("git not available");
    return;
  }
  const repo = await makeTempRepo();
  const dataDir = await mkdtemp(path.join(tmpdir(), "yep-wt-data-"));
  try {
    const stale = await ensureRunWorktree({
      repoPath: repo,
      loopId: "loop-it",
      runId: "run-old",
      dataDir,
    });
    const fresh = await ensureRunWorktree({
      repoPath: repo,
      loopId: "loop-it",
      runId: "run-new",
      dataDir,
    });
    // maxAgeDays=0 → 全部超期; 用一个很大的值保留 fresh 的对照放在下一轮。
    const prunedAll = await pruneStaleWorktrees({ dataDir, maxAgeDays: 0 });
    assert.equal(prunedAll, 2);
    assert.equal(await pathExists(stale.path), false);
    assert.equal(await pathExists(fresh.path), false);
    // 分支也被删除
    const branches = await git(["branch", "--list", "loop/*"], repo);
    assert.equal(branches, "");

    // 再来一轮: 未超期的不动
    await ensureRunWorktree({
      repoPath: repo,
      loopId: "loop-it",
      runId: "run-keep",
      dataDir,
    });
    const prunedNone = await pruneStaleWorktrees({
      dataDir,
      maxAgeDays: 30,
    });
    assert.equal(prunedNone, 0);
    assert.ok(await pathExists(runWorktreeDir(dataDir, "loop-it", "run-keep")));
  } finally {
    await git(
      [
        "worktree",
        "remove",
        "--force",
        runWorktreeDir(dataDir, "loop-it", "run-keep"),
      ],
      repo,
    ).catch(() => {});
    await rm(repo, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("pruneStaleWorktrees: 保护集中的 runId 即使超龄也不被清理 (04 run 态保护)", async (t) => {
  if (!(await gitAvailable())) {
    t.skip("git not available");
    return;
  }
  const repo = await makeTempRepo();
  const dataDir = await mkdtemp(path.join(tmpdir(), "yep-wt-data-"));
  try {
    const kept = await ensureRunWorktree({
      repoPath: repo,
      loopId: "loop-it",
      runId: "run-active",
      dataDir,
    });
    const gone = await ensureRunWorktree({
      repoPath: repo,
      loopId: "loop-it",
      runId: "run-stale",
      dataDir,
    });
    // maxAgeDays=0 → 全部超龄; run-active 在保护集里必须原样保留
    const pruned = await pruneStaleWorktrees({
      dataDir,
      maxAgeDays: 0,
      protectedRunIds: new Set(["run-active"]),
    });
    assert.equal(pruned, 1, "只清未保护的那一个");
    assert.ok(await pathExists(kept.path), "受保护的 worktree 保留");
    assert.equal(await pathExists(gone.path), false);
    const branches = await git(
      ["branch", "--list", "loop/*", "--format=%(refname:short)"],
      repo,
    );
    assert.equal(branches, "loop/run-active", "受保护分支不删");
  } finally {
    await git(
      [
        "worktree",
        "remove",
        "--force",
        runWorktreeDir(dataDir, "loop-it", "run-active"),
      ],
      repo,
    ).catch(() => {});
    await rm(repo, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("pruneStaleWorktrees: 自定义 maxAgeDays 生效 (缩短阈值让新目录也可被清)", async (t) => {
  if (!(await gitAvailable())) {
    t.skip("git not available");
    return;
  }
  const repo = await makeTempRepo();
  const dataDir = await mkdtemp(path.join(tmpdir(), "yep-wt-data-"));
  try {
    const fresh = await ensureRunWorktree({
      repoPath: repo,
      loopId: "loop-it",
      runId: "run-fresh",
      dataDir,
    });
    // 阈值缩到 0 (cleanup_rule.max_age_days 的最极端声明): 刚建的目录也超龄
    const pruned = await pruneStaleWorktrees({ dataDir, maxAgeDays: 0 });
    assert.equal(pruned, 1);
    assert.equal(await pathExists(fresh.path), false);
  } finally {
    await git(
      [
        "worktree",
        "remove",
        "--force",
        runWorktreeDir(dataDir, "loop-it", "run-fresh"),
      ],
      repo,
    ).catch(() => {});
    await rm(repo, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});
