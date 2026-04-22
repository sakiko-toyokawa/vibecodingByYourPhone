import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthService } from "./auth/AuthService.js";
import { initCodexCorrelationDebugLogger } from "./codex/correlationDebugLogger.js";
import { loadConfig } from "./config.js";
import { DeviceBridgeService } from "./device/DeviceBridgeService.js";
import { detectAdb } from "./device/adb.js";
import { SessionIndexService } from "./indexes/index.js";
import {
  getLogFilePath,
  initLogger,
  interceptConsole,
} from "./logging/index.js";
import {
  ProjectMetadataService,
  SessionMetadataService,
} from "./metadata/index.js";
import { updateAllowedHosts } from "./middleware/allowed-hosts.js";
import { NotificationService } from "./notifications/index.js";
import { providerRegistry, registerAllProviders } from "./providers/index.js";
import { PushService, getOrCreateVapidKeys } from "./push/index.js";
import { RecentsService } from "./recents/index.js";
import {
  RemoteAccessService,
  RemoteSessionService,
} from "./remote-access/index.js";
import { detectClaudeCli, detectCodexCli } from "./sdk/cli-detection.js";
import { initMessageLogger } from "./sdk/messageLogger.js";
import { ClaudeOllamaProvider } from "./sdk/providers/claude-ollama.js";
import { RealClaudeSDK } from "./sdk/real.js";
import {
  BrowserProfileService,
  ConnectedBrowsersService,
  InstallService,
  ModelInfoService,
  NetworkBindingService,
  RelayClientService,
  ServerSettingsService,
  SharingService,
} from "./services/index.js";
import { EventBus, FileWatcher, SourceWatcher } from "./watcher/index.js";

export interface ServicesContainer {
  config: ReturnType<typeof loadConfig>;
  eventBus: EventBus;
  fileWatchers: FileWatcher[];
  sourceWatcher?: SourceWatcher;
  realSdk: RealClaudeSDK;
  notificationService: NotificationService;
  sessionMetadataService: SessionMetadataService;
  projectMetadataService: ProjectMetadataService;
  sessionIndexService: SessionIndexService;
  pushService: PushService;
  browserProfileService: BrowserProfileService;
  recentsService: RecentsService;
  authService: AuthService;
  remoteAccessService: RemoteAccessService;
  remoteSessionService: RemoteSessionService;
  installService: InstallService;
  relayClientService: RelayClientService;
  networkBindingService: NetworkBindingService;
  connectedBrowsersService: ConnectedBrowsersService;
  serverSettingsService: ServerSettingsService;
  sharingService: SharingService;
  modelInfoService: ModelInfoService;
  deviceBridgeService?: DeviceBridgeService;
}

function parseCodexVersion(raw: string | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[0] : null;
}

function readExpectedCodexVersionFromPackageJson(): string | null {
  const candidatePaths = [
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../package.json",
    ),
    path.resolve(process.cwd(), "package.json"),
  ];

  for (const packageJsonPath of candidatePaths) {
    try {
      if (!fs.existsSync(packageJsonPath)) {
        continue;
      }

      const parsed = JSON.parse(
        fs.readFileSync(packageJsonPath, "utf-8"),
      ) as unknown;
      if (!parsed || typeof parsed !== "object") {
        continue;
      }

      const root = parsed as {
        yepAnywhere?: { codexCli?: { expectedVersion?: string } };
      };
      const expected = root.yepAnywhere?.codexCli?.expectedVersion;
      if (typeof expected === "string" && expected.trim().length > 0) {
        return expected.trim();
      }
    } catch {
      // Ignore malformed/unavailable package.json and try next candidate path.
    }
  }

  return null;
}

async function warnIfCodexVersionMismatch(): Promise<void> {
  const expectedRaw = readExpectedCodexVersionFromPackageJson();
  if (!expectedRaw) {
    return;
  }

  const expected = parseCodexVersion(expectedRaw) ?? expectedRaw;
  const codexInfo = await detectCodexCli();
  if (!codexInfo.found || !codexInfo.version) {
    return;
  }

  const actual = parseCodexVersion(codexInfo.version) ?? codexInfo.version;
  if (actual === expected) {
    return;
  }

  console.warn(
    `[Codex] Version mismatch: expected ${expected} (package.json yepAnywhere.codexCli.expectedVersion), detected ${actual}. Codex behavior may be unpredictable until versions align.`,
  );
}

