/**
 * BrowserProfileService - Tracks browser profiles and their connection origins
 *
 * Handles:
 * - Recording connection metadata (origin, scheme, hostname, port)
 * - Persisting browser profile history to disk
 * - Providing profile data for the Devices settings UI
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  BrowserProfileInfo,
  BrowserProfileOrigin,
} from "@yep-anywhere/shared";

const CURRENT_VERSION = 1;

/** Internal state structure for persistence */
interface BrowserProfileState {
  version: number;
  profiles: Record<string, StoredBrowserProfile>;
}

/** Stored profile without deviceName (added at query time from push service) */
interface StoredBrowserProfile {
  browserProfileId: string;
  origins: BrowserProfileOrigin[];
  createdAt: string;
  lastActiveAt: string;
}

/** Origin metadata received from client connection */
export interface OriginMetadata {
  origin: string;
  scheme: string;
  hostname: string;
  port: number | null;
  userAgent: string;
}

export interface BrowserProfileServiceOptions {
  /** Directory to store profile data (defaults to ~/.yep-anywhere) */
  dataDir?: string;
}

export class BrowserProfileService {
  private state: BrowserProfileState;
  private dataDir: string;
  private filePath: string;
  private initialized = false;
  private savePromise: Promise<void> | null = null;
  private pendingSave = false;

  constructor(options: BrowserProfileServiceOptions = {}) {
    this.dataDir =
      options.dataDir ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".yep-anywhere",
      );
    this.filePath = path.join(this.dataDir, "browser-profiles.json");
    this.state = { version: CURRENT_VERSION, profiles: {} };
  }

  /**
   * Initialize the service by loading state from disk.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(this.dataDir, { recursive: true });

      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as BrowserProfileState;

      if (parsed.version === CURRENT_VERSION) {
        this.state = parsed;
      } else {
        // Future: handle migrations
        this.state = {
          version: CURRENT_VERSION,
          profiles: parsed.profiles ?? {},
        };
        await this.save();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[BrowserProfileService] Failed to load profiles, starting fresh:",
          error,
        );
      }
      this.state = { version: CURRENT_VERSION, profiles: {} };
    }

    this.initialized = true;
  }

  /**
   * Record a connection from a browser profile.
   * Updates lastSeen if origin exists, or adds new origin.
   */
  async recordConnection(
    browserProfileId: string,
    metadata: OriginMetadata,
  ): Promise<void> {
    this.ensureInitialized();

    const now = new Date().toISOString();
    let profile = this.state.profiles[browserProfileId];

    if (!profile) {
      // New profile
      profile = {
        browserProfileId,
        origins: [],
        createdAt: now,
        lastActiveAt: now,
      };
      this.state.profiles[browserProfileId] = profile;
    }

    // Update lastActiveAt
    profile.lastActiveAt = now;

    // Find existing origin or add new one
    const existingOrigin = profile.origins.find(
      (o) => o.origin === metadata.origin,
    );

    if (existingOrigin) {
      // Update existing origin
      existingOrigin.lastSeen = now;
      existingOrigin.userAgent = metadata.userAgent;
    } else {
      // Add new origin
      profile.origins.push({
        origin: metadata.origin,
        scheme: metadata.scheme,
        hostname: metadata.hostname,
        port: metadata.port,
        userAgent: metadata.userAgent,
        firstSeen: now,
        lastSeen: now,
      });
    }

    await this.save();
  }

  /**
   * Get all browser profiles.
   */
  getProfiles(): StoredBrowserProfile[] {
    this.ensureInitialized();
    return Object.values(this.state.profiles);
  }

  /**
   * Get profiles enriched with device names from push subscriptions.
   */
  getProfilesWithDeviceNames(
    pushSubscriptions: Record<string, { deviceName?: string }>,
  ): BrowserProfileInfo[] {
    this.ensureInitialized();

    return Object.values(this.state.profiles).map((profile) => ({
      ...profile,
      deviceName: pushSubscriptions[profile.browserProfileId]?.deviceName,
    }));
  }

  /**
   * Get a specific profile by ID.
   */
  getProfile(browserProfileId: string): StoredBrowserProfile | null {
    this.ensureInitialized();
    return this.state.profiles[browserProfileId] ?? null;
  }

  /**
   * Delete a profile (forget device).
   */
  async deleteProfile(browserProfileId: string): Promise<boolean> {
    this.ensureInitialized();

    if (!this.state.profiles[browserProfileId]) {
      return false;
    }

    delete this.state.profiles[browserProfileId];
    await this.save();
    return true;
  }

  /**
   * Get profile count.
   */
  getProfileCount(): number {
    return Object.keys(this.state.profiles).length;
  }

  /**
   * Ensure service is initialized.
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "BrowserProfileService not initialized. Call initialize() first.",
      );
    }
  }

  /**
   * Save state to disk with debouncing.
   */
  private async save(): Promise<void> {
    if (this.savePromise) {
      this.pendingSave = true;
      return;
    }

    this.savePromise = this.doSave();
    await this.savePromise;
    this.savePromise = null;

    if (this.pendingSave) {
      this.pendingSave = false;
      await this.save();
    }
  }

  private async doSave(): Promise<void> {
    try {
      const content = JSON.stringify(this.state, null, 2);
      await fs.writeFile(this.filePath, content, "utf-8");
    } catch (error) {
      console.error("[BrowserProfileService] Failed to save profiles:", error);
      throw error;
    }
  }

  /**
   * Get file path (for testing).
   */
  getFilePath(): string {
    return this.filePath;
  }
}
