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

test("pruneStaleWorktrees removes stale worktrees and their branches", async (t) => {
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
    await ensureRunWorktree({
      repoPath: repo,
      loopId: "loop-it",
      runId: "run-new",
      dataDir,
    });

    const pruned = await pruneStaleWorktrees({ dataDir, maxAgeDays: 0 });
    assert.equal(pruned, 2);
    assert.equal(await pathExists(stale.path), false);
    assert.equal(await git(["branch", "--list", "loop/*"], repo), "");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("protected runIds are never pruned even when stale", async (t) => {
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

    const pruned = await pruneStaleWorktrees({
      dataDir,
      maxAgeDays: 0,
      protectedRunIds: new Set(["run-active"]),
    });
    assert.equal(pruned, 1);
    assert.ok(await pathExists(kept.path));
    assert.equal(await pathExists(gone.path), false);
    const branches = await git(
      ["branch", "--list", "loop/*", "--format=%(refname:short)"],
      repo,
    );
    assert.equal(branches, "loop/run-active");
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
