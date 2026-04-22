import { describe, expect, it, vi } from "vitest";
import type { DeviceBridgeService } from "../../src/device/DeviceBridgeService.js";
import { createDeviceRoutes } from "../../src/routes/devices.js";
import type { ServerSettingsService } from "../../src/services/ServerSettingsService.js";

describe("Device Routes", () => {
  it("returns binaryPath and apkPath from POST /bridge/download", async () => {
    const downloadRuntimeDependencies = vi.fn().mockResolvedValue({
      binaryPath: "/tmp/device-bridge-linux-amd64",
      apkPath: "/tmp/yep-device-server.apk",
    });

    const routes = createDeviceRoutes({
      deviceBridgeService: {
        downloadRuntimeDependencies,
      } as unknown as DeviceBridgeService,
    });

    const response = await routes.request("/bridge/download", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({
      ok: true,
      path: "/tmp/device-bridge-linux-amd64",
      binaryPath: "/tmp/device-bridge-linux-amd64",
      apkPath: "/tmp/yep-device-server.apk",
    });
    expect(downloadRuntimeDependencies).toHaveBeenCalledTimes(1);
  });

  it("merges chromeOsHosts from server settings into GET /", async () => {
    const listDevices = vi.fn().mockResolvedValue([
      {
        id: "emulator-5554",
        label: "Pixel_7",
        type: "emulator",
        state: "running",
        actions: ["stream", "stop", "screenshot"],
      },
      {
        id: "chromeos:chromeroot",
        label: "ChromeOS (chromeroot)",
        type: "chromeos",
        state: "connected",
        actions: ["stream"],
      },
    ]);

    const routes = createDeviceRoutes({
      deviceBridgeService: {
        listDevices,
      } as unknown as DeviceBridgeService,
      serverSettingsService: {
        getSetting: vi
          .fn()
          .mockImplementation((key: string) =>
            key === "chromeOsHosts"
              ? ["chromeroot", "lab-book", "-oProxyCommand=bad"]
              : undefined,
          ),
      } as unknown as ServerSettingsService,
    });

    const response = await routes.request("/", { method: "GET" });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual([
      {
        id: "emulator-5554",
        label: "Pixel_7",
        type: "emulator",
        state: "running",
        actions: ["stream", "stop", "screenshot"],
      },
      {
        id: "chromeos:chromeroot",
        label: "ChromeOS (chromeroot)",
        type: "chromeos",
        state: "connected",
        actions: ["stream"],
      },
      {
        id: "chromeos:lab-book",
        label: "ChromeOS (lab-book)",
        type: "chromeos",
        state: "connected",
        actions: ["stream"],
        avd: "ChromeOS (lab-book)",
      },
    ]);
    expect(listDevices).toHaveBeenCalledTimes(1);
  });
});
