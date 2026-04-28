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
import type { FileChangeEvent } from "../watcher/EventBus.js";
import type { IProviderAdapter } from "./adapter.js";
import type { FileType, ProviderDescriptor } from "./descriptor.js";

export class ClaudeProviderDescriptor
  implements ProviderDescriptor, IProviderAdapter
{
  readonly names = ["claude"];
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

  extractSessionFromFileChange(
    event: FileChangeEvent,
    deps: { projectsDir: string },
  ): { sessionId: string; sessionDir: string } | null {
    if (event.fileType !== "session") return null;
    const fileName = path.basename(event.relativePath);
    if (!fileName.endsWith(".jsonl")) return null;
    const sessionId = fileName.slice(0, -6);
    const relativeDir = path.dirname(event.relativePath);
    const sessionDir =
      relativeDir === "."
        ? deps.projectsDir
        : path.join(deps.projectsDir, relativeDir);
    return { sessionId, sessionDir };
  }

  getSessionFileCandidates(project: Project, sessionId: string): string[] {
    const candidates = [path.join(project.sessionDir, `${sessionId}.jsonl`)];
    if (project.mergedSessionDirs) {
      for (const dir of project.mergedSessionDirs) {
        candidates.push(path.join(dir, `${sessionId}.jsonl`));
      }
    }
    return candidates;
  }

  getSessionFilePattern(): RegExp {
    return /\.jsonl$/;
  }

  extractSessionIdFromPath(relativePath: string): string | null {
    const fileName = path.basename(relativePath);
    if (!fileName.endsWith(".jsonl")) return null;
    return fileName.slice(0, -6);
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

  getScanner(): null {
    return null;
  }
}
