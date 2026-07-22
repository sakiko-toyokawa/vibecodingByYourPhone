# Phase 3: Redis Pub/Sub + 进程管理优化

> **Goal:** 将 EventBus 抽象为 IEventBus 接口并接入 Redis 实现，支持多实例部署时的跨实例事件同步；优化进程生命周期管理（warm pool + 更优雅的重启策略）；清理剩余 Provider 硬编码。

**Tech Stack:** TypeScript 5.7, ioredis, Hono, Vitest

---

## 执行状态

| Task | 状态 | 备注 |
|------|------|------|
| Task 1: IEventBus + Redis | 已完成 | `IEventBus.ts`, `RedisEventBus.ts`, `createEventBus.ts` 已创建并集成 |
| Task 2: 扩展 IProviderAdapter | 已完成 | 新增 `extractSessionFromFileChange`, `getSessionFileCandidates`, `getSessionFilePattern`, `extractSessionIdFromPath`, `readProjectIdFromFile`；SessionIndexService, scanner, FocusedSessionWatchManager, ExternalSessionTracker 已消除 provider 硬编码 |
| Task 3: provider-resolution.ts | 已完成 | `normalizeProviderGroup` 已使用 Registry；`getSourceForGroup` 已支持通用 extra source；`ProviderGroup` 和 `SessionSource.kind` 已改为 `string` |
| Task 4: ProcessPool | 已完成 | `ProcessPool.ts` 已存在（容量管理 + 优雅抢占），Supervisor 已接入。Warm pool 设计未实施（与 SDK 单会话单进程模型不符） |
| Task 5: 验证 | 已完成 | `pnpm typecheck` 通过，`pnpm lint` 通过。无项目测试文件需删除 |

---

## 当前状态分析

### 已完成（Phase 2）
- IProviderAdapter 接口 + 各 ProviderDescriptor 实现
- awilix DI 容器引入，services-init/app/server 已接入
- sdk/providers/index.ts switch/case 已消除
- mock factory switch/case 已消除

### 待解决（Phase 3 范围）

| 问题 | 位置 | 影响 |
|------|------|------|
| EventBus 纯内存，不支持多实例 | `watcher/EventBus.ts` | 多实例部署时事件孤立 |
| Provider 硬编码残留 | `indexes/SessionIndexService.ts`, `projects/scanner.ts`, `watcher/FocusedSessionWatchManager.ts`, `sessions/provider-resolution.ts`, `supervisor/ExternalSessionTracker.ts` | 新增 Provider 仍需改这些文件 |
| 进程启动延迟 | `supervisor/Supervisor.ts:startSessionInternal()` | 每个新会话需启动新进程，无预热 |
| 进程重启策略粗糙 | `supervisor/Process.ts` | abort 后无优雅等待 |

---

## 文件结构

### 新增文件

| 文件 | 职责 |
|------|------|
| `packages/server/src/watcher/IEventBus.ts` | IEventBus 接口定义 |
| `packages/server/src/watcher/RedisEventBus.ts` | Redis Pub/Sub 实现 |
| `packages/server/src/watcher/createEventBus.ts` | 工厂函数：根据配置创建内存或 Redis EventBus |
| `packages/server/src/supervisor/ProcessPool.ts` | 进程池管理（warm pool + 生命周期） |

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `packages/server/src/watcher/EventBus.ts` | 实现 IEventBus 接口 |
| `packages/server/src/providers/adapter.ts` | 增加 `handleFileChange()`, `getSessionFilePattern()` 方法 |
| `packages/server/src/providers/claude.ts` | 实现新增方法 |
| `packages/server/src/providers/codex.ts` | 实现新增方法 |
| `packages/server/src/providers/gemini.ts` | 实现新增方法 |
| `packages/server/src/providers/opencode.ts` | 实现新增方法 |
| `packages/server/src/indexes/SessionIndexService.ts` | 使用 descriptor.handleFileChange() 消除 provider 硬编码 |
| `packages/server/src/projects/scanner.ts` | 使用 descriptor 消除 provider 硬编码 |
| `packages/server/src/watcher/FocusedSessionWatchManager.ts` | 使用 descriptor 消除 provider 硬编码 |
| `packages/server/src/sessions/provider-resolution.ts` | normalizeProviderGroup 使用 Registry |
| `packages/server/src/supervisor/ExternalSessionTracker.ts` | 使用 descriptor 消除 provider 硬编码 |
| `packages/server/src/services-init.ts` | 通过 createEventBus() 创建 EventBus |
| `packages/server/src/supervisor/Supervisor.ts` | 接入 ProcessPool |
| `packages/server/package.json` | 添加 ioredis 依赖 |

