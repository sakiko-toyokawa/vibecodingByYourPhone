# Phase 2: DI Container + IProviderAdapter 完整策略模式

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除所有剩余的 Provider switch/case（6 处），将 ProviderDescriptor 扩展为完整的 IProviderAdapter（含进程创建、消息归一化、行为配置），引入 awilix DI 容器替换 ServicesContainer 手动传递。

**Architecture:** 在 Phase 1 的 ProviderDescriptor + Registry 基础上，扩展 normalizeSession/getStaleThreshold/getProcessBehavior 方法消除 data-layer switch/case；将 AgentProvider / MockProvider 注册到 Registry 消除 sdk-layer switch/case；最后引入 awilix 轻量 DI 容器消除 service-layer 手动依赖传递。

**Tech Stack:** TypeScript 5.7, awilix (DI container), Hono, Vitest

---

## 文件结构

### 新增文件

| 文件 | 职责 |
|------|------|
| `packages/server/src/container.ts` | awilix DI 容器定义，注册所有服务 |
| `packages/server/src/providers/adapter.ts` | IProviderAdapter 接口（扩展 ProviderDescriptor） |
| `packages/server/src/providers/normalization.ts` | 各 Provider 的 normalizeSession 实现入口 |
| `packages/server/src/providers/mock-registry.ts` | Mock Provider Registry，替代 __mocks__/factory.ts switch/case |

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `packages/server/src/providers/descriptor.ts` | 扩展接口：normalizeSession, getStaleInTurnThresholdMs, getDenyFeedbackBehavior |
| `packages/server/src/providers/claude.ts` | 实现新增接口方法 |
| `packages/server/src/providers/codex.ts` | 实现新增接口方法 |
| `packages/server/src/providers/gemini.ts` | 实现新增接口方法 |
| `packages/server/src/providers/opencode.ts` | 实现新增接口方法 |
| `packages/server/src/providers/index.ts` | 注册 AgentProvider 实例到 Registry |
| `packages/server/src/sdk/providers/index.ts` | getProvider()/getAllProviders() 使用 Registry，消除 switch/case |
| `packages/server/src/sdk/providers/__mocks__/factory.ts` | 使用 MockRegistry，消除 switch/case |
| `packages/server/src/sessions/normalization.ts` | normalizeSession() 使用 registry.get().normalizeSession() |
| `packages/server/src/sessions/provider-resolution.ts` | getSourceForGroup() 使用 descriptor.createSource() |
| `packages/server/src/supervisor/Supervisor.ts` | getStaleInTurnThresholdMs 使用 registry；executor 逻辑使用 descriptor.isRemoteCapable |
| `packages/server/src/supervisor/Process.ts` | deny feedback 行为使用 registry.get(this.provider).getDenyFeedbackBehavior() |
| `packages/server/src/services-init.ts` | 使用 container.register() 替代手动 new + return ServicesContainer |
| `packages/server/src/app.ts` | 使用 container.resolve() 替代 ServicesContainer 参数传递 |
| `packages/server/src/routes/index.ts` | 使用 container.resolve() 获取依赖 |
| `packages/server/src/server.ts` | 使用 container.resolve() 获取服务 |
| `packages/server/package.json` | 添加 awilix 依赖 |

---

## 前置条件

- [ ] Phase 1 已完成且 `pnpm typecheck` / `pnpm test` 通过
- [ ] 已阅读 `packages/server/src/providers/descriptor.ts` 和 `registry.ts`
- [ ] 已阅读 `packages/server/src/sessions/normalization.ts` 的 provider switch/case

---

## Task 1: 扩展 ProviderDescriptor 接口定义

**目标:** 在 `descriptor.ts` 中增加 `normalizeSession`、`getStaleInTurnThresholdMs`、`getDenyFeedbackBehavior` 方法声明，为后续消除 switch/case 提供接口契约。

**Files:**
- Modify: `packages/server/src/providers/descriptor.ts`
- Modify: `packages/server/src/providers/adapter.ts` (create)

- [ ] **Step 1: 创建 adapter.ts 定义 IProviderAdapter 接口**

```typescript
import type { LoadedSession } from "../sessions/types.js";
import type { Session } from "../supervisor/types.js";
import type { ProviderDescriptor } from "./descriptor.js";

export interface IProviderAdapter extends ProviderDescriptor {
  /** Normalize a loaded session into generic Session format */
  normalizeSession(loaded: LoadedSession): Session;

  /** Stale-in-turn threshold in milliseconds for this provider */
  getStaleInTurnThresholdMs(): number;

  /** How to handle deny feedback: queue follow-up message or stay silent */
  getDenyFeedbackBehavior(): "queue-followup" | "silent";
}
```