export async function initializeServices(): Promise<ServicesContainer> {
  const config = loadConfig();

  // Initialize logging early to capture all output
  initLogger({
    logDir: config.logDir,
    logFile: config.logFile,
    consoleLevel: config.logLevel,
    fileLevel: config.logFileLevel,
    logToFile: config.logToFile,
    prettyPrint: config.logPretty,
  });
  interceptConsole();

  // Initialize SDK message logger (if LOG_SDK_MESSAGES=true)
  initMessageLogger();
  initCodexCorrelationDebugLogger();

  // Log configuration for discoverability
  console.log(`[Config] Data dir: ${config.dataDir}`);
  console.log(
    `[Config] Log file: ${getLogFilePath({ logDir: config.logDir, logFile: config.logFile })}`,
  );

  // Check for Claude CLI (optional - warn if not found)
  const cliInfo = detectClaudeCli();
  if (cliInfo.found) {
    console.log(`Claude CLI found: ${cliInfo.path} (${cliInfo.version})`);
  } else {
    console.warn("Warning: Claude CLI not found.");
    console.warn("Claude Code sessions will not be available.");
    console.warn(
      process.platform === "win32"
        ? "Install: irm https://claude.ai/install.ps1 | iex"
        : "Install: curl -fsSL https://claude.ai/install.sh | bash",
    );
  }

  await warnIfCodexVersionMismatch();

  // Create the real SDK
  const realSdk = new RealClaudeSDK();

  // Create EventBus and FileWatchers for all provider directories
  const eventBus = new EventBus();
  const fileWatchers: FileWatcher[] = [];

  // Register providers early so FileWatcher can use their descriptors
  const modelInfoService = new ModelInfoService();
  registerAllProviders(modelInfoService);

  for (const descriptor of providerRegistry.list()) {
    const watchDir = descriptor.getSessionDir();
    if (fs.existsSync(watchDir)) {
      const { periodicRescanMs } = descriptor.getWatchConfig();
      const watcher = new FileWatcher({
        watchDir,
        provider: descriptor.group,
        eventBus,
        debounceMs: 200,
        periodicRescanMs,
      });
      watcher.start();
      fileWatchers.push(watcher);
    } else {
      console.log(
        `[FileWatcher] Skipping ${descriptor.group} (${watchDir} not found)`,
      );
    }
  }

  // When running without tsx watch (NO_BACKEND_RELOAD=true), start source watcher
  let sourceWatcher: SourceWatcher | undefined;
  if (process.env.NO_BACKEND_RELOAD === "true") {
    sourceWatcher = new SourceWatcher({ eventBus });
    sourceWatcher.start();
  }

  // Create services (all use config.dataDir for state)
  const notificationService = new NotificationService({
    eventBus,
    dataDir: config.dataDir,
  });
  const sessionMetadataService = new SessionMetadataService({
    dataDir: config.dataDir,
  });
  const projectMetadataService = new ProjectMetadataService({
    dataDir: config.dataDir,
  });
  const sessionIndexService = new SessionIndexService({
    projectsDir: config.claudeProjectsDir,
    dataDir: path.join(config.dataDir, "indexes"),
    fullValidationIntervalMs: config.sessionIndexFullValidationMs,
    writeLockTimeoutMs: config.sessionIndexWriteLockTimeoutMs,
    writeLockStaleMs: config.sessionIndexWriteLockStaleMs,
    eventBus,
  });
  const pushService = new PushService({ dataDir: config.dataDir });
  const browserProfileService = new BrowserProfileService({
    dataDir: config.dataDir,
  });
  const recentsService = new RecentsService({ dataDir: config.dataDir });
  const authService = new AuthService({
    dataDir: config.dataDir,
    sessionTtlMs: config.authSessionTtlMs,
    cookieSecret: config.authCookieSecret,
  });
  const remoteAccessService = new RemoteAccessService({
    dataDir: config.dataDir,
  });
  const remoteSessionService = new RemoteSessionService({
    dataDir: config.dataDir,
  });
  const installService = new InstallService({
    dataDir: config.dataDir,
  });
  const relayClientService = new RelayClientService();
  const networkBindingService = new NetworkBindingService({
    dataDir: config.dataDir,
    cliPortOverride: config.cliPortOverride ? config.port : undefined,
    cliHostOverride: config.cliHostOverride ? config.host : undefined,
    defaultPort: 3400,
  });
  const connectedBrowsersService = new ConnectedBrowsersService(eventBus);
  const serverSettingsService = new ServerSettingsService({
    dataDir: config.dataDir,
  });
  const sharingService = new SharingService({
    dataDir: config.dataDir,
  });

  // Initialize services (loads state from disk)
  await installService.initialize();
  await notificationService.initialize();
  await sessionMetadataService.initialize();
  await projectMetadataService.initialize();
  await sessionIndexService.initialize();
  await pushService.initialize();
  await browserProfileService.initialize();
  await recentsService.initialize();
  await authService.initialize();
  await remoteAccessService.initialize();
  await serverSettingsService.initialize();
  await sharingService.initialize();
  await remoteSessionService.setDiskPersistenceEnabled(
    serverSettingsService.getSetting("persistRemoteSessionsToDisk"),
  );
  await remoteSessionService.initialize();
  await networkBindingService.initialize();

  // Seed allowed hosts middleware from persisted settings
  updateAllowedHosts(serverSettingsService.getSetting("allowedHosts"));

  // Seed Ollama settings from persisted settings
  const savedOllamaUrl = serverSettingsService.getSetting("ollamaUrl");
  if (savedOllamaUrl) {
    ClaudeOllamaProvider.setOllamaUrl(savedOllamaUrl);
  }
  ClaudeOllamaProvider.setSystemPrompt(
    serverSettingsService.getSetting("ollamaSystemPrompt"),
  );
  ClaudeOllamaProvider.setUseFullSystemPrompt(
    serverSettingsService.getSetting("ollamaUseFullSystemPrompt") ?? false,
  );

  // Warm model info cache (non-blocking, best-effort)
  modelInfoService.warmProvider("claude-ollama").catch(() => {});

  // Log auth status
  if (config.authDisabled) {
    console.log("[Auth] Cookie auth disabled by --auth-disable flag");
  } else if (authService.isEnabled()) {
    console.log("[Auth] Cookie auth enabled (configured in settings)");
  } else {
    console.log("[Auth] Cookie auth not enabled (enable in Settings)");
  }

  // Load or auto-create VAPID keys for push notifications
  const vapidKeys = await getOrCreateVapidKeys();
  pushService.setVapidKeys(vapidKeys);
  console.log("[Push] VAPID keys loaded, push notifications enabled");

  // Detect ADB and create emulator bridge service (lazy start)
  const adbPath = detectAdb();
  let deviceBridgeService: DeviceBridgeService | undefined;
  if (adbPath) {
    deviceBridgeService = new DeviceBridgeService({
      adbPath,
      dataDir: config.dataDir,
    });
    console.log(`[DeviceBridge] ADB detected at ${adbPath}`);
    if (deviceBridgeService.hasBinary()) {
      console.log(
        "[DeviceBridge] Sidecar binary found (will start on first use)",
      );
    } else {
      console.log(
        "[DeviceBridge] Sidecar binary not found (feature disabled until binary is available)",
      );
    }
  } else {
    console.log(
      "[DeviceBridge] ADB not found, device bridge streaming disabled",
    );
  }

  return {
    config,
    eventBus,
    fileWatchers,
    sourceWatcher,
    realSdk,
    notificationService,
    sessionMetadataService,
    projectMetadataService,
    sessionIndexService,
    pushService,
    browserProfileService,
    recentsService,
    authService,
    remoteAccessService,
    remoteSessionService,
    installService,
    relayClientService,
    networkBindingService,
    connectedBrowsersService,
    serverSettingsService,
    sharingService,
    modelInfoService,
    deviceBridgeService,
  };
}
