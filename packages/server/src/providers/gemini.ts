import {
  GEMINI_TMP_DIR,
  GeminiSessionScanner,
} from "../projects/gemini-scanner.js";
import { geminiACPProvider } from "../sdk/providers/gemini-acp.js";
import type { AgentProvider } from "../sdk/providers/types.js";
import { GeminiSessionReader } from "../sessions/gemini-reader.js";
import { normalizeGeminiSession } from "../sessions/normalization.js";
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

export class GeminiProviderDescriptor
  implements ProviderDescriptor, IProviderAdapter
{
  readonly names = ["gemini", "gemini-acp"];
  readonly group = "gemini";
  private scanner: GeminiSessionScanner;

  constructor() {
    this.scanner = new GeminiSessionScanner({ sessionsDir: GEMINI_TMP_DIR });
  }

  createReader(project: Project): ISessionReader {
    return new GeminiSessionReader({
      sessionsDir: GEMINI_TMP_DIR,
      projectPath: project.path,
      hashToCwd: this.scanner.getHashToCwd(),
    });
  }

  createExtraReader(projectPath: string): ISessionReader {
    return new GeminiSessionReader({
      sessionsDir: GEMINI_TMP_DIR,
      projectPath,
      hashToCwd: this.scanner.getHashToCwd(),
    });
  }

  getSessionDir(): string {
    return GEMINI_TMP_DIR;
  }

  createScanner(options: { sessionsDir?: string }): ProviderScanner {
    const scanner = new GeminiSessionScanner({
      sessionsDir: options.sessionsDir ?? GEMINI_TMP_DIR,
    });
    return scanner as ProviderScanner;
  }

  getWatchConfig(): { periodicRescanMs: number } {
    return { periodicRescanMs: 0 };
  }

  capabilities = {
    supportsFork: false,
    supportsFiles: true,
    supportsDiff: true,
    supportsMerge: false,
    isRemoteCapable: true,
  };

  parseFileType(relativePath: string): FileType {
    if (
      (relativePath.includes("/chats/") ||
        relativePath.includes("\\chats\\")) &&
      relativePath.endsWith(".json")
    ) {
      return "session";
    }
    return "other";
  }

  getSessionFilePattern(): RegExp {
    return /\.json$/;
  }

  normalizeSession(loaded: LoadedSession): Session {
    return normalizeGeminiSession(loaded);
  }

  getStaleInTurnThresholdMs(): number {
    return 5 * 60 * 1000; // 5 minutes
  }

  getDenyFeedbackBehavior(): "queue-followup" | "silent" {
    return "silent";
  }

  getAgentProvider(): AgentProvider | null {
    return geminiACPProvider;
  }

  getScanner(): ProviderScanner {
    return this.scanner;
  }
}