- [ ] **Step 2: 修改 descriptor.ts 扩展接口（或从 adapter.ts re-export）**

保持 `descriptor.ts` 不变（向后兼容），在 `adapter.ts` 中扩展。修改 `providers/index.ts` 导出 IProviderAdapter：

```typescript
export { IProviderAdapter } from "./adapter.js";
```

- [ ] **Step 3: 验证编译**

Run: `pnpm typecheck`
Expected: 通过（此时没有实现类实现新接口，会有类型错误，这是预期的）

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/providers/adapter.ts packages/server/src/providers/index.ts
git commit -m "feat: define IProviderAdapter interface with normalizeSession, staleThreshold, denyFeedback"
```

---

## Task 2: 为各 ProviderDescriptor 实现 normalizeSession

**目标:** 将 `sessions/normalization.ts` 中的 provider-specific 归一化逻辑提取到各 ProviderDescriptor 中，消除 `normalizeSession()` 的 switch/case。

**Files:**
- Modify: `packages/server/src/sessions/normalization.ts`
- Modify: `packages/server/src/providers/claude.ts`
- Modify: `packages/server/src/providers/codex.ts`
- Modify: `packages/server/src/providers/gemini.ts`
- Modify: `packages/server/src/providers/opencode.ts`

- [ ] **Step 1: 修改 normalization.ts，将 provider-specific 逻辑提取为命名导出**

在文件底部添加命名导出（保持原有函数不变，只添加 export）：

```typescript
// Export for ProviderDescriptor delegation
export function normalizeClaudeSession(loaded: LoadedSession): Session {
  const { summary, data } = loaded;
  const rawMessages = data.session.messages;
  const { entries, orphanedToolUses } = collectVisibleClaudeEntries(rawMessages);
  const messages: Message[] = entries.map((raw, index) =>
    convertClaudeMessage(raw, index, orphanedToolUses),
  );
  return { ...summary, messages };
}

export function normalizeCodexSession(loaded: LoadedSession): Session {
  const { summary, data } = loaded;
  return {
    ...summary,
    messages: convertCodexEntries(data.session.entries, summary.id),
  };
}

export function normalizeGeminiSession(loaded: LoadedSession): Session {
  const { summary, data } = loaded;
  return {
    ...summary,
    messages: convertGeminiMessages(data.session.messages),
  };
}

export function normalizeOpenCodeSession(loaded: LoadedSession): Session {
  const { summary, data } = loaded;
  return {
    ...summary,
    messages: convertOpenCodeEntries(data.session.messages),
  };
}
```

- [ ] **Step 2: 修改 providers/claude.ts，实现 normalizeSession**

```typescript
import {
  normalizeClaudeSession,
} from "../sessions/normalization.js";
import type { IProviderAdapter } from "./adapter.js";

export class ClaudeProviderDescriptor implements IProviderAdapter {
  // ... existing implementation ...

  normalizeSession(loaded: LoadedSession): Session {
    return normalizeClaudeSession(loaded);
  }

  getStaleInTurnThresholdMs(): number {
    return 5 * 60 * 1000; // DEFAULT_STALE_IN_TURN_THRESHOLD_MS
  }

  getDenyFeedbackBehavior(): "queue-followup" | "silent" {
    return "silent";
  }
}
```

- [ ] **Step 3: 修改 providers/codex.ts，实现 normalizeSession**

```typescript
import {
  normalizeCodexSession,
} from "../sessions/normalization.js";

export class CodexProviderDescriptor implements IProviderAdapter {
  // ... existing implementation ...

  normalizeSession(loaded: LoadedSession): Session {
    return normalizeCodexSession(loaded);
  }

  getStaleInTurnThresholdMs(): number {
    return 60 * 60 * 1000; // CODEX_STALE_IN_TURN_THRESHOLD_MS
  }

  getDenyFeedbackBehavior(): "queue-followup" | "silent" {
    return "queue-followup";
  }
}
```

- [ ] **Step 4: 修改 providers/gemini.ts，实现 normalizeSession**

```typescript
import {
  normalizeGeminiSession,
} from "../sessions/normalization.js";

export class GeminiProviderDescriptor implements IProviderAdapter {
  // ... existing implementation ...

  normalizeSession(loaded: LoadedSession): Session {
    return normalizeGeminiSession(loaded);
  }

