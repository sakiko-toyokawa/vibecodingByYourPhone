import type { HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { Hono } from "hono";
import {
  container,
  createContainerInstance,
  registerValue,
} from "./container.js";
import { PlannerService } from "./loop/contract/planner.js";
import {
  ControlPlane,
  CronScheduler,
  EvalRunner,
  FailurePatternStore,
  LearningEventStore,
  LearningWorker,
  LoopRunService,
  ProposalPipeline,
  ProposalStore,
  RelationPoller,
  RunLedgerStore,
  RunStateStore,
  TriggerQueueStore,
  drainPendingTriggers,
  pruneStaleWorktrees,
} from "./loop/index.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import {
  corsMiddleware,
  hostCheckMiddleware,
  requireCustomHeader,
} from "./middleware/security.js";
import { CodexSessionScanner } from "./projects/codex-scanner.js";
import { GeminiSessionScanner } from "./projects/gemini-scanner.js";
import { ProjectScanner } from "./projects/scanner.js";
import { providerRegistry, registerAllProviders } from "./providers/index.js";
import { PushNotifier } from "./push/index.js";
import { health } from "./routes/health.js";
import { registerRoutes } from "./routes/index.js";
import type { CodexSessionReader } from "./sessions/codex-reader.js";
import type { GeminiSessionReader } from "./sessions/gemini-reader.js";
import { findSessionSummaryAcrossProviders } from "./sessions/provider-resolution.js";
import type { ISessionReader } from "./sessions/types.js";
import { ExternalSessionTracker } from "./supervisor/ExternalSessionTracker.js";
import { Supervisor } from "./supervisor/Supervisor.js";
import type { Project } from "./supervisor/types.js";
import { LifecycleWebhookService } from "./webhooks/LifecycleWebhookService.js";

export type { AppOptions, AppResult } from "./app-types.js";

