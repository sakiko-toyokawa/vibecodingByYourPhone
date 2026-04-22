/**
 * InstallService manages a unique installation identifier for this yepanywhere instance.
 * The install ID is used by the relay server to verify username ownership - if an
 * installation disconnects and reconnects, it can reclaim its username using the same ID.
 *
 * State is persisted to a JSON file for durability across server restarts.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface InstallState {
  /** Schema version for future migrations */
  version: number;
  /** Unique installation identifier (crypto.randomUUID()) */
  installId: string;
  /** ISO timestamp when this install was first created */
  createdAt: string;
}

const CURRENT_VERSION = 1;

export interface InstallServiceOptions {
  /** Directory to store install state (defaults to ~/.yep-anywhere) */
  dataDir?: string;
}

export class InstallService {
  private state: InstallState | null = null;
  private dataDir: string;
  private filePath: string;

  constructor(options: InstallServiceOptions = {}) {
    this.dataDir =
      options.dataDir ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".yep-anywhere",
      );
    this.filePath = path.join(this.dataDir, "install.json");
  }

  /**
   * Initialize the service by loading or creating state from disk.
   * Creates the data directory and file if they don't exist.
   */
  async initialize(): Promise<void> {
    console.log(`[InstallService] Initializing from: ${this.filePath}`);
    try {
      // Ensure data directory exists
      await fs.mkdir(this.dataDir, { recursive: true });

      // Try to load existing state
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as InstallState;

      // Validate required fields
      if (
        typeof parsed.installId === "string" &&
        parsed.installId.length > 0 &&
        typeof parsed.createdAt === "string"
      ) {
        console.log(
          `[InstallService] Loaded existing install ID: ${parsed.installId}`,
        );

        // Handle migrations if needed
        if (parsed.version === CURRENT_VERSION) {
          this.state = parsed;
        } else {
          // Future: handle migrations here
          this.state = {
            version: CURRENT_VERSION,
            installId: parsed.installId,
            createdAt: parsed.createdAt,
          };
          await this.save();
        }
      } else {
        // Invalid state, regenerate
        console.warn(
          "[InstallService] Invalid state found, generating new install ID",
        );
        await this.generateNew();
      }
    } catch (error) {
      // File doesn't exist or is invalid - generate new
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[InstallService] Failed to load state, generating new install ID:",
          error,
        );
      }
      await this.generateNew();
    }
  }

  /**
   * Generate a new installation ID and persist it.
   */
  private async generateNew(): Promise<void> {
    this.state = {
      version: CURRENT_VERSION,
      installId: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    console.log(
      `[InstallService] Generated new install ID: ${this.state.installId}`,
    );
    await this.save();
  }

  /**
   * Get the unique installation identifier.
   * @throws Error if the service has not been initialized
   */
  getInstallId(): string {
    if (!this.state) {
      throw new Error(
        "InstallService not initialized. Call initialize() first.",
      );
    }
    return this.state.installId;
  }

  /**
   * Get the creation timestamp.
   * @throws Error if the service has not been initialized
   */
  getCreatedAt(): string {
    if (!this.state) {
      throw new Error(
        "InstallService not initialized. Call initialize() first.",
      );
    }
    return this.state.createdAt;
  }

  /**
   * Save state to disk.
   */
  private async save(): Promise<void> {
    if (!this.state) {
      throw new Error("Cannot save: no state to persist");
    }
    try {
      const content = JSON.stringify(this.state, null, 2);
      await fs.writeFile(this.filePath, content, "utf-8");
    } catch (error) {
      console.error("[InstallService] Failed to save state:", error);
      throw error;
    }
  }

  /**
   * Get the file path for testing purposes.
   */
  getFilePath(): string {
    return this.filePath;
  }
}
