import { Hono } from "hono";

export interface ServerInfoOptions {
  host?: string;
  port?: number;
  getServerInfo?: () => { host: string; port: number };
  installId?: string;
  /** Whether device bridge streaming is available (ADB detected + sidecar binary exists) */
  deviceBridgeAvailable?: boolean;
}

export interface ServerCapabilities {
  /** Whether device bridge streaming is available */
  deviceBridge: boolean;
}

export interface ServerInfo {
  /** The host/interface the server is bound to (e.g., "127.0.0.1" or "0.0.0.0") */
  host: string;
  /** The port the server is listening on */
  port: number;
  /** Whether the server is bound to all interfaces (0.0.0.0) */
  boundToAllInterfaces: boolean;
  /** Whether the server is localhost-only */
  localhostOnly: boolean;
  /** Unique installation identifier for this server instance */
  installId?: string;
  /** Server capabilities (optional features) */
  capabilities?: ServerCapabilities;
}

export function createServerInfoRoutes(options: ServerInfoOptions) {
  const app = new Hono();

  app.get("/", (c) => {
    const current = options.getServerInfo?.() ?? {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
    };
    const info: ServerInfo = {
      host: current.host,
      port: current.port,
      boundToAllInterfaces: current.host === "0.0.0.0" || current.host === "::",
      localhostOnly:
        current.host === "127.0.0.1" ||
        current.host === "localhost" ||
        current.host === "::1",
      installId: options.installId,
      capabilities: {
        deviceBridge: options.deviceBridgeAvailable ?? false,
      },
    };
    return c.json(info);
  });

  return app;
}
