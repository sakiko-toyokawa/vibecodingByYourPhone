import type { HttpBindings } from "@hono/node-server";
import type { Hono } from "hono";
import type { AuthService } from "./auth/AuthService.js";
import type { DeviceBridgeService } from "./device/DeviceBridgeService.js";
import type { FrontendProxy } from "./frontend/index.js";
import type { SessionIndexService } from "./indexes/index.js";
import type {
  ProjectMetadataService,
  SessionMetadataService,
} from "./metadata/index.js";
import type { NotificationService } from "./notifications/index.js";
import type { ProjectScanner } from "./projects/scanner.js";
import type { PushService } from "./push/index.js";
import type { RecentsService } from "./recents/index.js";
import type {
  RemoteAccessService,
  RemoteSessionService,
} from "./remote-access/index.js";
import type { UploadDeps } from "./routes/upload.js";
import type {
  ClaudeSDK,
  PermissionMode,
  RealClaudeSDKInterface,
} from "./sdk/types.js";
import type { BrowserProfileService } from "./services/BrowserProfileService.js";
import type { ConnectedBrowsersService } from "./services/ConnectedBrowsersService.js";
import type { ModelInfoService } from "./services/ModelInfoService.js";
import type { NetworkBindingService } from "./services/NetworkBindingService.js";
import type { RelayClientService } from "./services/RelayClientService.js";
import type { ServerSettingsService } from "./services/ServerSettingsService.js";
import type { SharingService } from "./services/SharingService.js";
import type { ISessionReader } from "./sessions/types.js";
import type { Supervisor } from "./supervisor/Supervisor.js";
import type { Project } from "./supervisor/types.js";
import type { IEventBus } from "./watcher/IEventBus.js";
import type { EventBus } from "./watcher/index.js";

export interface AppOptions {
  /** Legacy SDK interface for mock SDK (for testing) */
  sdk?: ClaudeSDK;
  /** Real SDK interface with full features */
  realSdk?: RealClaudeSDKInterface;
  projectsDir?: string; // override for testing
  idleTimeoutMs?: number;
  defaultPermissionMode?: PermissionMode;
  /** EventBus for file change events */
  eventBus?: IEventBus;
  /** WebSocket upgrader from @hono/node-ws (optional) */
  upgradeWebSocket?: UploadDeps["upgradeWebSocket"];
  /** NotificationService for tracking session read state */
  notificationService?: NotificationService;
  /** SessionMetadataService for custom titles and archive status */
  sessionMetadataService?: SessionMetadataService;
  /** ProjectMetadataService for persisting added projects */
  projectMetadataService?: ProjectMetadataService;
  /** SessionIndexService for caching session summaries */
  sessionIndexService?: SessionIndexService;
  /** Project scanner cache TTL in ms (0 = rescan every request). */
  projectScanCacheTtlMs?: number;
  /** Maximum concurrent workers. 0 = unlimited (default) */
  maxWorkers?: number;
  /** Idle threshold in milliseconds for preemption */
  idlePreemptThresholdMs?: number;
  /** Frontend proxy for dev mode (proxies non-API requests to Vite) */
  frontendProxy?: FrontendProxy;
  /** PushService for web push notifications */
  pushService?: PushService;
  /** RecentsService for tracking recently visited sessions */
  recentsService?: RecentsService;
  /** Maximum upload file size in bytes. 0 = unlimited */
  maxUploadSizeBytes?: number;
  /** Maximum queue size for pending requests. 0 = unlimited */
  maxQueueSize?: number;
  /** AuthService for cookie-based auth (optional) */
  authService?: AuthService;
  /** Whether auth is disabled by env var (--auth-disable). Bypasses all auth. */
  authDisabled?: boolean;
  /** Desktop auth token for Tauri app. Requests with matching X-Desktop-Token header bypass auth. */
  desktopAuthToken?: string;
  /** RemoteAccessService for SRP-based remote access (optional) */
  remoteAccessService?: RemoteAccessService;
  /** RemoteSessionService for session persistence (optional) */
  remoteSessionService?: RemoteSessionService;
  /** RelayClientService for relay connection status (optional) */
  relayClientService?: RelayClientService;
  /**
   * Holder for relay config change callback.
   * The `callback` property can be set after createApp returns.
   */
  relayConfigCallbackHolder?: { callback?: () => Promise<void> };
  /** Fallback server host (for server-info endpoint) */
  serverHost?: string;
  /** Fallback server port (for server-info endpoint) */
  serverPort?: number;
  /** Dynamic server info provider used when the bound address can change at runtime. */
  getServerInfo?: () => { host: string; port: number };
  /** Unique installation identifier (for server-info endpoint) */
  installId?: string;
  /** Data directory for persistent state (for onboarding state) */
  dataDir?: string;
  /** NetworkBindingService for runtime binding configuration */
  networkBindingService?: NetworkBindingService;
  /**
   * Holder for network binding change callbacks.
   * The callbacks are set after startServer() initializes the servers.
   */
  networkBindingCallbackHolder?: {
    onLocalhostPortChange?: (
      port: number,
    ) => Promise<{ success: boolean; error?: string; redirectUrl?: string }>;
    onNetworkBindingChange?: (
      config: { host: string; port: number } | null,
    ) => Promise<{ success: boolean; error?: string }>;
  };
  /** ConnectedBrowsersService for tracking active browser connections */
  connectedBrowsers?: ConnectedBrowsersService;
  /** BrowserProfileService for tracking browser profile origins */
  browserProfileService?: BrowserProfileService;
  /** ServerSettingsService for server-wide settings */
  serverSettingsService?: ServerSettingsService;
  /** ModelInfoService for cached model metadata (context windows, etc.) */
  modelInfoService?: ModelInfoService;
  /** SharingService for session sharing */
  sharingService?: SharingService;
  /** DeviceBridgeService for Android emulator streaming */
  deviceBridgeService?: DeviceBridgeService;
  /** If non-empty, only these provider names are exposed via the API. */
  enabledProviders?: string[];
  /** Whether voice input is enabled. Default: true */
  voiceInputEnabled?: boolean;
  /** Allowed directory prefixes for serving local images. Default: ["/tmp"] */
  allowedImagePaths?: string[];
  /** Turn idle timeout in ms for loop runs. 0 disables idle detection. */
  loopTurnIdleTimeoutMs?: number;
  /** Interval between loop turn idle checks in ms. */
  loopTurnIdleCheckIntervalMs?: number;
  /** Number of consecutive similar turn outputs before loop stagnation escalation. */
  loopStagnationSimilarTurnsThreshold?: number;
  /** Number of consecutive retry turns with no workspace diff progress before escalating to needs_human. */
  loopIdleNoProgressTurnsThreshold?: number;
  /** Number of times the same blocker fingerprint may recur in needs_human decisions before forcing failed. */
  loopRepeatedBlockerThreshold?: number;
}

export interface AppResult {
  app: Hono<{ Bindings: HttpBindings }>;
  /** Supervisor instance for debug API access */
  supervisor: Supervisor;
  /** Project scanner for debug API access */
  scanner: ProjectScanner;
  /** Session reader factory for debug API access */
  readerFactory: (project: Project) => ISessionReader;
}
