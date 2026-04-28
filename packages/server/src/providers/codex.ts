import {
  CODEX_SESSIONS_DIR,
  CodexSessionScanner,
  codexSessionScanner,
} from "../projects/codex-scanner.js";
import { encodeProjectId } from "../projects/paths.js";
import { codexProvider } from "../sdk/providers/codex.js";
import type { AgentProvider } from "../sdk/providers/types.js";
import { CodexSessionReader } from "../sessions/codex-reader.js";
import { normalizeCodexSession } from "../sessions/normalization.js";
import type { ISessionReader } from "../sessions/types.js";
import type { LoadedSession } from "../sessions/types.js";
import type { Project } from "../supervisor/types.js";
import type { Session } from "../supervisor/types.js";
import { readFirstLine } from "../utils/jsonl.js";
import type { IProviderAdapter } from "./adapter.js";
import type {
  FileType,
  ProviderDescriptor,
  ProviderScanner,
} from "./descriptor.js";

export class CodexProviderDescriptor
  implements ProviderDescriptor, IProviderAdapter
{
  readonly names = ["codex", "codex-oss"];
  readonly group = "codex";

  createReader(project: Project): ISessionReader {
    return new CodexSessionReader({
      sessionsDir: project.sessionDir,
      projectPath: project.path,
    });
  }

  createExtraReader(projectPath: string): ISessionReader {
    return new CodexSessionReader({
      sessionsDir: CODEX_SESSIONS_DIR,
      projectPath,
    });
  }

  getSessionDir(): string {
    return CODEX_SESSIONS_DIR;
  }

  createScanner(options: { sessionsDir?: string }): ProviderScanner {
    const scanner = new CodexSessionScanner({
      sessionsDir: options.sessionsDir ?? CODEX_SESSIONS_DIR,
    });
    return scanner as ProviderScanner;
  }

  getWatchConfig(): { periodicRescanMs: number } {
    return { periodicRescanMs: 5000 };
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
      return "session";
    }
    return "other";
  }

  getSessionFilePattern(): RegExp {
    return /\.jsonl$/;
  }

  extractSessionIdFromPath(relativePath: string): string | null {
    const filename = relativePath.split(/[\\/]/).pop();
    if (!filename || !filename.endsWith(".jsonl")) return null;
    const base = filename.slice(0, -6);
    const match = base.match(/([0-9a-fA-F-]{36})$/);
    return match?.[1] ?? null;
  }

  async readProjectIdFromFile(
    filePath: string,
  ): Promise<import("@yep-anywhere/shared").UrlProjectId | null> {
    const firstLine = await readFirstLine(filePath);
    if (!firstLine) return null;
    try {
      const parsed = JSON.parse(firstLine) as {
        type?: string;
        payload?: { cwd?: string; timestamp?: string };
      };
      if (parsed.type !== "session_meta" || !parsed.payload?.cwd) {
        return null;
      }
      return encodeProjectId(parsed.payload.cwd);
    } catch {
      return null;
    }
  }

  normalizeSession(loaded: LoadedSession): Session {
    return normalizeCodexSession(loaded);
  }

  getStaleInTurnThresholdMs(): number {
    return 60 * 60 * 1000; // 60 minutes
  }

  getDenyFeedbackBehavior(): "queue-followup" | "silent" {
    return "queue-followup";
  }

  getAgentProvider(): AgentProvider | null {
    return codexProvider;
  }

  getScanner(): ProviderScanner {
    return codexSessionScanner;
  }
}
