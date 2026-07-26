import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  OWNER_READ_WRITE_FILE_MODE,
  enforceOwnerReadWriteFilePermissions,
} from "../utils/filePermissions.js";

const CURRENT_VERSION = 1;

interface GitHubCredentialState {
  version: number;
  token?: string;
  updatedAt?: string;
}

export interface GitHubCredentialStatus {
  configured: boolean;
  tokenPreview: string | null;
  updatedAt: string | null;
}

export interface GitHubCredentialStoreOptions {
  dataDir: string;
}

function maskToken(token: string): string {
  if (token.length <= 8) {
    return "****";
  }
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

export class GitHubCredentialStore {
  private readonly filePath: string;
  private state: GitHubCredentialState = { version: CURRENT_VERSION };
  private initialized = false;

  constructor(options: GitHubCredentialStoreOptions) {
    this.filePath = path.join(options.dataDir, "github-credentials.json");
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await enforceOwnerReadWriteFilePermissions(
      this.filePath,
      "[GitHubCredentialStore]",
    );
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as GitHubCredentialState;
      this.state = {
        version: CURRENT_VERSION,
        token: typeof parsed.token === "string" ? parsed.token : undefined,
        updatedAt:
          typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[GitHubCredentialStore] Failed to load credentials, starting empty:",
          error,
        );
      }
      this.state = { version: CURRENT_VERSION };
    }
    this.initialized = true;
  }

  async setToken(token: string): Promise<void> {
    this.ensureInitialized();
    const trimmed = token.trim();
    if (!trimmed) {
      throw new Error("GitHub token is required");
    }
    this.state = {
      version: CURRENT_VERSION,
      token: trimmed,
      updatedAt: new Date().toISOString(),
    };
    await this.save();
  }

  async clearToken(): Promise<void> {
    this.ensureInitialized();
    this.state = { version: CURRENT_VERSION };
    await this.save();
  }

  async getToken(): Promise<string | null> {
    this.ensureInitialized();
    return this.state.token ?? null;
  }

  getStatus(): GitHubCredentialStatus {
    this.ensureInitialized();
    return {
      configured: Boolean(this.state.token),
      tokenPreview: this.state.token ? maskToken(this.state.token) : null,
      updatedAt: this.state.updatedAt ?? null,
    };
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "GitHubCredentialStore not initialized. Call initialize() first.",
      );
    }
  }

  private async save(): Promise<void> {
    const content = JSON.stringify(this.state, null, 2);
    await fs.writeFile(this.filePath, content, {
      encoding: "utf-8",
      mode: OWNER_READ_WRITE_FILE_MODE,
    });
    await enforceOwnerReadWriteFilePermissions(
      this.filePath,
      "[GitHubCredentialStore]",
    );
  }
}
