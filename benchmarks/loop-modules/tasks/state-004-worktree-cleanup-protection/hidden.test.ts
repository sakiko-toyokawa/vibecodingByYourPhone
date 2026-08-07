import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  ensureRunWorktree,
  pruneStaleWorktrees,
  runWorktreeDir,
} from "../../../../packages/server/src/loop/worktree/worktree.js";

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

async function makeTempRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "yep-wt-bench-"));
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

test("custom maxAgeDays shortens the cleanup threshold", async (t) => {
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

test("budget_limited run is not protected and can be pruned while active runs are kept", async (t) => {
  if (!(await gitAvailable())) {
    t.skip("git not available");
    return;
  }
  const repo = await makeTempRepo();
  const dataDir = await mkdtemp(path.join(tmpdir(), "yep-wt-data-"));
  try {
    const active = await ensureRunWorktree({
      repoPath: repo,
      loopId: "loop-it",
      runId: "run-active",
      dataDir,
    });
    const budgetLimited = await ensureRunWorktree({
      repoPath: repo,
      loopId: "loop-it",
      runId: "run-budget-limited",
      dataDir,
    });
    const pruned = await pruneStaleWorktrees({
      dataDir,
      maxAgeDays: 0,
      protectedRunIds: new Set(["run-active"]),
    });
    // budget_limited is intentionally not in the protected set; only active/retry/paused/needs_human are.
    assert.equal(pruned, 1);
    assert.ok(await pathExists(active.path), "active worktree is kept");
    assert.equal(
      await pathExists(budgetLimited.path),
      false,
      "budget_limited worktree is pruned",
    );
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

test("pruning tolerates missing worktrees root", async (t) => {
  if (!(await gitAvailable())) {
    t.skip("git not available");
    return;
  }
  const dataDir = await mkdtemp(path.join(tmpdir(), "yep-wt-empty-"));
  try {
    const pruned = await pruneStaleWorktrees({ dataDir, maxAgeDays: 0 });
    assert.equal(pruned, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
