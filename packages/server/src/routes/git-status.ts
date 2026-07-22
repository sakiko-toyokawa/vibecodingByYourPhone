import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  type GitFileChange,
  type GitStatusInfo,
  type PatchHunk,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { computeEditAugment } from "../augments/edit-augments.js";
import { renderMarkdownToHtml } from "../augments/markdown-augments.js";
import type { ProjectScanner } from "../projects/scanner.js";

const execFileAsync = promisify(execFile);

export interface GitStatusDeps {
  scanner: ProjectScanner;
}

const NOT_A_GIT_REPO: GitStatusInfo = {
  isGitRepo: false,
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  isClean: true,
  files: [],
};

export function createGitStatusRoutes(deps: GitStatusDeps): Hono {
  const routes = new Hono();

  routes.get("/:projectId/git", async (c) => {
    const projectId = c.req.param("projectId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    try {
      const result = await getGitStatus(project.path);
      return c.json(result);
    } catch (err) {
      if (isNotGitRepoError(err)) {
        return c.json(NOT_A_GIT_REPO);
      }
      return c.json({ error: "Failed to get git status" }, 500);
    }
  });

  /**
   * POST /:projectId/git/diff
   * Get syntax-highlighted diff for a specific file.
   * Body: { path, staged, status, fullContext? }
   */
  routes.post("/:projectId/git/diff", async (c) => {
    const projectId = c.req.param("projectId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    let body: {
      path: string;
      staged: boolean;
      status: string;
      fullContext?: boolean;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { path, staged, status, fullContext } = body;
    if (!path || typeof staged !== "boolean" || !status) {
      return c.json(
        { error: "Missing required fields: path, staged, status" },
        400,
      );
    }

    try {
      const { oldContent, newContent } = await getFileVersions(
        project.path,
        path,
        staged,
        status,
      );

      const contextLines = fullContext ? 999999 : 3;
      const augment = await computeEditAugment(
        "git-diff",
        { file_path: path, old_string: oldContent, new_string: newContent },
        contextLines,
      );

      const result: {
        diffHtml: string;
        structuredPatch: PatchHunk[];
        markdownHtml?: string;
      } = {
        diffHtml: augment.diffHtml,
        structuredPatch: augment.structuredPatch,
      };

      // Render markdown preview for .md files
      const ext = extname(path).toLowerCase();
      if ((ext === ".md" || ext === ".markdown") && newContent) {
        try {
          result.markdownHtml = await renderMarkdownToHtml(newContent);
        } catch {
          // Ignore markdown rendering errors
        }
      }

      return c.json(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to compute diff";
      return c.json({ error: message }, 500);
    }
  });

  /**
   * POST /:projectId/git/restore
   * Restore files to their pre-modification state.
   * Body: { paths: string[] }
   */
  routes.post("/:projectId/git/restore", async (c) => {
    const projectId = c.req.param("projectId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    let body: { paths: string[] };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { paths } = body;
    if (!Array.isArray(paths) || paths.length === 0) {
      return c.json(
        { error: "Missing required field: paths (non-empty array)" },
        400,
      );
    }

    try {
      const result = await restoreFiles(project.path, paths);
      return c.json(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to restore files";
      return c.json({ error: message }, 500);
    }
  });

  return routes;
}

/**
 * Restore files to their pre-modification state based on git status.
 */
async function restoreFiles(
  cwd: string,
  paths: string[],
): Promise<{
  restored: string[];
  failed: Array<{ path: string; error: string }>;
}> {
  const restored: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];

  // Get current git status to determine how to restore each file
  let statusResult: { stdout: string; stderr: string };
  try {
    statusResult = await runGit(cwd, ["status", "--porcelain=v2"]);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to get git status";
    for (const path of paths) {
      failed.push({ path, error: message });
    }
    return { restored, failed };
  }

  // Build a map of path -> { stagedStatus, unstagedStatus }
  const statusMap = new Map<
    string,
    { stagedStatus: string | null; unstagedStatus: string | null }
  >();

  for (const line of statusResult.stdout.split("\n")) {
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("1 ")) {
      const parts = line.split(" ");
      const xy = parts[1];
      const path = parts.slice(8).join(" ");
      const stagedStatus = statusChar(xy, 0);
      const unstagedStatus = statusChar(xy, 1);
      statusMap.set(path, { stagedStatus, unstagedStatus });
    } else if (line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1];
      const pathAndOrig = parts.slice(9).join(" ");
      const tabIdx = pathAndOrig.indexOf("\t");
      const path = tabIdx >= 0 ? pathAndOrig.slice(0, tabIdx) : pathAndOrig;
      const stagedStatus = statusChar(xy, 0);
      const unstagedStatus = statusChar(xy, 1);
      statusMap.set(path, { stagedStatus, unstagedStatus });
    } else if (line.startsWith("? ")) {
      const path = line.slice(2);
      statusMap.set(path, { stagedStatus: null, unstagedStatus: "?" });
    }
  }

  for (const path of paths) {
    try {
      const status = statusMap.get(path);
      if (!status) {
        // File not in git status - might already be clean or not tracked
        restored.push(path);
        continue;
      }

      const { stagedStatus, unstagedStatus } = status;

      // Determine effective status: prioritize unstaged, then staged
      const effectiveStatus = unstagedStatus ?? stagedStatus;

      if (effectiveStatus === "?" || effectiveStatus === null) {
        // Untracked file - remove it
        try {
          await unlink(resolve(cwd, path));
        } catch {
          // File might already be gone
        }
        restored.push(path);
        continue;
      }

      if (effectiveStatus === "A") {
        // Added file - unstage and remove
        await runGit(cwd, ["rm", "--cached", "--", path]).catch(() => {
          // Might not be staged anymore
        });
        try {
          await unlink(resolve(cwd, path));
        } catch {
          // File might already be gone
        }
        restored.push(path);
        continue;
      }

      if (effectiveStatus === "D") {
        // Deleted file - restore from HEAD
        await runGit(cwd, ["checkout", "HEAD", "--", path]);
        restored.push(path);
        continue;
      }

      // Modified or other statuses - restore from index (for unstaged) or HEAD (for staged)
      if (stagedStatus && !unstagedStatus) {
        // Only staged changes - restore from HEAD
        await runGit(cwd, ["checkout", "HEAD", "--", path]);
      } else {
        // Unstaged changes (or both) - restore from index
        await runGit(cwd, ["checkout", "--", path]);
      }
      restored.push(path);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failed.push({ path, error });
    }
  }

  return { restored, failed };
}

/**
 * Get old and new file content for computing a diff.
 * Handles all git status codes (M, A, D, ?, R, etc.).
 */
async function getFileVersions(
  cwd: string,
  path: string,
  staged: boolean,
  status: string,
): Promise<{ oldContent: string; newContent: string }> {
  // Untracked: entire file is new
  if (status === "?") {
    const content = await readFile(resolve(cwd, path), "utf-8");
    return { oldContent: "", newContent: content };
  }

  // Added (staged): new file in index
  if (status === "A") {
    if (staged) {
      const { stdout } = await runGit(cwd, ["show", `:${path}`]);
      return { oldContent: "", newContent: stdout };
    }
    // Unstaged add shouldn't normally happen, but handle it
    const content = await readFile(resolve(cwd, path), "utf-8");
    return { oldContent: "", newContent: content };
  }

  // Deleted
  if (status === "D") {
    const ref = staged ? `HEAD:${path}` : `:${path}`;
    const { stdout } = await runGit(cwd, ["show", ref]);
    return { oldContent: stdout, newContent: "" };
  }

  // Modified or other statuses
  if (staged) {
    // Staged: compare HEAD to index
    const [oldResult, newResult] = await Promise.all([
      runGit(cwd, ["show", `HEAD:${path}`]).catch(() => ({
        stdout: "",
        stderr: "",
      })),
      runGit(cwd, ["show", `:${path}`]),
    ]);
    return { oldContent: oldResult.stdout, newContent: newResult.stdout };
  }

  // Unstaged: compare index to working tree
  const [oldResult, newContent] = await Promise.all([
    runGit(cwd, ["show", `:${path}`]).catch(() => ({
      stdout: "",
      stderr: "",
    })),
    readFile(resolve(cwd, path), "utf-8").catch(() => ""),
  ]);
  return { oldContent: oldResult.stdout, newContent };
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
}

function isNotGitRepoError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as { code?: number | string; stderr?: string };
    if (e.code === 128) return true;
    if (
      typeof e.stderr === "string" &&
      e.stderr.includes("not a git repository")
    )
      return true;
  }
  return false;
}