export function createApp(
  options: import("./app-types.js").AppOptions,
): import("./app-types.js").AppResult {
  if (!container) {
    createContainerInstance();
  }

  const app = new Hono<{ Bindings: HttpBindings }>();

  // Security middleware: host validation, CORS, custom header requirement
  app.use("/api/*", hostCheckMiddleware);
  app.use("/api/*", corsMiddleware);
  app.use("/api/*", requireCustomHeader);

  // Auth middleware (if authService is provided)
  if (options.authService) {
    app.use(
      "/api/*",
      createAuthMiddleware({
        authService: options.authService,
        authDisabled: options.authDisabled,
        desktopAuthToken: options.desktopAuthToken,
      }),
    );
  }

  // Register provider descriptors
  registerAllProviders(options.modelInfoService);

  // Create dependencies
  const codexScanner = new CodexSessionScanner();
  const geminiScanner = new GeminiSessionScanner();
  const scanner = new ProjectScanner({
    projectsDir: options.projectsDir,
    codexScanner,
    geminiScanner,
    projectMetadataService: options.projectMetadataService,
    eventBus: options.eventBus,
    cacheTtlMs: options.projectScanCacheTtlMs,
  });
  const readerCache = new Map<string, ISessionReader>();
  const maxReaderCacheSize = 500;

  const getOrCreateReader = <T extends ISessionReader>(
    key: string,
    factory: () => T,
  ): T => {
    const cached = readerCache.get(key);
    if (cached) return cached as T;

    const reader = factory();
    readerCache.set(key, reader);

    while (readerCache.size > maxReaderCacheSize) {
      const oldestKey = readerCache.keys().next().value;
      if (!oldestKey) break;
      readerCache.delete(oldestKey);
    }

    return reader;
  };

  /**
   * Create a session reader appropriate for the project's provider.
   */
  const readerFactory = (project: Project): ISessionReader => {
    const descriptor = providerRegistry.get(project.provider);
    const mergedKey =
      project.mergedSessionDirs && project.mergedSessionDirs.length > 0
        ? `::merged=${project.mergedSessionDirs.join(",")}`
        : "";
    return getOrCreateReader(
      `${descriptor.group}::${project.sessionDir}${mergedKey}::${project.path}`,
      () => descriptor.createReader(project),
    );
  };

  const codexReaderFactory = (projectPath: string): CodexSessionReader => {
    const descriptor = providerRegistry.get("codex");
    const reader = descriptor.createExtraReader(projectPath);
    if (!reader) throw new Error("Codex extra reader not available");
    return getOrCreateReader(
      `codex-extra::${descriptor.getSessionDir()}::${projectPath}`,
      () => reader as CodexSessionReader,
    );
  };

  const geminiReaderFactory = (projectPath: string): GeminiSessionReader => {
    const descriptor = providerRegistry.get("gemini");
    const reader = descriptor.createExtraReader(projectPath);
    if (!reader) throw new Error("Gemini extra reader not available");
    return getOrCreateReader(
      `gemini-extra::${descriptor.getSessionDir()}::${projectPath}`,
      () => reader as GeminiSessionReader,
    );
  };

  const getSessionSummary = async (sessionId: string, projectId: string) => {
    const project = await scanner.getProject(projectId);
    if (!project) return null;
    const resolved = await findSessionSummaryAcrossProviders(
      project,
      sessionId,
      project.id,
      {
        readerFactory,
        codexReaderFactory,
        geminiReaderFactory,
      },
      options.sessionMetadataService?.getProvider(sessionId),
    );
    return resolved?.summary ?? null;
  };

  const supervisor = new Supervisor({
    sdk: options.sdk,
    realSdk: options.realSdk,
    idleTimeoutMs: options.idleTimeoutMs,
    defaultPermissionMode: options.defaultPermissionMode,
    eventBus: options.eventBus,
    maxWorkers: options.maxWorkers,
    idlePreemptThresholdMs: options.idlePreemptThresholdMs,
    maxQueueSize: options.maxQueueSize,
    onSessionExecutor: options.sessionMetadataService
      ? (sessionId, executor) =>
          options.sessionMetadataService?.setExecutor(sessionId, executor) ??
          Promise.resolve()
      : undefined,
    onSessionSummary: getSessionSummary,
  });

  // Create external session tracker if eventBus is available
  const externalTracker = options.eventBus
    ? new ExternalSessionTracker({
        eventBus: options.eventBus,
        supervisor,
        scanner,
        decayMs: 30000,
        getSessionSummary,
      })
    : undefined;

  // Create PushNotifier if push notifications are enabled
  if (options.eventBus && options.pushService) {
    new PushNotifier({
      eventBus: options.eventBus,
      pushService: options.pushService,
      supervisor,
      connectedBrowsers: options.connectedBrowsers,
    });
  }

  if (options.eventBus && options.serverSettingsService) {
    new LifecycleWebhookService({
      eventBus: options.eventBus,
      supervisor,
      serverSettingsService: options.serverSettingsService,
    });
  }

  // Health check needs CORS for Tauri desktop app
  app.use("/health/*", corsMiddleware);

  // Register app-level dependencies in DI container
  registerValue("scanner", scanner);
  registerValue("supervisor", supervisor);
  registerValue("readerFactory", readerFactory);
  registerValue("codexScanner", codexScanner);
  registerValue("geminiScanner", geminiScanner);
  registerValue("codexReaderFactory", codexReaderFactory);
  registerValue("geminiReaderFactory", geminiReaderFactory);
  if (externalTracker) {
    registerValue("externalTracker", externalTracker);
  }

  // Loop phase 0/1: run orchestration + in-process cron trigger + minimal
  // control-plane (needs_human bridging). Built here (not in services-init)
  // because they need the app-level Supervisor and event bus.
  {
    const { loopCardStore, maintenanceTargetStore } = container.cradle;
    const runLedgerStore = new RunLedgerStore({ dataDir: options.dataDir });
    const runStateStore = new RunStateStore({ dataDir: options.dataDir });
    const learningEventStore = new LearningEventStore({
      dataDir: options.dataDir,
    });
    const loopControlPlane = new ControlPlane({
      runStateStore,
      runLedgerStore,
      eventBus: options.eventBus,
      learningEventStore,
      loopTokenAlertRatio: options.loopTokenAlertRatio ?? 0.9,
      // .loop/STATE.md 人可读投影 (04-存储约定): 迁移时读 card 的
      // workspace.path / persistence.state_file
      loopCardStore,
      dataDir: options.dataDir,
    });
    // 阶段 3 学习侧: proposalStore 是 server 进程单例 (提案单写者) —
    // run-service 装配消费、learning worker、提案 API 都经同一个实例,
    // 不能另开实例直写文件.
    const failurePatternStore = new FailurePatternStore({
      dataDir: options.dataDir,
    });
    const proposalStore = new ProposalStore({ dataDir: options.dataDir });
    const planner = new PlannerService();
    const relationStore = container.cradle.relationStore;
    if (!relationStore) {
      throw new Error("RelationStore not initialized");
    }
    if (!maintenanceTargetStore) {
      throw new Error("MaintenanceTargetStore not initialized");
    }
    const loopRunService = new LoopRunService({
      supervisor,
      loopCardStore,
      runLedgerStore,
      runStateStore,
      controlPlane: loopControlPlane,
      // 阶段 3 装配消费: 新 run 装配读取 published / canary 提案
      proposalStore,
      // 02 §5 known_failure_patterns: 验证输入对照失败模式账本的 open
      // 模式（同一单例, 只读）
      failurePatternStore,
      githubCredentialStore: container.cradle.githubCredentialStore,
      githubToolProvisioner: container.cradle.githubToolProvisioner,
      dataDir: options.dataDir,
      relationStore,
      maintenanceTargetStore,
      planner,
      loopWatchdog: {
        turnIdleTimeoutMs: options.loopTurnIdleTimeoutMs ?? 10 * 60 * 1000,
        turnIdleCheckIntervalMs:
          options.loopTurnIdleCheckIntervalMs ?? 30 * 1000,
        stagnationSimilarTurnsThreshold:
          options.loopStagnationSimilarTurnsThreshold ?? 3,
        idleNoProgressTurnsThreshold:
          options.loopIdleNoProgressTurnsThreshold ?? 3,
        repeatedBlockerThreshold: options.loopRepeatedBlockerThreshold ?? 3,
      },
    });
    // Resume any runs that were active or retrying when the server last
    // stopped. Fire-and-forget: startup must not block on run recovery.
    void (async () => {
      const states = await runStateStore.list();
      for (const { loopId, state: record } of states) {
        if (record.state === "active" || record.state === "retry") {
          console.log(
            `[LoopRunService] Resuming ${record.state} run ${record.run_id} for loop '${loopId}' after startup`,
          );
          await loopRunService.resumeAfterRestart(loopId).catch((error) => {
            console.error(
              `[LoopRunService] failed to resume run ${record.run_id} for loop '${loopId}':`,
              error,
            );
          });
        }
      }
    })();
    const cronScheduler = new CronScheduler({
      loopCardStore,
      isRunActive: (loopId) => loopRunService.isRunActive(loopId),
      onTrigger: (loopId, dedupeKey) => {
        console.log(`[CronScheduler] firing loop '${loopId}' (${dedupeKey})`);
        loopRunService.startRun(loopId, "cron").catch((error) => {
          console.warn(
            `[CronScheduler] failed to start run for loop '${loopId}':`,
            error,
          );
        });
      },
      // 点火键持久化: 进程重启后同一分钟内不重复点火
      dataDir: options.dataDir,
    });
    cronScheduler.start();
    // 04 容量与清理: 开机清理超期 run worktree (worktree 隔离策略的
    // 执行目录, 默认 7 天); 活跃/阻塞 run (恢复依赖 worktree) 跳过;
    // 失败仅告警, 不阻塞启动。
    void (async () => {
      const protectedRunIds = new Set<string>();
      for (const { state: record } of await runStateStore.list()) {
        if (
          ["active", "retry", "paused", "needs_human"].includes(record.state)
        ) {
          protectedRunIds.add(record.run_id);
        }
      }
      await pruneStaleWorktrees({ dataDir: options.dataDir, protectedRunIds });
    })().catch((error) =>
      console.warn("[worktree] startup prune failed:", error),
    );
    // 阶段 3 学习侧: 异步 learning worker, 与主链路同进程但崩溃隔离
    // (tick 整体 try/catch + 健康记录, 见 learning/worker.ts). 只读
    // events.jsonl + runs/, 只写 failure-patterns.json / proposals/ /
    // cursor.json (04 单写者表).
    // 第三刀: 发布管线 —— worker 每轮 tick 自动推进 draft→shadow→canary
    // (regression 档复跑 eval 最小集, fail-closed); approved/published
    // 无自动路径, 只有 routes/proposals.ts 的人工端点.
    const evalRunner = new EvalRunner({ dataDir: options.dataDir });
    const proposalPipeline = new ProposalPipeline({
      proposalStore,
      evalRunner,
      // regression 档按提案 target 关联 loop 读 card 的 regression_scope
      loopCardStore,
    });
    const learningWorker = new LearningWorker({
      learningEventStore,
      failurePatternStore,
      proposalStore,
      runLedgerStore,
      pipeline: proposalPipeline,
      // 04 容量与清理: 顺带清理需要扫描活跃 run 状态
      runStateStore,
      // golden tasks: 失败模式 → eval 集 (基准与回归.md)
      loopCardStore,
      evalRunner,
      // 04 容量与清理: worktree 周期清理 (保护集与 cleanup_rule 在
      // worker 内装配)
      dataDir: options.dataDir,
    });
    learningWorker.start();
    registerValue("loopRunService", loopRunService);
    registerValue("loopControlPlane", loopControlPlane);
    registerValue("cronScheduler", cronScheduler);
    registerValue("learningWorker", learningWorker);
    registerValue("proposalStore", proposalStore);
    registerValue("proposalPipeline", proposalPipeline);
    const triggerQueueStore = new TriggerQueueStore({
      dataDir: options.dataDir,
    });
    const drainPending = (loopId?: string) =>
      drainPendingTriggers(
        {
          queueStore: triggerQueueStore,
          runService: loopRunService,
          controlPlane: loopControlPlane,
          maintenanceTargetStore,
        },
        loopId,
      );
    registerValue("triggerQueueStore", triggerQueueStore);
    registerValue("drainPendingTriggers", drainPending);
    const relationPoller = new RelationPoller({
      relationStore,
      githubClient: container.cradle.githubClient,
      triggerQueueStore,
      drainPendingTriggers: drainPending,
    });
    relationPoller.start(
      Number(process.env.RELATION_POLL_INTERVAL_MS) || 5 * 60 * 1000,
    );
    void relationPoller.pollOnce().catch((error) => {
      console.warn("[RelationPoller] startup poll failed:", error);
    });
    registerValue("relationPoller", relationPoller);
    const triggerDrainTimer = setInterval(() => {
      void drainPending().catch((error) =>
        console.warn("[LoopTrigger] queue drain failed:", error),
      );
    }, 30_000);
    triggerDrainTimer.unref?.();
  }

  // Register all API routes
  registerRoutes(app, options);

  // Frontend proxy fallback: proxy all non-API requests to Vite dev server
  if (options.frontendProxy) {
    const proxy = options.frontendProxy;
    app.all("*", (c) => {
      const { incoming, outgoing } = c.env;
      proxy.web(incoming, outgoing);
      return RESPONSE_ALREADY_SENT;
    });
  }

  return { app, supervisor, scanner, readerFactory };
}

// Default app for backwards compatibility (health check only)
export const app = new Hono();
app.route("/health", health);
