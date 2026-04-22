import { OPENCODE_STORAGE_DIR } from "../sessions/opencode-reader.js";
import { OpenCodeSessionReader } from "../sessions/opencode-reader.js";
import type { ISessionReader } from "../sessions/types.js";
import type { Project } from "../supervisor/types.js";
import type { FileType, ProviderDescriptor } from "./descriptor.js";

export class OpenCodeProviderDescriptor implements ProviderDescriptor {
  readonly names = ["opencode"];
  readonly group = "opencode";

  createReader(project: Project): ISessionReader {
    return new OpenCodeSessionReader({
      projectPath: project.path,
    });
  }

  createExtraReader(): ISessionReader | null {
    return null;
  }

  getSessionDir(): string {
    return OPENCODE_STORAGE_DIR;
  }

  createScanner(): null {
    return null;
  }

  getWatchConfig(): { periodicRescanMs: number } {
    return { periodicRescanMs: 0 };
  }

  capabilities = {
    supportsFork: false,
    supportsFiles: true,
    supportsDiff: true,
    supportsMerge: false,
    isRemoteCapable: false,
  };

  parseFileType(_relativePath: string): FileType {
    return "other";
  }
}