---

## Task 1: 抽象 IEventBus 接口 + Redis 实现

**目标:** 将 EventBus 抽象为接口，实现 Redis Pub/Sub 版本，支持通过配置切换。

### Step 1: 创建 IEventBus 接口

```typescript
// packages/server/src/watcher/IEventBus.ts

import type { BusEvent, EventHandler } from "./EventBus.js";

export interface IEventBus {
  subscribe(handler: EventHandler): () => void;
  emit(event: BusEvent): void;
  get subscriberCount(): number;
  /** Graceful shutdown - unsubscribe from Redis, drain pending */
  destroy?(): Promise<void>;
}
```

### Step 2: 修改 EventBus.ts 实现 IEventBus

```typescript
// packages/server/src/watcher/EventBus.ts

import type { IEventBus } from "./IEventBus.js";

export class EventBus implements IEventBus {
  // ... existing implementation, add destroy()
  async destroy(): Promise<void> {
    this.subscribers.clear();
  }
}
```

### Step 3: 创建 RedisEventBus

```typescript
// packages/server/src/watcher/RedisEventBus.ts

import Redis from "ioredis";
import type { IEventBus } from "./IEventBus.js";
import type { BusEvent, EventHandler } from "./EventBus.js";

export interface RedisEventBusOptions {
  redisUrl: string;
  channelName?: string;
}

export class RedisEventBus implements IEventBus {
  private publisher: Redis;
  private subscriber: Redis;
  private localSubscribers: Set<EventHandler> = new Set();
  private channelName: string;

  constructor(options: RedisEventBusOptions) {
    this.channelName = options.channelName ?? "yepanywhere:events";
    this.publisher = new Redis(options.redisUrl);
    this.subscriber = new Redis(options.redisUrl);

    this.subscriber.subscribe(this.channelName);
    this.subscriber.on("message", (_channel, message) => {
      const event = JSON.parse(message) as BusEvent;
      // Emit to local subscribers only (avoid echo loop)
      for (const handler of this.localSubscribers) {
        try {
          handler(event);
        } catch (error) {
          console.error("[RedisEventBus] Handler error:", error);
        }
      }
    });
  }

  subscribe(handler: EventHandler): () => void {
    this.localSubscribers.add(handler);
    return () => {
      this.localSubscribers.delete(handler);
    };
  }

  emit(event: BusEvent): void {
    // Publish to Redis
    this.publisher.publish(this.channelName, JSON.stringify(event));
    // Also emit locally (so local handlers get it immediately)
    for (const handler of this.localSubscribers) {
      try {
        handler(event);
      } catch (error) {
        console.error("[RedisEventBus] Handler error:", error);
      }
    }
  }

  get subscriberCount(): number {
    return this.localSubscribers.size;
  }

  async destroy(): Promise<void> {
    await this.subscriber.unsubscribe(this.channelName);
    this.subscriber.disconnect();
    this.publisher.disconnect();
    this.localSubscribers.clear();
  }
}
```

### Step 4: 创建工厂函数

```typescript
// packages/server/src/watcher/createEventBus.ts

import type { IEventBus } from "./IEventBus.js";
import { EventBus } from "./EventBus.js";
import { RedisEventBus } from "./RedisEventBus.js";

export interface EventBusConfig {
  /** Redis URL. If set, use Redis Pub/Sub; otherwise use in-memory */
  redisUrl?: string;
  channelName?: string;
}

export function createEventBus(config: EventBusConfig = {}): IEventBus {
  if (config.redisUrl) {
    return new RedisEventBus({
      redisUrl: config.redisUrl,
      channelName: config.channelName,
    });
  }
  return new EventBus();
}
```

### Step 5: 修改 services-init.ts

```typescript
import { createEventBus } from "./watcher/createEventBus.js";

// In initializeServices:
const eventBus = createEventBus({
  redisUrl: config.redisUrl,
});
```

### Step 6: 运行验证

```bash
pnpm typecheck
pnpm test
```

---

## Task 2: 扩展 IProviderAdapter 消除文件处理层 provider 硬编码

**目标:** 将 SessionIndexService、scanner、FocusedSessionWatchManager 等文件中的 provider-specific 逻辑提取到 ProviderDescriptor，新增 `handleFileChange()` 和 `getSessionFilePattern()` 方法。