  getStaleInTurnThresholdMs(): number {
    return 5 * 60 * 1000;
  }

  getDenyFeedbackBehavior(): "queue-followup" | "silent" {
    return "silent";
  }
}
```

- [ ] **Step 5: 修改 providers/opencode.ts，实现 normalizeSession**

```typescript
import {
  normalizeOpenCodeSession,
} from "../sessions/normalization.js";

export class OpenCodeProviderDescriptor implements IProviderAdapter {
  // ... existing implementation ...

  normalizeSession(loaded: LoadedSession): Session {
    return normalizeOpenCodeSession(loaded);
  }

  getStaleInTurnThresholdMs(): number {
    return 5 * 60 * 1000;
  }

  getDenyFeedbackBehavior(): "queue-followup" | "silent" {
    return "silent";
  }
}
```

- [ ] **Step 6: 修改 normalization.ts，用 registry 替代 switch/case**

```typescript
import { providerRegistry } from "../providers/registry.js";
import type { IProviderAdapter } from "../providers/adapter.js";

export function normalizeSession(loaded: LoadedSession): Session {
  const { data } = loaded;
  const descriptor = providerRegistry.getOrNull(data.provider);
  if (descriptor && "normalizeSession" in descriptor) {
    return (descriptor as IProviderAdapter).normalizeSession(loaded);
  }
  // Defensive fallback for unknown providers
  throw new Error(`No IProviderAdapter found for provider: ${data.provider}`);
}
```

- [ ] **Step 7: 运行 typecheck**

Run: `pnpm typecheck`
Expected: 通过

- [ ] **Step 8: 运行测试**

Run: `pnpm test`
Expected: 通过（normalization 相关测试应继续通过）

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/providers/*.ts packages/server/src/sessions/normalization.ts
git commit -m "refactor: delegate normalizeSession to ProviderDescriptor, eliminate switch/case"
```

---

## Task 3: 消除 Supervisor.ts 中的 provider 硬编码

**目标:** 将 `getStaleInTurnThresholdMs` 和 executor 强制 Claude 的逻辑改为通过 IProviderAdapter 获取。

**Files:**
- Modify: `packages/server/src/supervisor/Supervisor.ts`

- [ ] **Step 1: 修改 getStaleInTurnThresholdMs**

原代码（约第 61-65 行）：
```typescript
function getStaleInTurnThresholdMs(provider: ProviderName): number {
  return provider === "codex" || provider === "codex-oss"
    ? CODEX_STALE_IN_TURN_THRESHOLD_MS
    : DEFAULT_STALE_IN_TURN_THRESHOLD_MS;
}
```

替换为：
```typescript
import { providerRegistry } from "../providers/registry.js";

function getStaleInTurnThresholdMs(provider: ProviderName): number {
  const descriptor = providerRegistry.getOrNull(provider);
  if (descriptor && "getStaleInTurnThresholdMs" in descriptor) {
    return (descriptor as IProviderAdapter).getStaleInTurnThresholdMs();
  }
  return 5 * 60 * 1000; // DEFAULT_STALE_IN_TURN_THRESHOLD_MS
}
```

同时删除顶部的常量：
```typescript
// 删除这两行
const DEFAULT_STALE_IN_TURN_THRESHOLD_MS = 5 * 60 * 1000;
const CODEX_STALE_IN_TURN_THRESHOLD_MS = 60 * 60 * 1000;
```

- [ ] **Step 2: （可选）简化 executor 强制 Claude 逻辑**

executor 强制 Claude 的业务规则（"只有 remote-capable provider 支持 SSH executor"）在 Task 6 完成后可通过 Registry 动态查询：

```typescript
const provider = modelSettings?.providerName
  ? getProvider(modelSettings.providerName)
  : modelSettings?.executor
    ? getProvider("claude") // Task 6 后 getProvider 内部已使用 Registry，此处保留业务语义
    : this.provider;
```

> **注意**: 硬编码 `"claude"` 是业务决策（Claude 是当前唯一 remote-capable provider），不是技术债务。若未来有多个 remote-capable provider，再改为 Registry 查询。当前保持简单。

- [ ] **Step 3: 运行 typecheck**
- [ ] **Step 4: 运行测试**
- [ ] **Step 5: Commit**

```bash
git add packages/server/src/supervisor/Supervisor.ts
git commit -m "refactor: delegate stale threshold to ProviderDescriptor"
```

---

## Task 4: 消除 Process.ts 中的 provider 硬编码

