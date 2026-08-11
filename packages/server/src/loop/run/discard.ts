/**
 * Run discard helpers: direct workspace rollback and discard evidence.
 *
 * Direct rollback is deliberately evidence-based. It reverses the newest
 * `diff.patch` / `diff-turnN.patch` artifact against the current git
 * working tree. Untracked files are not removed automatically because we
 * cannot distinguish run-created files from concurrent user work without a
 * full run baseline snapshot.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RunLedgerStore } from "../state/run-ledger-store.js";

const execFileAsync = promisify(execFile);

export interface DiscardRollbackResult {
  ok: boolean;
  revertedTrackedFiles: boolean;
  error?: string;
}

async function runGit(
  workspacePath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", ["-C", workspacePath, ...args], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function workspaceIsClean(workspacePath: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(workspacePath, ["status", "--porcelain"]);
    return stdout.trim().length === 0;
  } catch {
    return false;
  }
}

/**
 * Find the newest diff artifact for a run. The last turn's patch is a
 * cumulative `git diff HEAD` capture, so reversing it restores all tracked
 * files that were changed by the run.
 */
export function latestDiffArtifactName(artifactNames: string[]): string | null {
  const diffs = artifactNames
    .filter((name) => /^diff(?:-turn\d+)?\.patch$/.test(name))
    .sort((a, b) => {
      const turnA = Number(/^diff-turn(\d+)\.patch$/.exec(a)?.[1] ?? 1);
      const turnB = Number(/^diff-turn(\d+)\.patch$/.exec(b)?.[1] ?? 1);
      return turnB - turnA;
    });
  return diffs[0] ?? null;
}

export async function rollbackDirectRun(
  store: RunLedgerStore,
  workspacePath: string,
  runId: string,
): Promise<DiscardRollbackResult> {
  const artifactNames = await store.listArtifacts(runId);
  const patchName = latestDiffArtifactName(artifactNames);
  if (!patchName) {
    if (await workspaceIsClean(workspacePath)) {
      return { ok: true, revertedTrackedFiles: false };
    }
    return {
      ok: false,
      revertedTrackedFiles: false,
      error: "no diff evidence available for direct rollback",
    };
  }
  const patch = await store.readArtifact(runId, patchName);
  if (!patch) {
    return {
      ok: false,
      revertedTrackedFiles: false,
      error: `diff evidence '${patchName}' could not be read`,
    };
  }
  if (await workspaceIsClean(workspacePath)) {
    return { ok: true, revertedTrackedFiles: false };
  }
  const tmpDir = await mkdtemp(join(tmpdir(), "yep-discard-"));
  try {
    const patchPath = join(tmpDir, "reverse.patch");
    await writeFile(patchPath, patch, "utf-8");
    await runGit(workspacePath, [
      "apply",
      "--reverse",
      "--check",
      "--allow-empty",
      patchPath,
    ]);
    await runGit(workspacePath, [
      "apply",
      "--reverse",
      "--allow-empty",
      patchPath,
    ]);
    return { ok: true, revertedTrackedFiles: true };
  } catch (error) {
    return {
      ok: false,
      revertedTrackedFiles: false,
      error:
        error instanceof Error
          ? error.message
          : `git apply failed: ${String(error)}`,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export async function writeDiscardResult(
  store: RunLedgerStore,
  runId: string,
  input: {
    reason: string;
    rollback: DiscardRollbackResult | null;
    worktreeCleanup: { ok: boolean; error?: string } | null;
  },
): Promise<string> {
  const name = "discard-result.json";
  const content = {
    run_id: runId,
    reason: input.reason,
    rollback: input.rollback,
    worktree_cleanup: input.worktreeCleanup,
    created_at: new Date().toISOString(),
  };
  await store.writeArtifact(
    runId,
    name,
    `${JSON.stringify(content, null, 2)}\n`,
  );
  return `artifact://${runId}/${name}`;
}