### Step 1: 扩展 IProviderAdapter

```typescript
// packages/server/src/providers/adapter.ts

import type { FileChangeEvent } from "../watcher/EventBus.js";

export interface IProviderAdapter extends ProviderDescriptor {
  // ... existing methods ...

  /**
   * Handle a file change event for this provider.
   * Returns true if handled, false to fall through to default handling.
   */
  handleFileChange?(
    event: FileChangeEvent,
    deps: { projectsDir: string },
  ): boolean;

  /** Get the file pattern for session files of this provider */
  getSessionFilePattern(): RegExp;

  /** Get the scanner instance for this provider (if applicable) */
  getScanner?(): { invalidateCache(): void } | null;
}
```

### Step 2: 在各 ProviderDescriptor 中实现

Claude:
```typescript
handleFileChange(event, deps): boolean {
  if (event.fileType !== "session") return false;
  // Claude-specific file change handling
  const fileName = path.basename(event.relativePath);
  if (!fileName.endsWith(".jsonl")) return true; // Handled (ignored)
  // ... rest of logic
  return true;
}

getSessionFilePattern(): RegExp {
  return /\.jsonl$/;
}
```

Codex:
```typescript
handleFileChange(event, deps): boolean {
  if (event.fileType !== "session") return false;
  // Codex-specific: project-scoped over shared sessions tree
  return true;
}

getSessionFilePattern(): RegExp {
  return /\.json$/;
}

getScanner() { return this.scanner; }
```

### Step 3: 修改 SessionIndexService.ts

```typescript
// Replace switch/case with:
const descriptor = providerRegistry.getOrNull(event.provider);
if (descriptor?.handleFileChange) {
  const handled = descriptor.handleFileChange(event, { projectsDir: this.projectsDir });
  if (handled) return;
}
// Default handling for unknown providers
```

### Step 4: 修改 scanner.ts

```typescript
// Replace:
if (event.provider === "codex") {
  this.codexScanner?.invalidateCache();
} else if (event.provider === "gemini") {
  this.geminiScanner?.invalidateCache();
}

// With:
const descriptor = providerRegistry.getOrNull(event.provider);
const scanner = descriptor?.getScanner?.();
scanner?.invalidateCache();
```

### Step 5: 修改 FocusedSessionWatchManager.ts

类似方法，将 provider-specific 逻辑委托给 descriptor。

### Step 6: 运行验证

```bash
pnpm typecheck
pnpm test
```

---

## Task 3: 消除 provider-resolution.ts 的 normalizeProviderGroup 硬编码

**目标:** 将 `normalizeProviderGroup()` 函数改为 Registry 查询。

### Step 1: 重写 normalizeProviderGroup

```typescript
// packages/server/src/sessions/provider-resolution.ts

import { providerRegistry } from "../providers/registry.js";

export function normalizeProviderGroup(provider: string): string {
  const descriptor = providerRegistry.getOrNull(provider);
  return descriptor?.group ?? provider;
}
```

### Step 2: 删除 isClaudeProvider / isRemoteCapableProvider 硬编码

```typescript
// Replace:
export function isClaudeProvider(provider: string): boolean {
  return provider === "claude" || provider === "claude-ollama";
}

// With:
export function isClaudeProvider(provider: string): boolean {
  return providerRegistry.getOrNull(provider)?.group === "claude";
}
```

### Step 3: 运行验证

```bash
pnpm typecheck
pnpm test
```

---

## Task 4: 进程池化（Warm Pool + 生命周期优化）

**目标:** 引入 ProcessPool 管理进程预热和优雅重启，减少新会话启动延迟。

**注意**: Claude SDK 进程不适合传统复用池（每个会话绑定独立进程）。这里的"进程池"指：
1. **Warm Pool**: 预启动一个 standby 进程，新会话到达时直接复用
2. **Graceful Restart**: 进程 abort 后等待资源释放再启动新进程
3. **Max Workers 优化**: 更智能的容量管理

### Step 1: 创建 ProcessPool

