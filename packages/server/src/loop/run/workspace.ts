/**
 * Workspace resolution helpers for loop runs.
 *
 * Extracted from run-service.ts during Phase-3 refactoring.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { LoopCard } from "@yep-anywhere/shared";
import { AssemblyError } from "../assembly/runtime-input.js";
import type { RuntimeAssemblyContext } from "../assembly/runtime-input.js";
import type { WorkspaceResolverRegistry } from "../workspace/registry.js";
import { type RunWorktree, ensureRunWorktree } from "../worktree/worktree.js";
import type { GithubCredentialStore, GithubToolProvisioner } from "./types.js";

export function isGitHubPromptLoop(card: LoopCard): boolean {
  return card.loop.discovery?.source === "github_prompt";
}

/** Any GitHub-managed loop whose workspace is owned by the server. */
export function isGitHubManagedLoop(card: LoopCard): boolean {
  return isGitHubPromptLoop(card);
}

export function displayGitHubPromptWorkspacePath(loopId: string): string {
  return `managed://github-workspaces/prompt-loops/${loopId}`;
}

export function githubPromptWorkspacePath(
  dataDir: string,
  loopId: string,
): string {
  return path.join(dataDir, "github-workspaces", "prompt-loops", loopId);
}

export function loopRuntime(
  card: LoopCard,
): { provider?: string; model?: string } | undefined {
  return (card.loop as { runtime?: { provider?: string; model?: string } })
    .runtime;
}

export interface ResolveExecutableCardResult {
  card: LoopCard;
  worktree: RunWorktree | null;
}

/**
 * 运行前改写 card 的统一挂载点：GitHub prompt loop 重写 workspace.path
 * 到 managed 目录；workspace.strategy "worktree" 创建/复用 run 级隔离
 * worktree 并把 path 改写为 worktree 目录 —— 下游 assembly / executor /
 * verifier / diff 取证全部以改写后的 path 为 cwd, 零改动获得隔离。
 * 返回 worktree 证据供 executeRun 落 workspace.json (direct 为 null)。
 */
export async function resolveExecutableCard(
  card: LoopCard,
  runId: string,
  deps: {
    dataDir?: string;
    workspaceResolverRegistry?: WorkspaceResolverRegistry;
  },
): Promise<ResolveExecutableCardResult> {
  const resolver = deps.workspaceResolverRegistry?.find(card);
  if (resolver) {
    if (!deps.dataDir) {
      throw new AssemblyError(
        "Workspace resolver requires a configured server data directory",
      );
    }
    const resolved = await resolver.resolve(card, {
      dataDir: deps.dataDir,
      runId,
    });
    if (resolved.handled) return { card: resolved.card, worktree: null };
  }
  const declaredPath = card.loop.workspace.path;
  // LOOP-PROPOSAL 閘門落地的子 loop（P1-2 钳制层强制 managed:// 前缀）：
  // 通用 server 管理工作区，解析到 dataDir 下的同名相对目录。
  if (declaredPath?.startsWith("managed://")) {
    if (!deps.dataDir) {
      throw new AssemblyError(
        "Managed loop workspace cannot start: server data directory is not configured",
      );
    }
    const workspacePath = path.join(
      deps.dataDir,
      declaredPath.slice("managed://".length),
    );
    // 纵深防御：managed:// 后缀不许越出 dataDir。提案钳制层已强制
    // loop-workspaces/<kebab-id>，这里再挡一次直建卡与脏数据；
    // 检查必须先于 mkdir，否则会先把越界目录建出来。
    const escapeCheck = path.relative(
      path.resolve(deps.dataDir),
      path.resolve(workspacePath),
    );
    if (escapeCheck.startsWith("..") || path.isAbsolute(escapeCheck)) {
      throw new AssemblyError(
        `Managed loop workspace cannot start: path '${declaredPath}' escapes the server data directory`,
      );
    }
    await mkdir(workspacePath, { recursive: true });
    return {
      card: {
        ...card,
        loop: {
          ...card.loop,
          workspace: {
            ...card.loop.workspace,
            strategy: "direct",
            path: workspacePath,
          },
        },
      },
      worktree: null,
    };
  }
  if (card.loop.workspace.strategy !== "worktree") {
    return { card, worktree: null };
  }
  const repoPath = card.loop.workspace.path;
  if (!repoPath) {
    throw new AssemblyError(
      `Loop '${card.loop.id}' workspace.strategy is worktree but workspace.path is missing`,
    );
  }
  if (!deps.dataDir) {
    throw new AssemblyError(
      `Loop '${card.loop.id}' workspace.strategy is worktree but server data directory is not configured`,
    );
  }
  const worktree = await ensureRunWorktree({
    repoPath,
    loopId: card.loop.id,
    runId,
    dataDir: deps.dataDir,
  });
  return {
    card: {
      ...card,
      loop: {
        ...card.loop,
        workspace: {
          ...card.loop.workspace,
          path: worktree.path,
        },
      },
    },
    worktree,
  };
}

export interface ResolveRuntimeAssemblyContextDeps {
  githubCredentialStore?: GithubCredentialStore;
  githubToolProvisioner?: GithubToolProvisioner;
}

export async function resolveRuntimeAssemblyContext(
  card: LoopCard,
  deps: ResolveRuntimeAssemblyContextDeps,
): Promise<RuntimeAssemblyContext> {
  if (!isGitHubManagedLoop(card)) {
    return {};
  }
  if (!deps.githubCredentialStore) {
    throw new AssemblyError(
      "GitHub loop cannot start: GitHub credential store is not configured",
    );
  }
  if (!deps.githubToolProvisioner) {
    throw new AssemblyError(
      "GitHub loop cannot start: GitHub CLI provisioner is not configured",
    );
  }

  const token = await deps.githubCredentialStore.getToken();
  if (!token) {
    throw new AssemblyError(
      "GitHub loop cannot start: save a GitHub token before running this loop",
    );
  }
  const tool = await deps.githubToolProvisioner.ensureGh();
  if (!tool.path) {
    throw new AssemblyError(
      "GitHub loop cannot start: managed GitHub CLI path is unavailable",
    );
  }
  return { github: { token, ghPath: tool.path } };
}