**目标:** 将 codex deny feedback 特殊处理改为通过 IProviderAdapter 获取行为配置。

**Files:**
- Modify: `packages/server/src/supervisor/Process.ts`

- [ ] **Step 1: 修改 deny feedback 逻辑**

原代码（约第 1367-1383 行）：
```typescript
if (response === "deny" && trimmedFeedback && this.provider === "codex") {
  const queued = this.queueMessage({
    text: `I denied that request. Instead: ${trimmedFeedback}`,
  });
  // ...
}
```

替换为：
```typescript
import { providerRegistry } from "../providers/registry.js";
import type { IProviderAdapter } from "../providers/adapter.js";

// ... inside respondToToolApproval ...
if (response === "deny" && trimmedFeedback) {
  const descriptor = providerRegistry.getOrNull(this.provider);
  const behavior = descriptor && "getDenyFeedbackBehavior" in descriptor
    ? (descriptor as IProviderAdapter).getDenyFeedbackBehavior()
    : "silent";
  if (behavior === "queue-followup") {
    const queued = this.queueMessage({
      text: `I denied that request. Instead: ${trimmedFeedback}`,
    });
    if (!queued.success) {
      getLogger().warn(
        {
          sessionId: this._sessionId,
          processId: this.id,
          error: queued.error,
        },
        "Failed to queue deny feedback follow-up message",
      );
    }
  }
}
```

注意：注释从 "Codex app-server decline decisions..." 改为更通用的 "Provider-specific deny feedback behavior..."

- [ ] **Step 2: 运行 typecheck**
- [ ] **Step 3: 运行测试**
- [ ] **Step 4: Commit**

```bash
git add packages/server/src/supervisor/Process.ts
git commit -m "refactor: delegate deny feedback behavior to ProviderDescriptor"
```

---

## Task 5: 消除 provider-resolution.ts 中的 getSourceForGroup switch/case

**目标:** 将 `getSourceForGroup()` 的 switch/case 改为基于 Registry 的 descriptor 方法调用，消除最后一处 session-layer 的 provider 硬编码。

**Files:**
- Modify: `packages/server/src/sessions/provider-resolution.ts`

- [ ] **Step 1: 重写 getSourceForGroup 消除 switch/case**

原代码（约第 162-177 行）：
```typescript
function getSourceForGroup(
  project: Project,
  deps: ProviderResolutionDeps,
  group: ProviderGroup,
  catalog?: ProviderProjectCatalog,
): SessionSource | null {
  switch (group) {
    case "claude":
    case "opencode":
      return createClaudeSource(project, deps);
    case "codex":
      return createCodexSource(project, deps);
    case "gemini":
      return createGeminiSource(project, deps);
  }
}
```

替换为：
```typescript
function getSourceForGroup(
  project: Project,
  deps: ProviderResolutionDeps,
  group: ProviderGroup,
  catalog?: ProviderProjectCatalog,
): SessionSource | null {
  const descriptor = providerRegistry.list().find((d) => d.group === group);
  if (!descriptor) return null;

  const isPrimary = normalizeProviderGroup(project.provider) === group;

  if (isPrimary) {
    return {
      provider: project.provider,
      reader: deps.readerFactory(project),
      sessionDir: project.sessionDir,
      kind: "primary",
    };
  }

  // Extra source (codex/gemini sessions in a non-codex/gemini project)
  const extraReader = descriptor.createExtraReader(project.path);
  if (!extraReader) return null;

  return {
    provider: descriptor.names[0],
    reader: extraReader,
    sessionDir: descriptor.getSessionDir(),
    kind: group,
  };
}
```

> **注意**: `deps.codexReaderFactory` 和 `deps.geminiReaderFactory` 测试覆盖由 `descriptor.createExtraReader()` 取代。如果测试需要 mock extra reader，在测试中注册 mock descriptor 或 mock `createExtraReader` 返回值即可。

- [ ] **Step 2: 删除不再需要的 createXxxSource 辅助函数（可选）**

如果 `createClaudeSource`、`createCodexSource`、`createGeminiSource` 已不被其他代码引用，可以删除。但保留它们也无害，作为内部辅助函数不影响 switch/case 消除的目标。

- [ ] **Step 3: 运行 typecheck**

Run: `pnpm typecheck`
Expected: 通过

- [ ] **Step 4: 运行测试**