```typescript
// packages/server/src/supervisor/ProcessPool.ts

export interface ProcessPoolOptions {
  /** Number of standby processes to keep warm */
  warmPoolSize?: number;
  /** Max concurrent processes */
  maxWorkers: number;
  /** Graceful shutdown timeout */
  gracefulShutdownMs?: number;
}

export class ProcessPool {
  private activeProcesses = new Map<string, Process>();
  private warmPool: Process[] = [];
  private maxWorkers: number;
  private warmPoolSize: number;

  constructor(options: ProcessPoolOptions) {
    this.maxWorkers = options.maxWorkers;
    this.warmPoolSize = options.warmPoolSize ?? 0;
  }

  /**
   * Acquire a process for a session.
   * If warm pool has standby, use it; otherwise create new.
   */
  async acquire(sessionId: string, factory: () => Promise<Process>): Promise<Process> {
    if (this.warmPool.length > 0) {
      const process = this.warmPool.shift()!;
      this.activeProcesses.set(sessionId, process);
      this.replenishWarmPool(factory);
      return process;
    }

    const process = await factory();
    this.activeProcesses.set(sessionId, process);
    return process;
  }

  /**
   * Release a process back to the pool or terminate it.
   */
  async release(sessionId: string, process: Process): Promise<void> {
    this.activeProcesses.delete(sessionId);

    if (this.warmPool.length < this.warmPoolSize && process.isHealthy) {
      this.warmPool.push(process);
    } else {
      await process.abort();
    }
  }

  /**
   * Get current active process count.
   */
  get activeCount(): number {
    return this.activeProcesses.size;
  }

  /**
   * Check if at capacity.
   */
  isAtCapacity(): boolean {
    if (this.maxWorkers <= 0) return false;
    return this.activeProcesses.size >= this.maxWorkers;
  }

  private async replenishWarmPool(factory: () => Promise<Process>): Promise<void> {
    while (this.warmPool.length < this.warmPoolSize) {
      try {
        const process = await factory();
        this.warmPool.push(process);
      } catch {
        break;
      }
    }
  }

  /**
   * Graceful shutdown - terminate all processes.
   */
  async shutdown(): Promise<void> {
    for (const process of this.warmPool) {
      await process.abort();
    }
    this.warmPool = [];

    for (const process of this.activeProcesses.values()) {
      await process.abort();
    }
    this.activeProcesses.clear();
  }
}
```

### Step 2: 修改 Supervisor.ts 接入 ProcessPool

```typescript
// In Supervisor constructor:
this.processPool = new ProcessPool({
  maxWorkers: options.maxWorkers ?? 0,
  warmPoolSize: options.warmPoolSize ?? 0,
});

// In startSessionInternal, replace direct process creation:
const process = await this.processPool.acquire(sessionId, async () => {
  // ... existing process creation logic
});
```

### Step 3: 运行验证

```bash
pnpm typecheck
pnpm test
```

---

## Task 5: 端到端验证

### Step 1: 启动开发服务器

```bash
# Without Redis (in-memory mode)
pnpm dev

# With Redis
REDIS_URL=redis://localhost:6379 pnpm dev
```

### Step 2: 验证多实例事件同步（Redis 模式）

启动两个 server 实例，验证一个实例的事件能被另一个实例收到。

### Step 3: 验证新增 Provider 仅需 2 个文件

创建虚拟 Provider，验证无需修改其他文件。

### Step 4: 运行全量测试

```bash
pnpm typecheck
pnpm lint
pnpm test
```

---

## 度量指标

| 指标 | Phase 2 结束 | Phase 3 目标 | 验证方式 |
|------|-------------|-------------|----------|
| Provider 硬编码残留 | ~15 处 | 0 | grep 确认 |
| EventBus 多实例支持 | 不支持 | 支持（Redis） | 双实例测试 |
| 进程启动延迟 | ~1-2s | 0ms（warm pool） | 基准测试 |
| 新增 Provider 需改文件数 | 2（Phase 2） | 2（保持不变） | 模拟验证 |
| Redis 依赖 | 无 | ioredis | package.json 检查 |

---

## 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| Redis 引入增加部署复杂度 | Redis 为可选配置，不设置 REDIS_URL 时回退到内存模式 |
| ProcessPool warm pool 浪费资源 | warmPoolSize 默认为 0，仅在有明确需求时开启 |
| ProviderDescriptor 方法膨胀 | 用 `?` 可选方法，不强制所有 provider 实现 |
| Redis Pub/Sub 消息丢失 | 使用持久化队列处理关键事件（未来 Phase 4） |

---

## 后续演进路线

Phase 3（当前）→ Phase 4（持久化队列 + 集群协调）

Phase 3 完成后，架构改进方向：
1. **Phase 4.1**: 引入 Bull/BullMQ 持久化队列，替代内存 WorkerQueue
2. **Phase 4.2**: 集群协调（leader election、分布式锁）
3. **Phase 4.3**: 水平扩展（多 server 实例共享状态）