/** Parse `git diff --numstat` output into a map of path → {added, deleted} */
function parseNumstat(
  output: string,
): Map<string, { added: number | null; deleted: number | null }> {
  const map = new Map<
    string,
    { added: number | null; deleted: number | null }
  >();
  for (const line of output.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const addedStr = parts[0] ?? "";
    const deletedStr = parts[1] ?? "";
    const path = parts.slice(2).join("\t");
    const added = addedStr === "-" ? null : Number.parseInt(addedStr, 10);
    const deleted = deletedStr === "-" ? null : Number.parseInt(deletedStr, 10);
    map.set(path, { added, deleted });
  }
  return map;
}

/** Status letter from the XY field for a given position */
function statusChar(xy: string | undefined, index: 0 | 1): string | null {
  if (!xy) return null;
  const ch = xy[index];
  return ch && ch !== "." ? ch : null;
}

async function getGitStatus(projectPath: string): Promise<GitStatusInfo> {
  // Run all three commands in parallel
  const [statusResult, numstatUnstaged, numstatStaged] = await Promise.all([
    runGit(projectPath, ["status", "--porcelain=v2", "--branch"]),
    runGit(projectPath, ["diff", "--numstat"]).catch(() => ({
      stdout: "",
      stderr: "",
    })),
    runGit(projectPath, ["diff", "--cached", "--numstat"]).catch(() => ({
      stdout: "",
      stderr: "",
    })),
  ]);

  const unstagedStats = parseNumstat(numstatUnstaged.stdout);
  const stagedStats = parseNumstat(numstatStaged.stdout);

  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitFileChange[] = [];

  for (const line of statusResult.stdout.split("\n")) {
    if (!line) continue;

    // Branch headers
    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length);
      branch = value === "(detached)" ? null : value;
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length);
    } else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+) -(\d+)/);
      if (match?.[1] && match[2]) {
        ahead = Number.parseInt(match[1], 10);
        behind = Number.parseInt(match[2], 10);
      }
    }
    // Ordinary changed entry: "1 XY sub mH mI mW hH hI path"
    else if (line.startsWith("1 ")) {
      const parts = line.split(" ");
      const xy = parts[1];
      const path = parts.slice(8).join(" ");

      const stagedStatus = statusChar(xy, 0);
      const unstagedStatus = statusChar(xy, 1);

      if (stagedStatus) {
        const stats = stagedStats.get(path);
        files.push({
          path,
          status: stagedStatus,
          staged: true,
          linesAdded: stats?.added ?? null,
          linesDeleted: stats?.deleted ?? null,
        });
      }
      if (unstagedStatus) {
        const stats = unstagedStats.get(path);
        files.push({
          path,
          status: unstagedStatus,
          staged: false,
          linesAdded: stats?.added ?? null,
          linesDeleted: stats?.deleted ?? null,
        });
      }
    }
    // Renamed/copied entry: "2 XY sub mH mI mW hH hI X score path\torigPath"
    else if (line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1];
      const pathAndOrig = parts.slice(9).join(" ");
      const tabIdx = pathAndOrig.indexOf("\t");
      const path = tabIdx >= 0 ? pathAndOrig.slice(0, tabIdx) : pathAndOrig;
      const origPath = tabIdx >= 0 ? pathAndOrig.slice(tabIdx + 1) : undefined;

      const stagedStatus = statusChar(xy, 0);
      const unstagedStatus = statusChar(xy, 1);

      if (stagedStatus) {
        const stats = stagedStats.get(path);
        files.push({
          path,
          status: stagedStatus,
          staged: true,
          linesAdded: stats?.added ?? null,
          linesDeleted: stats?.deleted ?? null,
          origPath,
        });
      }
      if (unstagedStatus) {
        const stats = unstagedStats.get(path);
        files.push({
          path,
          status: unstagedStatus,
          staged: false,
          linesAdded: stats?.added ?? null,
          linesDeleted: stats?.deleted ?? null,
          origPath,
        });
      }
    }
    // Untracked: "? path" (skip directories — they end with /)
    else if (line.startsWith("? ")) {
      const path = line.slice(2);
      if (!path.endsWith("/")) {
        files.push({
          path,
          status: "?",
          staged: false,
          linesAdded: null,
          linesDeleted: null,
        });
      }
    }
    // Unmerged: "u XY sub m1 m2 m3 mW h1 h2 h3 path"
    else if (line.startsWith("u ")) {
      const parts = line.split(" ");
      const path = parts.slice(10).join(" ");
      files.push({
        path,
        status: "U",
        staged: false,
        linesAdded: null,
        linesDeleted: null,
      });
    }
  }

  return {
    isGitRepo: true,
    branch,
    upstream,
    ahead,
    behind,
    isClean: files.length === 0,
    files,
  };
}
