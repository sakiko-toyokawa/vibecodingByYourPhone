import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "yep-settings-"));
}

describe("ServerSettingsService", () => {
  it("initializes new installs with Codex GPT-5.4 session defaults", async () => {
    const dataDir = await createTempDir();
    const service = new ServerSettingsService({ dataDir });

    await service.initialize();

    expect(service.getSetting("newSessionDefaults")).toEqual({
      provider: "codex",
      model: "gpt-5.4",
      permissionMode: "bypassPermissions",
    });
  });

  it("fills missing nested new session default fields without overwriting saved values", async () => {
    const dataDir = await createTempDir();
    await writeFile(
      join(dataDir, "server-settings.json"),
      JSON.stringify({
        version: 1,
        settings: {
          serviceWorkerEnabled: false,
          persistRemoteSessionsToDisk: false,
          newSessionDefaults: {
            provider: "claude",
          },
        },
      }),
      "utf-8",
    );

    const service = new ServerSettingsService({ dataDir });
    await service.initialize();

    expect(service.getSettings()).toMatchObject({
      serviceWorkerEnabled: false,
      newSessionDefaults: {
        provider: "claude",
        model: "gpt-5.4",
        permissionMode: "bypassPermissions",
      },
    });
  });

  it("persists default new session settings when saving a fresh config", async () => {
    const dataDir = await createTempDir();
    const service = new ServerSettingsService({ dataDir });

    await service.initialize();
    await service.updateSettings({ serviceWorkerEnabled: false });

    const saved = JSON.parse(
      await readFile(join(dataDir, "server-settings.json"), "utf-8"),
    );
    expect(saved.settings.newSessionDefaults).toEqual({
      provider: "codex",
      model: "gpt-5.4",
      permissionMode: "bypassPermissions",
    });
  });
});
