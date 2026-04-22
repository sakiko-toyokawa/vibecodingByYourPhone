import * as path from "node:path";
import { CLAUDE_PROJECTS_DIR } from "../projects/paths.js";
import { claudeProvider } from "../sdk/providers/claude.js";
import type { AgentProvider } from "../sdk/providers/types.js";
import type { ModelInfoService } from "../services/ModelInfoService.js";
import { normalizeClaudeSession } from "../sessions/normalization.js";
import { ClaudeSessionReader } from "../sessions/reader.js";
import type { ISessionReader } from "../sessions/types.js";
import type { LoadedSession } from "../sessions/types.js";
import type { Project } from "../supervisor/types.js";
import type { Session } from "../supervisor/types.js";
import type { IProviderAdapter } from "./adapter.js";
import type { FileType, ProviderDescriptor } from "./descriptor.js";

export class ClaudeProviderDescriptor
  implements ProviderDescriptor, IProviderAdapter
{
  readonly names = ["claude", "claude-ollama"];
  readonly group = "claude";

  constructor(private modelInfoService?: ModelInfoService) {}

  createReader(project: Project): ISessionReader {
    const mis = this.modelInfoService;
    return new ClaudeSessionReader({
      sessionDir: project.sessionDir,
      additionalDirs: project.mergedSessionDirs,
      getContextWindow: mis
        ? (model, provider) => mis.getContextWindow(model, provider)
        : undefined,
    });
  }

  createExtraReader(): ISessionReader | null {
    return null;
  }

  getSessionDir(): string {
    return CLAUDE_PROJECTS_DIR;
  }

  createScanner(): null {
    return null;
  }

  getWatchConfig(): { periodicRescanMs: number } {
    return { periodicRescanMs: 0 };
  }

  capabilities = {
    supportsFork: true,
    supportsFiles: true,
    supportsDiff: true,
    supportsMerge: false,
    isRemoteCapable: true,
  };

  parseFileType(relativePath: string): FileType {
    if (relativePath.endsWith(".jsonl")) {
      if (path.basename(relativePath).startsWith("agent-")) {
        return "agent-session";
      }
      return "session";
    }
    return "other";
  }

  normalizeSession(loaded: LoadedSession): Session {
    return normalizeClaudeSession(loaded);
  }

  getStaleInTurnThresholdMs(): number {
    return 5 * 60 * 1000; // 5 minutes
  }

  getDenyFeedbackBehavior(): "queue-followup" | "silent" {
    return "silent";
  }

  getAgentProvider(): AgentProvider | null {
    return claudeProvider;
  }
}
