import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InstallService } from "../../src/services/InstallService.js";

describe("InstallService", () => {
  let testDir: string;
  let service: InstallService;

  beforeEach(async () => {
    testDir = join(tmpdir(), `install-service-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    service = new InstallService({ dataDir: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("initialization", () => {
    it("generates new ID on first run", async () => {
      await service.initialize();

      const installId = service.getInstallId();
      expect(installId).toBeDefined();
      expect(installId.length).toBeGreaterThan(0);
      // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      expect(installId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("persists and reloads same ID", async () => {
      await service.initialize();
      const originalId = service.getInstallId();

      // Create new instance and verify it loads the same ID
      const newService = new InstallService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getInstallId()).toBe(originalId);
    });

    it("creates install.json file with correct structure", async () => {
      await service.initialize();

      const content = await readFile(join(testDir, "install.json"), "utf-8");
      const state = JSON.parse(content);

      expect(state.version).toBe(1);
      expect(state.installId).toBe(service.getInstallId());
      expect(state.createdAt).toBeDefined();
      // Verify createdAt is a valid ISO timestamp
      expect(new Date(state.createdAt).toISOString()).toBe(state.createdAt);
    });

    it("handles corrupted JSON by regenerating", async () => {
      await writeFile(join(testDir, "install.json"), "not valid json{{{");

      // Should not throw
      await service.initialize();

      // Should have a valid new ID
      const installId = service.getInstallId();
      expect(installId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("handles missing installId field by regenerating", async () => {
      const badState = {
        version: 1,
        createdAt: new Date().toISOString(),
        // installId is missing
      };
      await writeFile(join(testDir, "install.json"), JSON.stringify(badState));

      await service.initialize();

      // Should have a valid new ID
      const installId = service.getInstallId();
      expect(installId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("handles empty installId field by regenerating", async () => {
      const badState = {
        version: 1,
        installId: "",
        createdAt: new Date().toISOString(),
      };
      await writeFile(join(testDir, "install.json"), JSON.stringify(badState));

      await service.initialize();

      // Should have a valid new ID (not empty)
      const installId = service.getInstallId();
      expect(installId.length).toBeGreaterThan(0);
      expect(installId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("handles missing createdAt field by regenerating", async () => {
      const badState = {
        version: 1,
        installId: randomUUID(),
        // createdAt is missing
      };
      await writeFile(join(testDir, "install.json"), JSON.stringify(badState));

      await service.initialize();

      // Should have regenerated with a new ID
      const installId = service.getInstallId();
      expect(installId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      // New ID should be different from the bad one
      expect(installId).not.toBe(badState.installId);
    });

    it("preserves valid state even with different version", async () => {
      const oldVersionState = {
        version: 0, // Old version
        installId: "preserved-uuid-value-here",
        createdAt: "2024-01-01T00:00:00.000Z",
      };
      await writeFile(
        join(testDir, "install.json"),
        JSON.stringify(oldVersionState),
      );

      // This should fail validation since installId isn't a valid UUID format
      // Let's use a proper UUID
      const validUuid = randomUUID();
      const oldVersionStateValid = {
        version: 0,
        installId: validUuid,
        createdAt: "2024-01-01T00:00:00.000Z",
      };
      await writeFile(
        join(testDir, "install.json"),
        JSON.stringify(oldVersionStateValid),
      );

      await service.initialize();

      // Should preserve the install ID but update version
      expect(service.getInstallId()).toBe(validUuid);
      expect(service.getCreatedAt()).toBe("2024-01-01T00:00:00.000Z");

      // Verify file was updated with new version
      const content = await readFile(join(testDir, "install.json"), "utf-8");
      const state = JSON.parse(content);
      expect(state.version).toBe(1);
    });
  });

  describe("getInstallId", () => {
    it("throws if not initialized", () => {
      expect(() => service.getInstallId()).toThrow(
        "InstallService not initialized",
      );
    });

    it("returns consistent value after initialization", async () => {
      await service.initialize();

      const id1 = service.getInstallId();
      const id2 = service.getInstallId();

      expect(id1).toBe(id2);
    });
  });

  describe("getCreatedAt", () => {
    it("throws if not initialized", () => {
      expect(() => service.getCreatedAt()).toThrow(
        "InstallService not initialized",
      );
    });

    it("returns valid ISO timestamp", async () => {
      await service.initialize();

      const createdAt = service.getCreatedAt();
      expect(new Date(createdAt).toISOString()).toBe(createdAt);
    });

    it("preserves original creation time across restarts", async () => {
      await service.initialize();
      const originalCreatedAt = service.getCreatedAt();

      // Wait a tiny bit to ensure time has passed
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Create new instance and verify createdAt is preserved
      const newService = new InstallService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getCreatedAt()).toBe(originalCreatedAt);
    });
  });

  describe("file path", () => {
    it("returns the correct file path", () => {
      expect(service.getFilePath()).toBe(join(testDir, "install.json"));
    });
  });

  describe("data directory creation", () => {
    it("creates data directory if it does not exist", async () => {
      const nestedDir = join(testDir, "nested", "deep", "path");
      const nestedService = new InstallService({ dataDir: nestedDir });

      await nestedService.initialize();

      // Should have created the directory and file
      const content = await readFile(join(nestedDir, "install.json"), "utf-8");
      expect(JSON.parse(content).installId).toBe(nestedService.getInstallId());
    });
  });
});
