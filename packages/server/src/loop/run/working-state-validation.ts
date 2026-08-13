import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { promisify } from "node:util";
import type { RunWorkingState, SelectedSubject } from "@yep-anywhere/shared";

const execFileAsync = promisify(execFile);

export interface WorkingStateValidationResult {
  verified: boolean;
  issues: string[];
  failure_pattern: string | null;
  selected_subject: SelectedSubject | null;
}

export interface WorkingStateValidationDeps {
  pathExists?: (path: string) => Promise<boolean>;
  gitRemote?: (path: string) => Promise<string | null>;
}

function normalizeRepository(value: string): string {
  return value.replace(/\.git$/, "").toLowerCase();
}

function parseRemoteRepository(remote: string): string {
  const normalized = remote.trim().replace(/\.git$/, "");
  const match = normalized.match(/([^/:]+)\/([^/]+)$/);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : normalized;
}

/**
 * Cheap deterministic validation for the executor's self-reported
 * selected_subject. A hallucinated clone path must not become the authority
 * for later turns, so the run loop refuses to promote unverified state.
 */
export async function validateRunWorkingState(
  state: RunWorkingState,
  deps: WorkingStateValidationDeps = {},
): Promise<WorkingStateValidationResult> {
  const subject = state.selected_subject;
  if (!subject) {
    return {
      verified: true,
      issues: [],
      failure_pattern: null,
      selected_subject: null,
    };
  }

  const issues: string[] = [];
  const pathExists =
    deps.pathExists ??
    (async (path) => {
      try {
        return (await fs.stat(path)).isDirectory();
      } catch {
        return false;
      }
    });

  if (!(await pathExists(subject.clone_path))) {
    issues.push(
      `clone_path does not exist or is not a directory: ${subject.clone_path}`,
    );
  }

  const gitRemote =
    deps.gitRemote ??
    (async (path) => {
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["-C", path, "remote", "get-url", "origin"],
          { timeout: 15_000, maxBuffer: 1024 * 1024 },
        );
        return stdout.trim() || null;
      } catch {
        return null;
      }
    });
  const remote = await gitRemote(subject.clone_path);
  if (!remote) {
    issues.push(
      `clone_path is not a git checkout with an origin remote: ${subject.clone_path}`,
    );
  } else if (
    parseRemoteRepository(remote) !== normalizeRepository(subject.repository)
  ) {
    issues.push(
      `clone_path origin '${remote}' does not match selected repository '${subject.repository}'`,
    );
  }

  return {
    verified: issues.length === 0,
    issues,
    failure_pattern:
      issues.length > 0 ? "working_state_clone_path_mismatch" : null,
    selected_subject: subject,
  };
}
