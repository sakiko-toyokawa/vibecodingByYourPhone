import type { DeviceInfo } from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { DeviceBridgeService } from "../device/DeviceBridgeService.js";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import {
  isValidSshHostAlias,
  normalizeSshHostAlias,
} from "../utils/sshHostAlias.js";

interface DeviceRoutesDeps {
  deviceBridgeService: DeviceBridgeService;
  serverSettingsService?: ServerSettingsService;
}

function mergeConfiguredChromeOSHosts(
  devices: DeviceInfo[],
  rawHosts: unknown,
): DeviceInfo[] {
  if (!Array.isArray(rawHosts) || rawHosts.length === 0) {
    return devices;
  }

  const existingIds = new Set(devices.map((device) => device.id));
  const additions: DeviceInfo[] = [];

  for (const rawHost of rawHosts) {
    if (typeof rawHost !== "string") continue;
    const host = normalizeSshHostAlias(rawHost);
    if (!host || !isValidSshHostAlias(host)) continue;

    const id = `chromeos:${host}`;
    if (existingIds.has(id)) continue;
    additions.push({
      id,
      label: `ChromeOS (${host})`,
      type: "chromeos",
      state: "connected",
      actions: ["stream"],
      avd: `ChromeOS (${host})`,
    });
  }

  return additions.length > 0 ? [...devices, ...additions] : devices;
}

/**
 * Creates emulator-related API routes.
 *
 * GET  /api/devices                  - List all emulators (running + stopped AVDs)
 * POST /api/devices/:id/start        - Start a stopped emulator
 * POST /api/devices/:id/stop         - Stop a running emulator
 * GET  /api/devices/:id/screenshot   - Get a JPEG screenshot thumbnail
 * POST /api/devices/bridge/download  - Download bridge runtime dependencies from GitHub
 */
export function createDeviceRoutes(deps: DeviceRoutesDeps): Hono {
  const { deviceBridgeService, serverSettingsService } = deps;
  const routes = new Hono();

  // POST /api/devices/bridge/download - Download bridge binary + Android server APK
  routes.post("/bridge/download", async (c) => {
    try {
      const { binaryPath, apkPath } =
        await deviceBridgeService.downloadRuntimeDependencies();
      return c.json({ ok: true, path: binaryPath, binaryPath, apkPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[DeviceRoutes] POST /bridge/download error:", message);
      return c.json({ ok: false, error: message }, 500);
    }
  });

  // GET /api/devices - List emulators
  routes.get("/", async (c) => {
    try {
      const devices = await deviceBridgeService.listDevices();
      const chromeOsHosts = serverSettingsService?.getSetting("chromeOsHosts");
      const withConfiguredHosts = mergeConfiguredChromeOSHosts(
        devices,
        chromeOsHosts,
      );
      return c.json(withConfiguredHosts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[DeviceRoutes] GET /devices error:", message);
      return c.json({ error: message }, 500);
    }
  });

  // POST /api/devices/:id/start
  routes.post("/:id/start", async (c) => {
    const id = c.req.param("id");
    try {
      await deviceBridgeService.startDevice(id);
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[DeviceRoutes] POST /devices/${id}/start error:`, message);
      return c.json({ error: message }, 500);
    }
  });

  // POST /api/devices/:id/stop
  routes.post("/:id/stop", async (c) => {
    const id = c.req.param("id");
    try {
      await deviceBridgeService.stopDevice(id);
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[DeviceRoutes] POST /devices/${id}/stop error:`, message);
      return c.json({ error: message }, 500);
    }
  });

  // GET /api/devices/:id/screenshot
  routes.get("/:id/screenshot", async (c) => {
    const id = c.req.param("id");
    try {
      const jpeg = await deviceBridgeService.getScreenshot(id);
      return new Response(new Uint8Array(jpeg), {
        headers: { "Content-Type": "image/jpeg" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[DeviceRoutes] GET /devices/${id}/screenshot error:`,
        message,
      );
      return c.json({ error: message }, 500);
    }
  });

  return routes;
}
