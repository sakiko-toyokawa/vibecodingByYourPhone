import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import * as os from "node:os";
import { serve } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { createNodeWebSocket } from "@hono/node-ws";
import { createApp } from "./app.js";
import { container } from "./container.js";
import {
  attachUnifiedUpgradeHandler,
  createFrontendProxy,
  createStaticRoutes,
} from "./frontend/index.js";
import { ensureSelfSignedCertificate } from "./https/self-signed.js";
import { RunStateStore } from "./loop/control-plane/run-state-store.js";
import {
  setDebugContext,
  startMaintenanceServer,
} from "./maintenance/index.js";
import { CodexSessionScanner } from "./projects/codex-scanner.js";
import { GeminiSessionScanner } from "./projects/gemini-scanner.js";
import { ProjectScanner } from "./projects/scanner.js";
import type { ProviderScanner } from "./providers/descriptor.js";
import { createUploadRoutes } from "./routes/upload.js";
import { getServerCompatibilityInfo } from "./routes/version.js";
import {
  createAcceptRelayConnection,
  createWsRelayRoutes,
} from "./routes/ws-relay.js";
import { ClaudeSessionReader } from "./sessions/reader.js";
import {
  setDeviceBridgeForShutdown,
  setSupervisorForShutdown,
} from "./shutdown.js";
import { UploadManager } from "./uploads/manager.js";
import { FocusedSessionWatchManager } from "./watcher/index.js";

