import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type VapidKeys,
  generateVapidKeys,
  loadVapidKeys,
  validateVapidKeys,
} from "../../src/push/vapid.js";

describe("setup-vapid", () => {
  let tempDir: string;
  let vapidFile: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vapid-test-"));
    vapidFile = path.join(tempDir, "vapid.json");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("validateVapidKeys", () => {
    it("should accept valid keys", async () => {
      const keys = await generateVapidKeys(vapidFile);
      const result = validateVapidKeys(keys);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("should reject missing publicKey", () => {
      const keys = {
        publicKey: "",
        privateKey: "valid",
        subject: "mailto:test@example.com",
      };
      const result = validateVapidKeys(keys);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("publicKey");
    });

    it("should reject missing privateKey", () => {
      const keys = {
        publicKey: "valid",
        privateKey: "",
        subject: "mailto:test@example.com",
      };
      const result = validateVapidKeys(keys);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("privateKey");
    });

    it("should reject invalid subject format", () => {
      const keys: VapidKeys = {
        publicKey: "BNxRk7W5c...",
        privateKey: "Ux3jK...",
        subject: "invalid-subject",
      };
      const result = validateVapidKeys(keys);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("mailto:");
    });

    it("should accept https:// subject", async () => {
      const keys = await generateVapidKeys(vapidFile, "https://example.com");
      const result = validateVapidKeys(keys);
      expect(result.valid).toBe(true);
    });

    it("should reject wrong public key length", () => {
      // Create a valid-looking but wrong-length key
      const shortKey = Buffer.alloc(32).toString("base64url");
      const keys: VapidKeys = {
        publicKey: shortKey,
        privateKey: Buffer.alloc(32).toString("base64url"),
        subject: "mailto:test@example.com",
      };
      const result = validateVapidKeys(keys);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("65 bytes");
    });

    it("should reject wrong private key length", async () => {
      // Generate valid keys first, then corrupt private key
      const validKeys = await generateVapidKeys(vapidFile);
      const keys: VapidKeys = {
        ...validKeys,
        privateKey: Buffer.alloc(16).toString("base64url"),
      };
      const result = validateVapidKeys(keys);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("32 bytes");
    });
  });

  describe("generateVapidKeys", () => {
    it("should generate valid VAPID keys", async () => {
      const keys = await generateVapidKeys(vapidFile);

      expect(keys.publicKey).toBeTruthy();
      expect(keys.privateKey).toBeTruthy();
      expect(keys.subject).toBe("mailto:yep-anywhere@localhost");

      const validation = validateVapidKeys(keys);
      expect(validation.valid).toBe(true);
    });

    it("should save keys to file", async () => {
      await generateVapidKeys(vapidFile);

      const content = await fs.readFile(vapidFile, "utf-8");
      const saved = JSON.parse(content) as VapidKeys;

      expect(saved.publicKey).toBeTruthy();
      expect(saved.privateKey).toBeTruthy();
      expect(saved.subject).toBeTruthy();
    });

    it("should create directory if it doesn't exist", async () => {
      const nestedFile = path.join(tempDir, "nested", "dir", "vapid.json");
      await generateVapidKeys(nestedFile);

      const exists = await fs
        .access(nestedFile)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    it("should use custom subject", async () => {
      const keys = await generateVapidKeys(
        vapidFile,
        "mailto:custom@example.com",
      );
      expect(keys.subject).toBe("mailto:custom@example.com");
    });

    it("should generate unique keys each time", async () => {
      const keys1 = await generateVapidKeys(vapidFile);
      const keys2 = await generateVapidKeys(path.join(tempDir, "vapid2.json"));

      expect(keys1.publicKey).not.toBe(keys2.publicKey);
      expect(keys1.privateKey).not.toBe(keys2.privateKey);
    });
  });

  describe("loadVapidKeys", () => {
    it("should load existing valid keys", async () => {
      const original = await generateVapidKeys(vapidFile);
      const loaded = await loadVapidKeys(vapidFile);

      expect(loaded).not.toBeNull();
      expect(loaded?.publicKey).toBe(original.publicKey);
      expect(loaded?.privateKey).toBe(original.privateKey);
      expect(loaded?.subject).toBe(original.subject);
    });

    it("should return null for non-existent file", async () => {
      const loaded = await loadVapidKeys(
        path.join(tempDir, "nonexistent.json"),
      );
      expect(loaded).toBeNull();
    });

    it("should return null for invalid JSON", async () => {
      await fs.writeFile(vapidFile, "not valid json");
      const loaded = await loadVapidKeys(vapidFile);
      expect(loaded).toBeNull();
    });

    it("should return null for invalid keys", async () => {
      await fs.writeFile(
        vapidFile,
        JSON.stringify({
          publicKey: "short",
          privateKey: "short",
          subject: "invalid",
        }),
      );
      const loaded = await loadVapidKeys(vapidFile);
      expect(loaded).toBeNull();
    });

    it("should tighten permissions on existing vapid.json files at load", async () => {
      if (process.platform === "win32") {
        return;
      }

      await generateVapidKeys(vapidFile);
      await fs.chmod(vapidFile, 0o644);

      const loaded = await loadVapidKeys(vapidFile);
      expect(loaded).not.toBeNull();

      const stat = await fs.stat(vapidFile);
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  describe("idempotency", () => {
    it("should not overwrite existing valid keys when loaded", async () => {
      // Generate keys
      const original = await generateVapidKeys(vapidFile);

      // Load them back
      const loaded = await loadVapidKeys(vapidFile);

      // Keys should be identical
      expect(loaded?.publicKey).toBe(original.publicKey);
      expect(loaded?.privateKey).toBe(original.privateKey);
    });
  });
});
