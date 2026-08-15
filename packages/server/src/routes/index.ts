import type { HttpBindings } from "@hono/node-server";
import type { Hono } from "hono";
import type { AppOptions } from "../app.js";
import { createAuthRoutes } from "../auth/routes.js";
import { container } from "../container.js";
import type {
  GitHubClient,
  GitHubCredentialStore,
  GitHubToolProvisioner,
} from "../github/index.js";
import type {
  ControlPlane,
  LoopCardStore,
  LoopRunService,
  MaintenanceTargetStore,
  ProposalStore,
  RelationLifecycleService,
  RelationStore,
  TriggerQueueStore,
} from "../loop/index.js";
import { updateAllowedHosts } from "../middleware/allowed-hosts.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import { CODEX_SESSIONS_DIR } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import { GEMINI_TMP_DIR } from "../projects/gemini-scanner.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { providerRegistry } from "../providers/registry.js";
import { createPushRoutes } from "../push/routes.js";
import { createRemoteAccessRoutes } from "../remote-access/index.js";
import { ClaudeOllamaProvider } from "../sdk/providers/claude-ollama.js";
import type { CodexSessionReader } from "../sessions/codex-reader.js";
import type { GeminiSessionReader } from "../sessions/gemini-reader.js";
import type { ISessionReader } from "../sessions/types.js";
import type { ExternalSessionTracker } from "../supervisor/ExternalSessionTracker.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { Project } from "../supervisor/types.js";
import { createActivityRoutes } from "./activity.js";
import { createBrowserProfilesRoutes } from "./browser-profiles.js";
import { createClientLogsRoutes } from "./client-logs.js";
import { createConnectionsRoutes } from "./connections.js";
import { createDebugStreamingRoutes } from "./debug-streaming.js";
import { createDevRoutes } from "./dev.js";
import { createDeviceRoutes } from "./devices.js";
import { createEditorRoutes } from "./editor.js";
import { createFilesRoutes } from "./files.js";
import { createGitStatusRoutes } from "./git-status.js";
import { createGitHubRoutes } from "./github.js";
import { createGlobalSessionsRoutes } from "./global-sessions.js";
import { health } from "./health.js";
import { createInboxRoutes } from "./inbox.js";
import { createLocalImageRoutes } from "./local-image.js";
import { createLoopsRoutes } from "./loops.js";
import { createMaintenanceRoutes } from "./maintenance.js";
import { createNetworkBindingRoutes } from "./network-binding.js";
import { createOnboardingRoutes } from "./onboarding.js";
import { createProcessesRoutes } from "./processes.js";
import { createProjectsRoutes } from "./projects.js";
import { createProposalsRoutes } from "./proposals.js";
import { createProvidersRoutes } from "./providers.js";
import { createRecentsRoutes } from "./recents.js";
import { createRunsRoutes } from "./runs.js";
import { createServerAdminRoutes } from "./server-admin.js";
import { createServerInfoRoutes } from "./server-info.js";
import { createSessionsRoutes } from "./sessions.js";
import { createSettingsRoutes } from "./settings.js";
import { createSharingRoutes } from "./sharing.js";
import { createUploadRoutes } from "./upload.js";
import { createVersionRoutes } from "./version.js";

export interface RouteDependencies {
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  supervisor: Supervisor;
  externalTracker: ExternalSessionTracker | undefined;
  codexScanner: CodexSessionScanner;
  geminiScanner: GeminiSessionScanner;
  codexReaderFactory: (projectPath: string) => CodexSessionReader;
  geminiReaderFactory: (projectPath: string) => GeminiSessionReader;
  loopCardStore: LoopCardStore;
  loopRunService?: LoopRunService;
  loopControlPlane?: ControlPlane;
  proposalStore?: ProposalStore;
  relationStore?: RelationStore;
  relationLifecycle?: RelationLifecycleService;
  maintenanceTargetStore?: MaintenanceTargetStore;
  githubCredentialStore: GitHubCredentialStore;
  githubToolProvisioner: GitHubToolProvisioner;
  githubClient: GitHubClient;
  triggerQueueStore?: TriggerQueueStore;
  drainPendingTriggers?: (loopId?: string) => Promise<void>;
}