Run: `pnpm test`
Expected: 通过（session resolution 相关测试应继续通过）

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/sessions/provider-resolution.ts
git commit -m "refactor: eliminate getSourceForGroup switch/case via ProviderRegistry"
```

---

## Task 6: 重构 sdk/providers/index.ts 消除 switch/case

**目标:** 将 `getProvider()` 和 `getAllProviders()` 从 switch/case 改为 Registry 查询。需要在 ProviderDescriptor 中增加 `getAgentProvider()` 方法。

**Files:**
- Modify: `packages/server/src/providers/adapter.ts`
- Modify: `packages/server/src/providers/claude.ts`
- Modify: `packages/server/src/providers/codex.ts`
- Modify: `packages/server/src/providers/gemini.ts`
- Modify: `packages/server/src/providers/opencode.ts`
- Modify: `packages/server/src/providers/index.ts`
- Modify: `packages/server/src/sdk/providers/index.ts`

- [ ] **Step 1: 扩展 IProviderAdapter 增加 getAgentProvider**

```typescript
import type { AgentProvider } from "../sdk/providers/types.js";

export interface IProviderAdapter extends ProviderDescriptor {
  // ... existing methods ...
  /** Get the AgentProvider instance for this descriptor (null if not applicable) */
  getAgentProvider(): AgentProvider | null;
}
```

- [ ] **Step 2: 在各 ProviderDescriptor 中实现 getAgentProvider**

Claude:
```typescript
import { claudeProvider } from "../sdk/providers/claude.js";
// ...
getAgentProvider(): AgentProvider | null {
  return claudeProvider;
}
```

Codex:
```typescript
import { codexProvider } from "../sdk/providers/codex.js";
// ...
getAgentProvider(): AgentProvider | null {
  return codexProvider;
}
```

Gemini:
```typescript
import { geminiACPProvider } from "../sdk/providers/gemini-acp.js";
// ...
getAgentProvider(): AgentProvider | null {
  return geminiACPProvider;
}
```

OpenCode:
```typescript
import { opencodeProvider } from "../sdk/providers/opencode.js";
// ...
getAgentProvider(): AgentProvider | null {
  return opencodeProvider;
}
```

- [ ] **Step 3: 修改 providers/index.ts，确保 AgentProvider 也被注册**

```typescript
import { providerRegistry } from "./registry.js";

export function registerAllProviders(modelInfoService?: ModelInfoService): void {
  if (providerRegistry.list().length > 0) {
    return;
  }

  providerRegistry.register(new ClaudeProviderDescriptor());
  providerRegistry.register(new CodexProviderDescriptor());
  providerRegistry.register(new GeminiProviderDescriptor());
  providerRegistry.register(new OpenCodeProviderDescriptor());

  // Note: claude-ollama, codex-oss, gemini-acp 通过 names 数组作为别名注册
}
```

- [ ] **Step 4: 修改 sdk/providers/index.ts**

```typescript
import { providerRegistry } from "../../providers/registry.js";
import type { IProviderAdapter } from "../../providers/adapter.js";

export function getProvider(name: ProviderName): AgentProvider | null {
  const descriptor = providerRegistry.getOrNull(name);
  if (descriptor && "getAgentProvider" in descriptor) {
    return (descriptor as IProviderAdapter).getAgentProvider();
  }
  return null;
}

