import {
  CODEX_SESSIONS_DIR,
  CodexSessionScanner,
} from "../projects/codex-scanner.js";
import { codexProvider } from "../sdk/providers/codex.js";
import type { AgentProvider } from "../sdk/providers/types.js";
import { CodexSessionReader } from "../sessions/codex-reader.js";
import { normalizeCodexSession } from "../sessions/normalization.js";
import type { ISessionReader } from "../sessions/types.js";
import type { LoadedSession } from "../sessions/types.js";
import type { Project } from "../supervisor/types.js";
import type { Session } from "../supervisor/types.js";
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
}
