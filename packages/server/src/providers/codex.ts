import {
  CODEX_SESSIONS_DIR,
  CodexSessionScanner,
} from "../projects/codex-scanner.js";
import { CodexSessionReader } from "../sessions/codex-reader.js";
import type { ISessionReader } from "../sessions/types.js";
import type { Project } from "../supervisor/types.js";
import type {
  FileType,
  ProviderDescriptor,
  ProviderScanner,
} from "./descriptor.js";

export class CodexProviderDescriptor implements ProviderDescriptor {
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
}