export function getAllProviders(): AgentProvider[] {
  return providerRegistry
    .list()
    .map((d) =>
      "getAgentProvider" in d ? (d as IProviderAdapter).getAgentProvider() : null,
    )
    .filter((p): p is AgentProvider => p !== null);
}
```

同时保留所有现有的 import/export 语句不变（向后兼容）。

- [ ] **Step 5: 运行 typecheck**
- [ ] **Step 6: 运行测试**
- [ ] **Step 7: Commit**

```bash
git add packages/server/src/providers/*.ts packages/server/src/sdk/providers/index.ts
git commit -m "refactor: eliminate getProvider() switch/case via ProviderRegistry"
```

---

## Task 7: 重构 mock factory 消除 switch/case

**目标:** 创建 MockRegistry，让 `createMockProvider()` 和 `createAllMockProviders()` 通过 Registry 查询。

**Files:**
- Create: `packages/server/src/providers/mock-registry.ts`
- Modify: `packages/server/src/sdk/providers/__mocks__/factory.ts`

- [ ] **Step 1: 创建 mock-registry.ts**

```typescript
import type { ProviderName } from "../sdk/providers/types.js";
import {
  MockClaudeOllamaProvider,
  MockClaudeProvider,
} from "../sdk/providers/__mocks__/claude.js";
import {
  MockCodexOSSProvider,
  MockCodexProvider,
} from "../sdk/providers/__mocks__/codex.js";
import { MockGeminiProvider } from "../sdk/providers/__mocks__/gemini.js";
import { MockOpenCodeProvider } from "../sdk/providers/__mocks__/opencode.js";
import type { MockAgentProvider, MockProviderConfig } from "../sdk/providers/__mocks__/types.js";

const mockFactories: Record<
  ProviderName,
  (config: MockProviderConfig) => MockAgentProvider
> = {
  claude: (c) => new MockClaudeProvider(c),
  "claude-ollama": (c) => new MockClaudeOllamaProvider(c),
  codex: (c) => new MockCodexProvider(c),
  "codex-oss": (c) => new MockCodexOSSProvider(c),
  gemini: (c) => new MockGeminiProvider(c),
  opencode: (c) => new MockOpenCodeProvider(c),
};

export function createMockProvider(
  type: ProviderName,
  config: MockProviderConfig = {},
): MockAgentProvider {
  const factory = mockFactories[type];
  if (!factory) {
    throw new Error(`Unknown provider type: ${type}`);
  }
  return factory(config);
}

export function createAllMockProviders(
  config: MockProviderConfig = {},
): Map<ProviderName, MockAgentProvider> {
  const providers = new Map<ProviderName, MockAgentProvider>();
  for (const [name, factory] of Object.entries(mockFactories)) {
    providers.set(name as ProviderName, factory(config));
  }
  return providers;
}

export const MOCK_PROVIDER_TYPES: ProviderName[] = Object.keys(
  mockFactories,
) as ProviderName[];
```

- [ ] **Step 2: 修改 factory.ts 使用 mock-registry.ts**

```typescript
export {
  createMockProvider,
  createAllMockProviders,
  MOCK_PROVIDER_TYPES,
} from "../../providers/mock-registry.js";

// Re-export scenario helpers unchanged
export { createMockProviderWithScenarios } from "./scenarios.js";
export { createStandardScenario } from "./scenarios.js";
export { createMultiTurnScenario } from "./scenarios.js";
export { createToolUseScenario } from "./scenarios.js";
```

注意：上面的 re-export 方式假设 `factory.ts` 本身不再包含 `createMockProvider` 等函数的定义。如果 `factory.ts` 中还包含 scenario helper 函数（如 `createMockProviderWithScenarios`），保留它们不动，只替换 switch/case 部分：

```typescript
import { createMockProvider as createMockProviderFromRegistry } from "../../providers/mock-registry.js";

export function createMockProvider(
  type: ProviderName,
  config: MockProviderConfig = {},
): MockAgentProvider {
  return createMockProviderFromRegistry(type, config);
}
```

保留 `factory.ts` 中的 scenario helper 函数不变，只删除原 `createMockProvider` 和 `createAllMockProviders` 中的 switch/case 逻辑。

- [ ] **Step 3: 运行 typecheck**
- [ ] **Step 4: 运行测试**
- [ ] **Step 5: Commit**

```bash
git add packages/server/src/providers/mock-registry.ts packages/server/src/sdk/providers/__mocks__/factory.ts
git commit -m "refactor: eliminate mock factory switch/case via mock-registry"
```

---

## Task 8: 安装 awilix 并创建基础容器

**目标:** 安装 awilix，创建 DI 容器的基础结构。

**Files:**
- Modify: `packages/server/package.json`
- Create: `packages/server/src/container.ts`

- [ ] **Step 1: 安装 awilix**

Run:
```bash
cd packages/server && pnpm add awilix
```

Expected: awilix 安装成功，pnpm-lock.yaml 更新。

- [ ] **Step 2: 创建 container.ts**

```typescript
import { createContainer, asClass, asValue, type AwilixContainer } from "awilix";

// Placeholder: will be populated in Task 9-11
export let container: AwilixContainer;

export function createContainerInstance(): AwilixContainer {
  container = createContainer({
    injectionMode: "PROXY",
  });
  return container;
}
```

- [ ] **Step 3: 验证编译**

Run: `pnpm typecheck`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add packages/server/package.json pnpm-lock.yaml packages/server/src/container.ts
git commit -m "chore: add awilix dependency, create container.ts scaffold"
```

---

## Task 9: 将 services-init.ts 迁入容器

**目标:** 将 `services-init.ts` 中的手动 `new Service()` + `initialize()` 调用改为 `container.register()`。

**Files:**
- Modify: `packages/server/src/container.ts`
- Modify: `packages/server/src/services-init.ts`
- Modify: `packages/server/src/index.ts` (或 server.ts)

由于 services-init.ts 代码较多（366 行），需要仔细处理。核心思路是：
1. 保留 services-init.ts 中的初始化逻辑
2. 但改为向 container 注册，而不是返回 ServicesContainer
3. 调用方通过 `container.resolve()` 获取服务

- [ ] **Step 1: 扩展 container.ts 注册核心服务**

```typescript
import { createContainer, asClass, asValue, type AwilixContainer } from "awilix";
import type { ServicesContainer } from "./services-init.js";

export let container: AwilixContainer<ServicesContainer>;

export function createContainerInstance(): AwilixContainer<ServicesContainer> {
  container = createContainer<ServicesContainer>({
    injectionMode: "PROXY",
  });
  return container;
}

export function registerValue<K extends keyof ServicesContainer>(
  name: K,
  value: ServicesContainer[K],
): void {
  container.register(name, asValue(value));
}
```

- [ ] **Step 2: 修改 services-init.ts**

在 `initializeServices()` 函数的返回语句前，添加注册逻辑：

```typescript
import { registerValue } from "./container.js";

export async function initializeServices(): Promise<ServicesContainer> {
  // ... existing initialization code ...

  const services: ServicesContainer = {
    config,
    eventBus,
    fileWatchers,
    // ... all 18 fields ...
  };

  // Register all services in the DI container
  for (const [key, value] of Object.entries(services)) {
    registerValue(key as keyof ServicesContainer, value as ServicesContainer[keyof ServicesContainer]);
  }

  return services;
}
```

- [ ] **Step 3: 修改 server.ts / index.ts 使用 container**

在 `startServer()` 或 `initializeServices()` 调用后，确保 container 已创建：

```typescript
import { createContainerInstance } from "./container.js";

export async function startServer(): Promise<void> {
  createContainerInstance(); // Initialize empty container
  const services = await initializeServices(); // Registers services into container
  // ... rest of startup ...
}
```

- [ ] **Step 4: 运行 typecheck**
- [ ] **Step 5: 运行测试**
- [ ] **Step 6: Commit**

```bash
git add packages/server/src/container.ts packages/server/src/services-init.ts packages/server/src/server.ts
git commit -m "refactor: register all services in awilix container"
```

---

## Task 10: 将 app.ts 和 routes 改为容器解析

**目标:** 将 `app.ts` 和 `routes/index.ts` 中的 ServicesContainer 参数传递改为 `container.resolve()`。

**Files:**
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/routes/index.ts`

- [ ] **Step 1: 修改 app.ts**

原代码类似：
```typescript
export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  // ... middleware ...
  registerRoutes(app, options);
  return app;
}
```

改为：
```typescript
import { container } from "./container.js";

export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  // ... middleware ...
  // Routes now resolve their own dependencies from container
  registerRoutes(app, options);
  return app;
}
```

实际上，routes/index.ts 目前接收 ServicesContainer 作为参数。需要改为从 container 解析：

```typescript
// routes/index.ts
import { container } from "../container.js";

export function registerRoutes(app: Hono, options: AppOptions): void {
  const services = container.cradle; // All registered services
  // ... use services.supervisor, services.scanner, etc. ...
}
```

awilix 的 `container.cradle` 返回所有注册的服务对象，类型为 `ServicesContainer`。这非常方便。

- [ ] **Step 2: 修改 routes/index.ts**

```typescript
import { container } from "../container.js";

export function registerRoutes(app: Hono, _options: AppOptions): void {
  const {
    supervisor,
    scanner,
    readerFactory,
    // ... other services ...
  } = container.cradle;

  app.route("/api/sessions", createSessionsRoutes({
    supervisor,
    scanner,
    readerFactory,
    // ...
  }));
  // ... other routes ...
}
```

注意：`_options` 参数保留但前缀下划线表示未使用（如果确实不再需要的话）。如果某些选项不在 ServicesContainer 中，仍通过参数传递。

- [ ] **Step 3: 运行 typecheck**
- [ ] **Step 4: 运行测试**
- [ ] **Step 5: Commit**

```bash
git add packages/server/src/app.ts packages/server/src/routes/index.ts
git commit -m "refactor: routes resolve dependencies from DI container"
```

---

## Task 11: 清理废弃的 ServicesContainer 手动传递

**目标:** 删除不再使用的手动参数传递代码，验证整个启动链路通过容器工作。

**Files:**
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/routes/index.ts` (如有遗留)

- [ ] **Step 1: 简化 app.ts 的 createApp 签名**

如果 `AppOptions` 中所有服务都已通过 container 获取，可以大幅简化：

```typescript
export interface AppOptions {
  // Keep only options not in ServicesContainer
  // e.g., isDevMode, staticDir, etc.
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  // middleware setup using options
  registerRoutes(app);
  return app;
}
```

- [ ] **Step 2: 简化 server.ts 的 startServer 调用链**

```typescript
export async function startServer(): Promise<void> {
  createContainerInstance();
  await initializeServices(); // Services registered into container

  const app = createApp({ /* minimal options */ });
  // ... rest unchanged ...
}
```

- [ ] **Step 3: 运行全量 typecheck**

Run: `pnpm typecheck`
Expected: 零错误

- [ ] **Step 4: 运行全量测试**

Run: `pnpm test`
Expected: 通过

- [ ] **Step 5: 运行 lint**

Run: `pnpm lint`
Expected: 通过

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/app.ts packages/server/src/server.ts packages/server/src/routes/index.ts
git commit -m "refactor: remove obsolete ServicesContainer manual passing"
```

