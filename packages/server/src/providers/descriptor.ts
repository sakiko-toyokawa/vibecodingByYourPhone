import type { ISessionReader } from "../sessions/types.js";
import type { Project } from "../supervisor/types.js";

export interface ProviderScanner {
  getSessionsForProject(
    projectPath: string,
  ): Promise<Array<{ id: string; filePath: string }>>;
  invalidateCache(): void;
}

export type FileType = "session" | "agent-session" | "other";

export interface ProviderDescriptor {
  readonly names: string[];
  readonly group: string;

  createReader(project: Project): ISessionReader;
  createExtraReader(projectPath: string): ISessionReader | null;
  getSessionDir(): string;

  createScanner(options: { sessionsDir?: string }): ProviderScanner | null;

  getWatchConfig(): { periodicRescanMs: number };

  parseFileType(relativePath: string): FileType;

  capabilities: {
    supportsFork: boolean;
    supportsFiles: boolean;
    supportsDiff: boolean;
    supportsMerge: boolean;
    isRemoteCapable: boolean;
  };
}