export async function startServer(): Promise<{
  onLocalhostPortChange: (
    port: number,
  ) => Promise<{ success: boolean; error?: string; redirectUrl?: string }>;
  onNetworkBindingChange: (
    config: { host: string; port: number } | null,
  ) => Promise<{ success: boolean; error?: string }>;
}> {
  const services = container.cradle;
  const {
    config,
    eventBus,
    realSdk,
    notificationService,
    sessionMetadataService,
    projectMetadataService,
    sessionIndexService,
    pushService,
    recentsService,
    authService,
    remoteAccessService,
    remoteSessionService,
    installService,
    relayClientService,
    networkBindingService,
    connectedBrowsersService,
    browserProfileService,
    serverSettingsService,
    sharingService,
    modelInfoService,
    deviceBridgeService,
  } = services;

  let tlsOptions: { key: Buffer; cert: Buffer } | undefined;
  if (config.httpsSelfSigned) {
    const certResult = ensureSelfSignedCertificate({
      dataDir: config.dataDir,
      host: config.host,
    });
    tlsOptions = {
      key: certResult.key,
      cert: certResult.cert,
    };
    console.log(
      `[HTTPS] ${certResult.generated ? "Generated" : "Using existing"} self-signed certificate at ${certResult.certPath}`,
    );
  }
  const serverProtocol = tlsOptions ? "https" : "http";

  // Determine if we're in production mode (no Vite dev server)
  const isProduction = process.env.NODE_ENV === "production";
  const isDev = !isProduction;

  // Frontend serving setup - create proxy before app so it can be passed in
  let frontendProxy: ReturnType<typeof createFrontendProxy> | undefined;

  if (config.serveFrontend && isDev) {
    // Development: proxy to Vite dev server
    frontendProxy = createFrontendProxy({ vitePort: config.vitePort });
    console.log(
      `[Frontend] Proxying to Vite at http://localhost:${config.vitePort}`,
    );
  }

  // Callback holder for relay config changes - will be set after app creation
  const relayConfigCallbackHolder: { callback?: () => Promise<void> } = {};

  // Callback holder for network binding changes - will be set after servers are created
  const networkBindingCallbackHolder: {
    onLocalhostPortChange?: (
      port: number,
    ) => Promise<{ success: boolean; error?: string; redirectUrl?: string }>;
    onNetworkBindingChange?: (
      config: { host: string; port: number } | null,
    ) => Promise<{ success: boolean; error?: string }>;
  } = {};

  // Determine effective port for server-info (CLI override or saved setting)
  const effectiveServerPort = networkBindingService.getLocalhostPort();
  const effectiveLocalhostUrl = `${serverProtocol}://127.0.0.1:${effectiveServerPort}`;
  console.log(`Server URL: ${effectiveLocalhostUrl}`);
  const serverInfoState = {
    host: "127.0.0.1",
    port: effectiveServerPort,
  };

  // Create the app first (without WebSocket support initially)
  const { app, supervisor, scanner } = createApp({
    realSdk,
    projectsDir: config.claudeProjectsDir,
    idleTimeoutMs: config.idleTimeoutMs,
    defaultPermissionMode: config.defaultPermissionMode,
    eventBus,
    notificationService,
    sessionMetadataService,
    projectMetadataService,
    sessionIndexService,
    projectScanCacheTtlMs: config.projectScanCacheTtlMs,
    maxWorkers: config.maxWorkers,
    idlePreemptThresholdMs: config.idlePreemptThresholdMs,
    pushService,
    recentsService,
    authService,
    authDisabled: config.authDisabled,
    desktopAuthToken: config.desktopAuthToken,
    remoteAccessService,
    remoteSessionService,
    relayClientService,
    relayConfigCallbackHolder,
    serverHost: "127.0.0.1",
    serverPort: effectiveServerPort,
    getServerInfo: () => ({ ...serverInfoState }),
    installId: installService.getInstallId(),
    dataDir: config.dataDir,
    networkBindingService,
    networkBindingCallbackHolder,
    connectedBrowsers: connectedBrowsersService,
    browserProfileService,
    serverSettingsService,
    sharingService,
    deviceBridgeService,
    modelInfoService,
    enabledProviders: config.enabledProviders,
    voiceInputEnabled: config.voiceInputEnabled,
    allowedImagePaths: config.allowedImagePaths,
    loopTurnIdleTimeoutMs: config.loopTurnIdleTimeoutMs,
    loopTurnIdleCheckIntervalMs: config.loopTurnIdleCheckIntervalMs,
    loopStagnationSimilarTurnsThreshold:
      config.loopStagnationSimilarTurnsThreshold,
    loopIdleNoProgressTurnsThreshold: config.loopIdleNoProgressTurnsThreshold,
    loopRepeatedBlockerThreshold: config.loopRepeatedBlockerThreshold,
    loopTokenAlertRatio: config.loopTokenAlertRatio,
  });

  const extraScanners = new Map<string, ProviderScanner>();
  extraScanners.set(
    "codex",
    new CodexSessionScanner({ sessionsDir: config.codexSessionsDir }),
  );
  extraScanners.set(
    "gemini",
    new GeminiSessionScanner({ sessionsDir: config.geminiSessionsDir }),
  );

  const focusedSessionWatchManager = new FocusedSessionWatchManager({
    scanner,
    extraScanners,
  });

  // Set service references for graceful shutdown
  setSupervisorForShutdown(supervisor);
  setDeviceBridgeForShutdown(deviceBridgeService ?? null);

  // Set up debug context for maintenance server
  setDebugContext({
    supervisor,
    claudeSessionsDir: config.claudeSessionsDir,
    getSessionReader: async (projectPath: string) => {
      // Find the project by scanning - projectPath is the absolute path
      const projects = await scanner.listProjects();
      const project = projects.find((p) => p.path === projectPath);
      if (!project || project.provider !== "claude") return null;
      return new ClaudeSessionReader({ sessionDir: project.sessionDir });
    },
  });

  // Create WebSocket support with the main app
  const { wss, upgradeWebSocket } = createNodeWebSocket({ app });

  // Add upload routes with WebSocket support
  const uploadScanner = new ProjectScanner({
    projectsDir: config.claudeProjectsDir,
  });
  const uploadRoutes = createUploadRoutes({
    scanner: uploadScanner,
    upgradeWebSocket,
    maxUploadSizeBytes: config.maxUploadSizeBytes,
  });
  app.route("/api", uploadRoutes);

  // Add WebSocket relay route for Phase 2b/2c/2d
  const baseUrl = `${serverProtocol}://${config.host}:${config.port}`;
  const wsRelayUploadManager = new UploadManager({
    maxUploadSizeBytes: config.maxUploadSizeBytes,
  });
  const wsRelayHandler = createWsRelayRoutes({
    upgradeWebSocket,
    app,
    baseUrl,
    supervisor,
    eventBus,
    uploadManager: wsRelayUploadManager,
    remoteAccessService,
    remoteSessionService,
    connectedBrowsers: connectedBrowsersService,
    browserProfileService,
    focusedSessionWatchManager,
    deviceBridgeService,
  });
  app.get("/api/ws", wsRelayHandler);

  // Create relay connection handler for connections from relay server (Phase 7)
  const acceptRelayConnection = createAcceptRelayConnection({
    app,
    baseUrl,
    supervisor,
    eventBus,
    uploadManager: wsRelayUploadManager,
    remoteAccessService,
    remoteSessionService,
    connectedBrowsers: connectedBrowsersService,
    browserProfileService,
    focusedSessionWatchManager,
    deviceBridgeService,
  });

  // Function to start/restart relay client with current config
  async function updateRelayConnection() {
    const relayConfig = remoteAccessService.getRelayConfig();
    if (relayConfig?.url && relayConfig?.username) {
      const compatibility = await getServerCompatibilityInfo({
        getDeviceBridgeState: () => {
          if (!deviceBridgeService) return "unavailable";
          return deviceBridgeService.hasBinary() ? "available" : "downloadable";
        },
        isDeviceBridgeEnabled: () =>
          serverSettingsService.getSetting("deviceBridgeEnabled") ?? false,
      });
      relayClientService.start({
        relayUrl: relayConfig.url,
        username: relayConfig.username,
        installId: installService.getInstallId(),
        appVersion: compatibility.appVersion,
        resumeProtocolVersion: compatibility.resumeProtocolVersion,
        renderProtocolVersion: compatibility.renderProtocolVersion,
        capabilities: compatibility.capabilities,
        onRelayConnection: acceptRelayConnection,
        onStatusChange: (status) => {
          console.log(`[Relay] Status: ${status}`);
        },
      });
    } else {
      relayClientService.stop();
    }
  }

  // Wire up the callback for relay config changes from API routes
  relayConfigCallbackHolder.callback = updateRelayConnection;

  // Start relay connection on boot if configured
  await updateRelayConnection();

  // Serve stable (emergency) UI from /_stable/ path if available
  if (config.serveFrontend && fs.existsSync(config.stableDistPath)) {
    const stableRoutes = createStaticRoutes({
      distPath: config.stableDistPath,
      basePath: "/_stable",
    });
    app.route("/_stable", stableRoutes);
    console.log(
      `[Frontend] Stable UI available at /_stable/ from ${config.stableDistPath}`,
    );
  }

  // Add frontend proxy as the final catch-all (AFTER all API routes including uploads)
  if (frontendProxy) {
    const proxy = frontendProxy;
    app.all("*", (c) => {
      const { incoming, outgoing } = c.env;
      proxy.web(incoming, outgoing);
      return RESPONSE_ALREADY_SENT;
    });
  }

  // Production: serve static files (must be added after API routes)
  if (config.serveFrontend && isProduction) {
    const distExists = fs.existsSync(config.clientDistPath);
    if (distExists) {
      const staticRoutes = createStaticRoutes({
        distPath: config.clientDistPath,
      });
      app.route("/", staticRoutes);
      console.log(
        `[Frontend] Serving static files from ${config.clientDistPath}`,
      );
    } else {
      console.warn(
        `[Frontend] Warning: dist not found at ${config.clientDistPath}. Run 'pnpm build' first.`,
      );
    }
  }

  // Determine effective port (CLI override or saved setting or default)
  const effectivePort = networkBindingService.getLocalhostPort();

  // Track servers for multi-socket management
  let localhostServer: ReturnType<typeof serve>;
  let networkServer: ReturnType<typeof serve> | null = null;

  // Helper to create a server with WebSocket support
  function createServer(
    port: number,
    hostname: string,
    onReady?: (info: { port: number }) => void,
    options?: { fatalOnError?: boolean },
  ): ReturnType<typeof serve> {
    const { fatalOnError = false } = options ?? {};
    const server = tlsOptions
      ? serve(
          {
            fetch: app.fetch,
            port,
            hostname,
            createServer: createHttpsServer,
            serverOptions: tlsOptions,
          },
          onReady,
        )
      : serve({ fetch: app.fetch, port, hostname }, onReady);

    server.on("error", (error: unknown) => {
      const err = error as NodeJS.ErrnoException;
      const listenUrl = `${serverProtocol}://${hostname}:${port}`;
      console.error(
        `[Server] Failed to bind ${listenUrl}: ${err.message ?? "Unknown error"}`,
      );
      if (err.code === "EADDRINUSE") {
        console.error(
          `[Server] Port ${port} is already in use. Stop the existing process or run with a different PORT.`,
        );
      }
      if (fatalOnError) {
        process.exit(1);
      }
    });

    attachUnifiedUpgradeHandler(server, {
      frontendProxy,
      isApiPath: (urlPath) => urlPath.startsWith("/api"),
      app,
      wss,
    });
    return server;
  }

  // Callback for localhost port changes (test-first pattern)
  async function onLocalhostPortChange(
    newPort: number,
  ): Promise<{ success: boolean; error?: string; redirectUrl?: string }> {
    const currentPort = networkBindingService.getLocalhostPort();

    if (newPort === currentPort) {
      return { success: true };
    }

    try {
      const testServer = tlsOptions
        ? serve(
            {
              fetch: app.fetch,
              port: newPort,
              hostname: "127.0.0.1",
              createServer: createHttpsServer,
              serverOptions: tlsOptions,
            },
            () => {},
          )
        : serve(
            { fetch: app.fetch, port: newPort, hostname: "127.0.0.1" },
            () => {},
          );

      testServer.close();
      localhostServer.close();

      localhostServer = createServer(
        newPort,
        "127.0.0.1",
        (info) => {
          console.log(
            `[NetworkBinding] Localhost server restarted on port ${info.port}`,
          );
        },
        { fatalOnError: true },
      );

      return {
        success: true,
        redirectUrl: `${serverProtocol}://127.0.0.1:${newPort}`,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to bind port";
      console.error(
        `[NetworkBinding] Failed to bind port ${newPort}:`,
        message,
      );
      return { success: false, error: message };
    }
  }

  // Track whether we're currently bound to 0.0.0.0 (which covers localhost)
  let boundToAllInterfaces = false;

  // Callback for network socket changes
  async function onNetworkBindingChange(
    bindConfig: { host: string; port: number } | null,
  ): Promise<{ success: boolean; error?: string }> {
    const isBindingToAllInterfaces =
      bindConfig?.host === "0.0.0.0" || bindConfig?.host === "::";
    const localhostPort = networkBindingService.getLocalhostPort();
    const samePortAsLocalhost = bindConfig?.port === localhostPort;
    const needsLocalhostClose = isBindingToAllInterfaces && samePortAsLocalhost;

    try {
      if (networkServer) {
        networkServer.close();
        networkServer = null;
        console.log("[NetworkBinding] Network socket closed");
      }

      if (boundToAllInterfaces && !isBindingToAllInterfaces) {
        localhostServer = createServer(
          localhostPort,
          "127.0.0.1",
          (info) => {
            console.log(
              `[NetworkBinding] Localhost server rebound on port ${info.port}`,
            );
          },
          { fatalOnError: true },
        );
        boundToAllInterfaces = false;
      }

      if (bindConfig) {
        if (needsLocalhostClose) {
          localhostServer.close();
          console.log(
            "[NetworkBinding] Closed localhost server to bind to all interfaces",
          );
        }

        try {
          networkServer = createServer(
            bindConfig.port,
            bindConfig.host,
            (info) => {
              const networkUrl = `${serverProtocol}://${bindConfig.host}:${info.port}`;
              console.log(`Server URL: ${networkUrl}`);
              if (needsLocalhostClose) {
                serverInfoState.host = bindConfig.host;
                serverInfoState.port = info.port;
                networkBindingService.setRuntimeLocalhostPort(info.port);
              }
              console.log(
                `[NetworkBinding] Network socket listening on ${bindConfig.host}:${info.port}`,
              );
            },
          );
          if (needsLocalhostClose) {
            boundToAllInterfaces = true;
          }
        } catch (bindError) {
          if (needsLocalhostClose) {
            console.log(
              "[NetworkBinding] Recovering localhost server after failed bind",
            );
            localhostServer = createServer(
              localhostPort,
              "127.0.0.1",
              (info) => {
                console.log(
                  `[NetworkBinding] Localhost server recovered on port ${info.port}`,
                );
              },
              { fatalOnError: true },
            );
          }
          throw bindError;
        }
      }

      return { success: true };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to bind network socket";
      console.error("[NetworkBinding] Failed to bind network socket:", message);
      return { success: false, error: message };
    }
  }

  // Wire up the callbacks to the holder so routes can use them
  networkBindingCallbackHolder.onLocalhostPortChange = onLocalhostPortChange;
  networkBindingCallbackHolder.onNetworkBindingChange = onNetworkBindingChange;

  // Create the main localhost server
  const expectedServerUrl = `${serverProtocol}://127.0.0.1:${effectivePort}`;
  console.log(`[Server] Starting on ${expectedServerUrl}`);
  localhostServer = createServer(
    effectivePort,
    "127.0.0.1",
    (info) => {
      if (config.portFile) {
        fs.writeFileSync(config.portFile, String(info.port));
      }

      const serverUrl = `${serverProtocol}://127.0.0.1:${info.port}`;
      serverInfoState.host = "127.0.0.1";
      serverInfoState.port = info.port;
      networkBindingService.setRuntimeLocalhostPort(info.port);
      console.log(`Server URL: ${serverUrl}`);
      console.log(`Server running at ${serverUrl}`);
      console.log(`Projects dir: ${config.claudeProjectsDir}`);
      console.log(`Permission mode: ${config.defaultPermissionMode}`);

      if (config.openBrowser) {
        const platform = os.platform();
        let cmd: string;
        let args: string[];
        if (platform === "darwin") {
          cmd = "open";
          args = [serverUrl];
        } else if (platform === "win32") {
          cmd = "cmd";
          args = ["/c", "start", "", serverUrl];
        } else {
          let isWsl = false;
          try {
            isWsl = fs
              .readFileSync("/proc/version", "utf-8")
              .toLowerCase()
              .includes("microsoft");
          } catch {}
          if (isWsl) {
            cmd = "cmd.exe";
            args = ["/c", "start", "", serverUrl];
          } else {
            cmd = "xdg-open";
            args = [serverUrl];
          }
        }
        execFile(cmd, args, (err) => {
          if (err) {
            console.warn(`Could not open browser: ${err.message}`);
          }
        });
      }

      // Notify all connected clients that the backend has restarted
      eventBus.emit({
        type: "backend-reloaded",
        timestamp: new Date().toISOString(),
      });
    },
    { fatalOnError: true },
  );

  // Start network socket if enabled in saved settings (and not CLI-overridden)
  const networkConfig = networkBindingService.getNetworkConfig();
  if (
    networkConfig.enabled &&
    networkConfig.host &&
    !networkBindingService.isNetworkOverridden()
  ) {
    const networkPort = networkConfig.port ?? effectivePort;
    await onNetworkBindingChange({
      host: networkConfig.host,
      port: networkPort,
    });
  }

  // If CLI host override was specified (not localhost), also bind to that interface
  if (
    config.cliHostOverride &&
    config.host !== "127.0.0.1" &&
    config.host !== "localhost"
  ) {
    await onNetworkBindingChange({ host: config.host, port: effectivePort });
  }

  // Start maintenance server on separate port (for out-of-band diagnostics)
  if (config.maintenancePort !== 0) {
    const runStateStore = new RunStateStore({ dataDir: config.dataDir });
    startMaintenanceServer({
      port: config.maintenancePort < 0 ? 0 : config.maintenancePort,
      portFile: config.maintenancePortFile,
      host: "127.0.0.1",
      mainServerPort: effectivePort,
      hasActiveRuns: async () => {
        const states = await runStateStore.list();
        return states.some(
          (s) => s.state.state === "active" || s.state.state === "retry",
        );
      },
    });
  }

  return { onLocalhostPortChange, onNetworkBindingChange };
}
