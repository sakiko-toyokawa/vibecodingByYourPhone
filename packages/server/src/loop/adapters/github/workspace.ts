import { mkdir } from "node:fs/promises";
import type { LoopCard } from "@yep-anywhere/shared";
import { AssemblyError } from "../../assembly/runtime-input.js";
import {
  displayGitHubPromptWorkspacePath,
  githubPromptWorkspacePath,
  isGitHubPromptLoop,
} from "../../run/workspace.js";

export function createGitHubWorkspaceResolver() {
  return {
    id: "github_prompt",
    matches: isGitHubPromptLoop,
    async resolve(card: LoopCard, context: { dataDir: string }) {
      const expected = displayGitHubPromptWorkspacePath(card.loop.id);
      if (card.loop.workspace.path !== expected) {
        throw new AssemblyError(
          `GitHub prompt loop cannot start: workspace.path must be '${expected}'`,
        );
      }
      const workspacePath = githubPromptWorkspacePath(
        context.dataDir,
        card.loop.id,
      );
      await mkdir(workspacePath, { recursive: true });
      return {
        handled: true,
        card: {
          ...card,
          loop: {
            ...card.loop,
            workspace: {
              ...card.loop.workspace,
              strategy: "direct" as const,
              path: workspacePath,
            },
          },
        },
      };
    },
  };
}