export function registerRoutes(
  app: Hono<{ Bindings: HttpBindings }>,
  options: AppOptions,
): void {
  const {
    scanner,
    readerFactory,
    supervisor,
    externalTracker,
    codexScanner,
    geminiScanner,
    codexReaderFactory,
    geminiReaderFactory,
    loopCardStore,
    loopRunService,
    loopControlPlane,
    proposalStore,
    relationStore,
    relationLifecycle,
    maintenanceTargetStore,
    githubCredentialStore,
    githubToolProvisioner,
    githubClient,
    triggerQueueStore,
    drainPendingTriggers,
  } = container.cradle as unknown as RouteDependencies;

  // Auth routes (always mounted if authService is provided)
  if (options.authService) {
    app.route(
      "/api/auth",
      createAuthRoutes({
        authService: options.authService,
        authDisabled: options.authDisabled,
        desktopAuthToken: options.desktopAuthToken,
      }),
    );
  }

  // Remote access routes (SRP authentication for relay)
  if (options.remoteAccessService) {
    const callbackHolder = options.relayConfigCallbackHolder;
    app.route(
      "/api/remote-access",
      createRemoteAccessRoutes({
        remoteAccessService: options.remoteAccessService,
        remoteSessionService: options.remoteSessionService,
        relayClientService: options.relayClientService,
        onRelayConfigChanged: callbackHolder
          ? () => callbackHolder.callback?.() ?? Promise.resolve()
          : undefined,
      }),
    );
  }

  // Health check (outside /api — needs CORS for Tauri desktop app)
  app.route("/health", health);

  // Version check (outside /api for easy access)
  app.route(
    "/api/version",
    createVersionRoutes({
      getDeviceBridgeState: () => {
        if (!options.deviceBridgeService) return "unavailable";
        return options.deviceBridgeService.hasBinary()
          ? "available"
          : "downloadable";
      },
      getDeviceBridgeStatus: ({ forceRefresh } = {}) => {
        if (!options.deviceBridgeService) {
          return Promise.resolve({ state: "unavailable" as const });
        }
        return options.deviceBridgeService.getBridgeStatus({ forceRefresh });
      },
      isDeviceBridgeEnabled: () =>
        options.serverSettingsService?.getSetting("deviceBridgeEnabled") ??
        false,
      installId: options.installId,
      voiceInputEnabled: options.voiceInputEnabled,
    }),
  );

  // Server info (host/port binding info for Local Access settings)
  if (
    options.getServerInfo ||
    (options.serverHost !== undefined && options.serverPort !== undefined)
  ) {
    app.route(
      "/api/server-info",
      createServerInfoRoutes({
        host: options.serverHost,
        port: options.serverPort,
        getServerInfo: options.getServerInfo,
        installId: options.installId,
        deviceBridgeAvailable: !!options.deviceBridgeService?.hasBinary(),
      }),
    );
  }

  // Server admin routes (restart, always available for remote relay)
  app.route(
    "/api/server",
    createServerAdminRoutes({
      supervisor,
      notificationService: options.notificationService,
      activeLoopRuns: async () => {
        if (!loopRunService || !loopControlPlane) {
          return [];
        }
        const active: Array<{
          loop_id: string;
          run_id: string;
          state: string;
        }> = [];
        for (const stored of loopCardStore.listLoops()) {
          const runs = await loopRunService.listRuns(stored.id);
          const latest = runs[0];
          if (
            latest &&
            (latest.state === "active" || latest.state === "retry")
          ) {
            active.push({
              loop_id: stored.id,
              run_id: latest.run_id,
              state: latest.state,
            });
          }
        }
        return active;
      },
    }),
  );

  // Network binding routes (runtime port/interface configuration)
  if (
    options.networkBindingService &&
    options.networkBindingCallbackHolder &&
    options.eventBus
  ) {
    app.route(
      "/api/network-binding",
      createNetworkBindingRoutes({
        networkBindingService: options.networkBindingService,
        eventBus: options.eventBus,
        onLocalhostPortChange: async (port) => {
          const callback =
            options.networkBindingCallbackHolder?.onLocalhostPortChange;
          if (!callback) {
            return { success: false, error: "Callback not configured" };
          }
          return callback(port);
        },
        onNetworkBindingChange: async (config) => {
          const callback =
            options.networkBindingCallbackHolder?.onNetworkBindingChange;
          if (!callback) {
            return { success: false, error: "Callback not configured" };
          }
          return callback(config);
        },
      }),
    );
  }

  // Onboarding routes (first-run wizard state)
  if (options.dataDir) {
    app.route(
      "/api/onboarding",
      createOnboardingRoutes({ dataDir: options.dataDir }),
    );
  }

  // Client logs routes (remote log collection for connection diagnostics)
  if (options.dataDir) {
    app.route(
      "/api/client-logs",
      createClientLogsRoutes({ dataDir: options.dataDir }),
    );
  }

  // Mount API routes
  app.route(
    "/api/projects",
    createProjectsRoutes({
      scanner,
      readerFactory,
      supervisor,
      externalTracker,
      notificationService: options.notificationService,
      sessionMetadataService: options.sessionMetadataService,
      projectMetadataService: options.projectMetadataService,
      sessionIndexService: options.sessionIndexService,
      codexScanner,
      codexSessionsDir: CODEX_SESSIONS_DIR,
      codexReaderFactory,
      geminiScanner,
      geminiSessionsDir: GEMINI_TMP_DIR,
      geminiReaderFactory,
    }),
  );
  app.route(
    "/api",
    createSessionsRoutes({
      supervisor,
      scanner,
      readerFactory,
      externalTracker,
      notificationService: options.notificationService,
      sessionMetadataService: options.sessionMetadataService,
      eventBus: options.eventBus,
      codexScanner,
      codexSessionsDir: CODEX_SESSIONS_DIR,
      codexReaderFactory,
      geminiScanner,
      geminiSessionsDir: GEMINI_TMP_DIR,
      geminiReaderFactory,
      serverSettingsService: options.serverSettingsService,
      modelInfoService: options.modelInfoService,
    }),
  );
  app.route(
    "/api/processes",
    createProcessesRoutes({
      supervisor,
      scanner,
      readerFactory,
      processSessionSourceFactory: (process, project) => {
        const persistedProvider = options.sessionMetadataService?.getProvider(
          process.sessionId,
        );
        const provider = persistedProvider ?? process.provider;
        const descriptor =
          providerRegistry.getOrNull(provider) ??
          providerRegistry.get(process.provider);
        const extraReader = descriptor.createExtraReader(project.path);
        if (extraReader) {
          return {
            reader: extraReader,
            sessionDir: descriptor.getSessionDir(),
          };
        }
        return {
          reader: readerFactory(project),
          sessionDir: project.sessionDir,
        };
      },
      sessionIndexService: options.sessionIndexService,
    }),
  );

  // Inbox routes (cross-project session aggregation)
  app.route(
    "/api/inbox",
    createInboxRoutes({
      scanner,
      readerFactory,
      supervisor,
      notificationService: options.notificationService,
      sessionIndexService: options.sessionIndexService,
      sessionMetadataService: options.sessionMetadataService,
      codexScanner,
      codexSessionsDir: CODEX_SESSIONS_DIR,
      codexReaderFactory,
      geminiScanner,
      geminiSessionsDir: GEMINI_TMP_DIR,
      geminiReaderFactory,
    }),
  );

  // Global sessions route (flat list of all sessions for navigation)
  app.route(
    "/api/sessions",
    createGlobalSessionsRoutes({
      scanner,
      readerFactory,
      supervisor,
      externalTracker,
      notificationService: options.notificationService,
      sessionIndexService: options.sessionIndexService,
      sessionMetadataService: options.sessionMetadataService,
      codexScanner,
      codexSessionsDir: CODEX_SESSIONS_DIR,
      codexReaderFactory,
      geminiScanner,
      geminiSessionsDir: GEMINI_TMP_DIR,
      geminiReaderFactory,
      eventBus: options.eventBus,
    }),
  );

  // Files routes (file browser)
  app.route("/api/projects", createFilesRoutes({ scanner }));

  // Loop registry routes + phase-0 run triggers/list + phase-2 pause/resume/archive
  app.route(
    "/api/loops",
    createLoopsRoutes({
      loopCardStore,
      maintenanceTargetStore,
      runService: loopRunService,
      controlPlane: loopControlPlane,
      proposalStore,
      triggerQueueStore,
      drainPendingTriggers,
    }),
  );
  if (loopRunService) {
    app.route(
      "/api/runs",
      createRunsRoutes({
        runService: loopRunService,
        controlPlane: loopControlPlane,
      }),
    );
  }
  // 阶段 3 提案 API (approve / publish 人工闸门 + rollback; publish 仅人工)
  if (proposalStore) {
    app.route(
      "/api/proposals",
      createProposalsRoutes({
        proposalStore,
        eventBus: options.eventBus,
      }),
    );
  }

  // Editor routes (project tree, write, AI edit)
  app.route(
    "/api/projects",
    createEditorRoutes({
      scanner,
      eventBus: options.eventBus,
      serverSettingsService: options.serverSettingsService,
    }),
  );

  // Git status routes
  app.route("/api/projects", createGitStatusRoutes({ scanner }));

  app.route(
    "/api/github",
    createGitHubRoutes({
      credentialStore: githubCredentialStore,
      toolProvisioner: githubToolProvisioner,
      githubClient,
      dataDir: options.dataDir,
      relationStore,
      relationLifecycle,
      triggerQueueStore,
      drainPendingTriggers,
    }),
  );

  if (maintenanceTargetStore) {
    app.route(
      "/api/maintenance",
      createMaintenanceRoutes({
        targetStore: maintenanceTargetStore,
        triggerQueueStore,
        drainPendingTriggers,
      }),
    );
  }

  // Recents routes (recently visited sessions)
  if (options.recentsService) {
    app.route(
      "/api/recents",
      createRecentsRoutes({
        recentsService: options.recentsService,
        scanner,
        readerFactory,
        sessionIndexService: options.sessionIndexService,
        codexScanner,
        codexSessionsDir: CODEX_SESSIONS_DIR,
        codexReaderFactory,
        geminiScanner,
        geminiSessionsDir: GEMINI_TMP_DIR,
        geminiReaderFactory,
      }),
    );
  }

  // Provider routes (multi-provider detection)
  app.route(
    "/api/providers",
    createProvidersRoutes({
      modelInfoService: options.modelInfoService,
      enabledProviders: options.enabledProviders,
    }),
  );

  // Server settings routes
  if (options.serverSettingsService) {
    app.route(
      "/api/settings",
      createSettingsRoutes({
        serverSettingsService: options.serverSettingsService,
        onAllowedHostsChanged: updateAllowedHosts,
        onRemoteSessionPersistenceChanged: options.remoteSessionService
          ? (enabled) =>
              options.remoteSessionService?.setDiskPersistenceEnabled(enabled)
          : undefined,
        onOllamaUrlChanged: (url) => {
          ClaudeOllamaProvider.setOllamaUrl(url);
        },
        onOllamaSystemPromptChanged: (prompt) => {
          ClaudeOllamaProvider.setSystemPrompt(prompt);
        },
        onOllamaUseFullSystemPromptChanged: (enabled) => {
          ClaudeOllamaProvider.setUseFullSystemPrompt(enabled);
        },
      }),
    );
  }

  // Sharing routes (session snapshot sharing via Worker)
  if (options.sharingService) {
    app.route(
      "/api/sharing",
      createSharingRoutes({ sharingService: options.sharingService }),
    );
  }

  // Connections routes (list connected browser profiles)
  if (options.connectedBrowsers) {
    app.route(
      "/api/connections",
      createConnectionsRoutes({
        connectedBrowsers: options.connectedBrowsers,
        pushService: options.pushService,
      }),
    );
  }

  // Browser profiles routes (list browser profiles with origins)
  if (options.browserProfileService) {
    app.route(
      "/api/browser-profiles",
      createBrowserProfilesRoutes({
        browserProfileService: options.browserProfileService,
        pushService: options.pushService,
      }),
    );
  }

  // Emulator streaming routes (Android emulator remote control)
  if (options.deviceBridgeService) {
    app.route(
      "/api/devices",
      createDeviceRoutes({
        deviceBridgeService: options.deviceBridgeService,
        serverSettingsService: options.serverSettingsService,
      }),
    );
  }

  // Upload routes (WebSocket file uploads)
  if (options.upgradeWebSocket) {
    app.route(
      "/api",
      createUploadRoutes({
        scanner,
        upgradeWebSocket: options.upgradeWebSocket,
        maxUploadSizeBytes: options.maxUploadSizeBytes,
      }),
    );
  }

  // Local image serving (opt-in, restricted to allowed paths)
  if (options.allowedImagePaths && options.allowedImagePaths.length > 0) {
    app.route(
      "/api/local-image",
      createLocalImageRoutes({
        allowedPaths: options.allowedImagePaths,
      }),
    );
  }

  // Push notification routes
  if (options.pushService) {
    app.route(
      "/api/push",
      createPushRoutes({ pushService: options.pushService }),
    );
  }

  // Activity routes (file watching)
  if (options.eventBus) {
    app.route(
      "/api/activity",
      createActivityRoutes({
        eventBus: options.eventBus,
        connectedBrowsers: options.connectedBrowsers,
        browserProfileService: options.browserProfileService,
      }),
    );

    // Dev routes (manual reload workflow) - mounted when manual reload is enabled
    const isDevMode =
      process.env.NO_BACKEND_RELOAD === "true" ||
      process.env.NO_FRONTEND_RELOAD === "true";
    if (isDevMode) {
      console.log("[Dev] Mounting dev routes at /api/dev");
      app.route("/api/dev", createDevRoutes({ eventBus: options.eventBus }));
    }
  }

  // Debug streaming routes (always mounted in dev, useful for debugging markdown rendering)
  if (process.env.NODE_ENV !== "production") {
    app.route("/api/debug", createDebugStreamingRoutes());
  }
}