---

## Task 12: 端到端验证

**目标:** 确保 Phase 2 完成后系统可正常启动，新增 Provider 只需 2 个文件。

- [ ] **Step 1: 启动开发服务器**

Run: `pnpm dev`
Expected: 正常启动，端口 3400，能扫描到所有 provider 项目

- [ ] **Step 2: 验证 Provider 功能**

创建/读取 Claude、Codex、Gemini、OpenCode 会话，确认消息归一化正确。

- [ ] **Step 3: 模拟新增 Provider**

创建虚拟 Provider 文件 `providers/test-provider.ts`：

```typescript
import type { IProviderAdapter } from "./adapter.js";

export class TestProviderDescriptor implements IProviderAdapter {
  readonly names = ["test"];
  readonly group = "test";
  // ... minimal implementations ...
}
```

在 `providers/index.ts` 注册。验证：
- `pnpm typecheck` 通过
- 无需修改其他文件即可识别新 provider

删除测试文件。

- [ ] **Step 4: 运行 E2E 测试**

Run: `pnpm test:e2e`
Expected: 核心路径通过

- [ ] **Step 5: 最终 Commit**

```bash
git commit -m "feat(phase2): complete DI container + IProviderAdapter strategy pattern"
```

---

## 度量指标

| 指标 | Phase 1 结束 | Phase 2 目标 | 验证方式 |
|------|-------------|-------------|----------|
| `sdk/providers/index.ts` switch/case | 1 处（7 case） | 0 | grep 确认 |
| `sdk/providers/__mocks__/factory.ts` switch/case | 1 处（6 case） | 0 | grep 确认 |
| `supervisor/Supervisor.ts` provider 硬编码 | 多处 | 0（stale threshold 已委托） | grep 确认 |
| `supervisor/Process.ts` provider 硬编码 | 1 处 | 0 | grep 确认 |
| `sessions/normalization.ts` switch/case | 1 处（5 case） | 0 | grep 确认 |
| `sessions/provider-resolution.ts` switch/case | 1 处（4 case） | 0 | grep 确认 |
| 新增 Provider 需改文件数 | 2（Phase 1） | 2（保持不变） | 模拟验证 |
| DI 容器覆盖服务数 | 0 | 18+ | container.cradle 检查 |
| `app.ts` 参数传递行数 | ~30 | <5 | 行数统计 |

---

## 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| awilix 引入破坏启动流程 | 保留旧启动路径作为 fallback（Task 8-9 中先并行运行，Task 11 再清理） |
| ProviderDescriptor 新增方法导致类型不匹配 | 使用 `"method" in descriptor` 运行时检查 + 渐进式迁移 |
| normalizeSession 委托后性能下降 | 无额外开销，只是函数调用从 switch/case 变为虚方法调用 |
| mock factory 重构破坏测试 | 保留原有 API 签名，只改内部实现；运行 `pnpm test` 验证 |

---

## 后续演进路线

Phase 2（当前）→ Phase 3（进程池 + Redis Pub/Sub）

Phase 2 完成后，Provider 层面的 switch/case 已完全消除。剩余的架构改进方向：
1. **Phase 3.1**: 将 Supervisor/Process 中的 provider 字符串判断完全替换为 IProviderAdapter 委托（如 `getAgentProvider()` 已在 Task 6 完成）
2. **Phase 3.2**: EventBus 抽象为 IEventBus 接口，预留 Redis 实现
3. **Phase 3.3**: 进程池化（Process 复用）
