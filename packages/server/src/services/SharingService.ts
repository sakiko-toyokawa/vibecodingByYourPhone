/**
 * Session Sharing Service
 *
 * Uploads HTML snapshots to a Cloudflare Worker backed by R2.
 * The Worker handles storage — this service just needs the URL and a shared secret.
 * Config file is created manually at {dataDir}/sharing.json.
 *
 * See sharing-worker/ for the Cloudflare Worker code and setup instructions.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { enforceOwnerReadWriteFilePermissions } from "../utils/filePermissions.js";

export interface SharingConfig {
  workerUrl: string;
  secret: string;
  prefix?: string;
}

export interface SharingServiceOptions {
  dataDir: string;
}

const MAX_HTML_BYTES = 10 * 1024 * 1024; // 10 MB pre-gzip

export class SharingService {
  private config: SharingConfig | null = null;
  private readonly filePath: string;

  constructor(options: SharingServiceOptions) {
    this.filePath = path.join(options.dataDir, "sharing.json");
  }

  async initialize(): Promise<void> {
    try {
      await enforceOwnerReadWriteFilePermissions(this.filePath, "[sharing]");
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content);
      if (this.validateConfig(parsed)) {
        this.config = parsed;
        console.log("[sharing] Configuration loaded");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return; // File doesn't exist — sharing not configured
      }
      console.warn("[sharing] Failed to load config:", error);
    }
  }

  isConfigured(): boolean {
    return this.config !== null;
  }

  getPublicConfig(): { configured: boolean } {
    return { configured: this.config !== null };
  }

  async uploadHtml(html: string, _title?: string): Promise<{ url: string }> {
    if (!this.config) {
      throw new Error("Sharing not configured");
    }

    const htmlBytes = Buffer.byteLength(html, "utf-8");
    if (htmlBytes > MAX_HTML_BYTES) {
      throw new Error(
        `HTML too large: ${Math.round(htmlBytes / 1024 / 1024)}MB (max ${MAX_HTML_BYTES / 1024 / 1024}MB)`,
      );
    }

    const { workerUrl, secret, prefix = "sessions/" } = this.config;
    const key = `${prefix}${randomUUID()}.html`;

    const res = await fetch(`${workerUrl.replace(/\/$/, "")}/${key}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${secret}`,
      },
      body: html,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Upload failed (${res.status}): ${text}`);
    }

    const result = (await res.json()) as { url: string };
    console.log(`[sharing] Uploaded ${key} (${htmlBytes} bytes)`);
    return result;
  }

  private validateConfig(obj: unknown): obj is SharingConfig {
    if (!obj || typeof obj !== "object") return false;
    const c = obj as Record<string, unknown>;

    if (typeof c.workerUrl !== "string" || !c.workerUrl) {
      console.warn("[sharing] Missing or empty field: workerUrl");
      return false;
    }
    if (typeof c.secret !== "string" || !c.secret) {
      console.warn("[sharing] Missing or empty field: secret");
      return false;
    }

    return true;
  }
}
