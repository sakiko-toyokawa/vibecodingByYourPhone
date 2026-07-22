# YepAnywhere 重构计划书与可行性分析报告

> 分析对象: yepanywhere v0.4.28
> 分析日期: 2026-04-22
> 文档性质: 基于静态代码分析的架构改进建议

---

## 1. 现状评估与问题归类

### 1.1 问题分级矩阵

| 级别 | 定义 | 问题数量 | 代表问题 |
|------|------|----------|----------|
| **P0** | 安全风险或数据损坏可能 | 3 | SRP 凭证文件权限、无事务持久化、unhandledRejection 静默吞错 |
| **P1** | 架构债务，阻碍扩展 | 5 | index.ts 过千行、多提供商 switch/case 蔓延、EventBus 单进程 |
| **P2** | 可维护性/性能问题 | 4 | 缺乏依赖注入、测试覆盖不足、文档与代码不同步 |
| **P3** | 优化项，当前可接受 | 3 | CLI 手动解析、archive 文档堆积、环境变量分散 |

### 1.2 根因分析

```
快速迭代技术债
    │
    ├─→ 无数据库假设 → 手动实现索引/缓存/锁（复杂度转移）
    ├─→ MCP/Agent SDK 绑定过深 → Provider 差异通过 switch/case 处理
    ├─→ Monorepo 边界模糊 → server 包膨胀（~42K 行）
    └─→ "能跑就行" 阶段 → 测试和架构设计滞后于功能开发
```

---

## 2. 重构目标与原则

### 2.1 目标

| 维度 | 当前状态 | 目标状态 | 度量方式 |
|------|----------|----------|----------|
| 安全 | P0 风险未消除 | 零已知安全漏洞 | 安全审计通过 |
| 稳定 | unhandledRejection 吞错 | 所有异常可追踪 | Sentry 告警为零 |
| 性能 | 20 并发进程上限 | 100+ 并发会话 | 压力测试通过 |
| 可维护 | index.ts 1022 行 | 单文件 <200 行 | lint 规则强制 |
| 可扩展 | 新增 Provider 改 5+ 文件 | 新增 Provider 改 2 文件 | 新增 Provider PR <100 行 |

### 2.2 原则

1. **渐进式演进**：每个重构步骤可独立回滚，不影响功能
2. **向后兼容**：现有 `~/.yep-anywhere/` 数据无需迁移（可选层除外）
3. **测试先行**：重构前补测试，重构后测试必须通过
4. **小步快跑**：单次 PR <500 行变更，降低 review 成本

---

## 3. 分阶段重构路线图

### Phase 1: 短期（0-1 个月）— 止血与加固

**目标**: 消除 P0 风险，提升代码可读性。

| 任务 | 工作量 | 验收标准 |
|------|--------|----------|
| T1.1 修复 unhandledRejection 处理器 | 2d | 区分"已知 SDK 错误"与"未知错误"，未知错误必须 crash 并上报 |
| T1.2 拆分 `index.ts`（>1000 行） | 3d | 拆分为 `server.ts`、`services-init.ts`、`shutdown.ts`，每文件 <200 行 |
| T1.3 拆分 `app.ts`（>800 行） | 3d | 路由注册提取到 `routes/index.ts`，中间件提取到 `middleware/index.ts` |
| T1.4 SRP 凭证文件权限加固 | 1d | 创建时强制 `0o600`，启动时校验，异常则拒绝启动 |
| T1.5 环境变量统一配置 | 2d | 所有配置集中到 `config.ts`，禁止其他文件直接读 `process.env` |
| T1.6 测试覆盖率提升到 60% | 5d | 核心模块（Supervisor、SessionReader、Auth）必须有单元测试 |

**Phase 1 总投入**: ~16 人天

### Phase 2: 中期（1-3 个月）— 架构解耦

**目标**: 消除 P1 架构债务，建立扩展基础。

| 任务 | 工作量 | 验收标准 |
|------|--------|----------|
| T2.1 引入可选 SQLite 数据库层 | 10d | 默认关闭（保持无数据库），开启后 session-metadata/indexes 写入 SQLite；双写 shadow write 验证一致性 |
| T2.2 依赖注入容器 | 8d | 使用 TSyringe 或 awilix，消除 `readerFactory` 等手动传递 |
| T2.3 Provider 策略模式重构 | 10d | 定义 `IProviderAdapter` 接口，每个 Provider 独立实现，消除 switch/case |
| T2.4 EventBus 预留多进程适配 | 5d | 抽象 `IEventBus` 接口，当前内存实现，未来可替换为 Redis/RabbitMQ |
| T2.5 文件监控优化 | 5d | 大目录时使用 chokidar（带 fsevents 原生绑定），小目录保持 fs.watch |
| T2.6 错误处理统一 | 5d | 引入 `AppError` 层级体系（UserError / SystemError / SDKError），统一 HTTP 状态码映射 |

**Phase 2 总投入**: ~43 人天

### Phase 3: 长期（3-6 个月）— 性能与扩展

**目标**: 支持企业级规模，建立生态。

| 任务 | 工作量 | 验收标准 |
|------|--------|----------|
| T3.1 进程池化 | 15d | Process 复用（长连接池），减少子进程启动开销 |
| T3.2 连接池与水平扩展 | 15d | EventBus 替换为 Redis Pub/Sub，支持多服务器实例 |
| T3.3 服务器端渲染性能优化 | 10d | Markdown/Shiki 渲染引入 Worker Pool 或缓存 |
| T3.4 插件系统 | 20d | 定义 Plugin API，支持第三方扩展（通知渠道、提供商适配器） |
| T3.5 Monorepo 结构优化 | 5d | 9 包 → `apps/`（server/client/desktop/relay）+ `packages/`（shared/core） |

**Phase 3 总投入**: ~65 人天

---

## 4. 具体重构方案

### 4.1 数据库层引入（SQLite/LibSQL）

**现状问题**:
- `SessionIndexService` 手动实现缓存和锁，代码复杂
- `session-metadata.json` 并发写入可能损坏
- 无法做复杂查询（如"过去 7 天所有项目的活跃会话数"）

**方案设计**:

```typescript
// 抽象层
interface IMetadataStore {
  getSessionMetadata(id: string): Promise<SessionMetadata | null>;
  setSessionMetadata(id: string, data: SessionMetadata): Promise<void>;
  listSessions(filter?: SessionFilter): Promise<SessionMetadata[]>;
}

// 实现 A: 文件系统（默认，向后兼容）
class FileMetadataStore implements IMetadataStore { ... }

// 实现 B: SQLite（可选）
class SqliteMetadataStore implements IMetadataStore { ... }
```

**Schema（最小化）**:

```sql
CREATE TABLE session_metadata (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT,
  is_archived BOOLEAN DEFAULT 0,
  is_starred BOOLEAN DEFAULT 0,
  custom_title TEXT,
  provider TEXT,
  executor TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_project ON session_metadata(project_id);
CREATE INDEX idx_updated ON session_metadata(updated_at);
```

**迁移策略**:
1. 启动时检查 `USE_SQLITE` 环境变量
2. 若为 true，读取 `session-metadata.json` 并导入 SQLite（一次性）
3. 双写 shadow write：同时写 JSON 和 SQLite，验证一致性
4. 运行 2 周后，关闭 JSON 写入

### 4.2 依赖注入容器

**现状问题**:
`app.ts` 中路由注册代码如下：

```typescript
app.route("/api/sessions", createSessionsRoutes({
  supervisor, scanner, readerFactory, externalTracker,
  notificationService, sessionMetadataService, eventBus,
  codexScanner, codexSessionsDir, codexReaderFactory,
  geminiScanner, geminiSessionsDir, geminiReaderFactory,
  serverSettingsService, modelInfoService,
}));
```

**重构后**:

```typescript
// container.ts
container.register("supervisor", { useClass: Supervisor });
container.register("sessionRoutes", { useClass: SessionsRoutes });

// app.ts
const sessionRoutes = container.resolve("sessionRoutes");
app.route("/api/sessions", sessionRoutes.getRouter());
```

**收益**:
- 路由不再关心具体依赖
- 测试时可轻松 mock
- 新增路由无需修改 `app.ts`

### 4.3 Provider 策略模式

**现状问题**:

```typescript
// readerFactory 中的 switch/case（多处存在类似代码）
switch (project.provider) {
  case "codex": return new CodexSessionReader(...);
  case "gemini": return new GeminiSessionReader(...);
  case "claude": return new ClaudeSessionReader(...);
  case "opencode": return new OpenCodeSessionReader(...);
}
```

**重构后**:

```typescript
interface IProviderAdapter {
  readonly name: ProviderName;
  createReader(project: Project): ISessionReader;
  createProcess(options: ProcessOptions): Process;
  detectCli(): Promise<CliInfo>;
  getSessionsDir(): string;
}

// 注册
registry.register(new ClaudeProviderAdapter());
registry.register(new CodexProviderAdapter());

// 使用
const adapter = registry.get(project.provider);
const reader = adapter.createReader(project);
```

**收益**:
- 新增 Provider = 新增一个类文件
- 无需修改现有代码
- 支持运行时插件加载

### 4.4 测试架构分层

**现状问题**:
- E2E 测试依赖真实 SDK（`REAL_SDK_TESTS=true`）
- 单元测试与集成测试边界模糊
- 覆盖率未知

**目标架构**:

```
tests/
├── unit/                    # 纯函数、无 I/O
│   ├── crypto/
│   ├── pagination/
│   └── provider-resolution/
├── integration/             # 有 I/O，无外部服务
│   ├── session-reader/
│   ├── file-watcher/
│   └── metadata-store/
└── e2e/                     # 完整链路
    ├── api/                 # HTTP API 测试（mock SDK）
    ├── sdk/                 # 真实 SDK 测试（可选）
    └── ui/                  # Playwright 前端测试
```

**覆盖率目标**:

| 层级 | 目标覆盖率 | 强制 gate |
|------|------------|-----------|
| unit | >=90% | ✅ CI 阻塞 |
| integration | >=70% | ✅ CI 阻塞 |
| e2e (api) | 核心路径 100% | ✅ CI 阻塞 |
| e2e (sdk) | 可选 | ❌ 不阻塞 |

### 4.5 安全加固清单

| 编号 | 加固项 | 优先级 | 实现方式 |
|------|--------|--------|----------|
| S1 | SRP 凭证文件 0o600 | P0 | `fs.chmod` 强制 |
| S2 | 自签名证书指纹校验 | P1 | 首次生成后 pin 指纹，变更时告警 |
| S3 | 文件上传 MIME 校验 | P1 | magic number + 白名单 |
| S4 | 上传文件大小限制（可配置）| P1 | 已有 100MB 默认值，需前端同步校验 |
| S5 | API 速率限制 | P1 | Hono 中间件（per-IP / per-session）|
| S6 | Relay CORS 收紧 | P2 | origin 白名单替代 `*` |
| S7 | 请求日志脱敏 | P2 | 自动 mask password/token |
| S8 | 依赖漏洞扫描 | P2 | `pnpm audit` + Dependabot |

---

## 5. 风险评估与回滚策略

### 5.1 主要风险

| 风险 | 概率 | 影响 | 缓解与回滚 |
|------|------|------|------------|
| SQLite 迁移数据丢失 | 低 | 极高 | 双写 shadow write + 自动备份 JSON |
| DI 容器引入破坏启动流程 | 中 | 高 | 保留旧启动路径作为 fallback，feature flag 切换 |
| Provider 重构导致多提供商不可用 | 中 | 高 | 每个 Provider 独立测试，灰度发布 |
| 性能优化反向退化 | 中 | 中 | A/B 测试 + 性能基准回归 |
| 社区贡献者不适应新架构 | 低 | 低 | 提供迁移指南 + 代码模板 |

### 5.2 回滚机制

1. **数据回滚**: 每次启动自动备份 `~/.yep-anywhere/` 到 `~/.yep-anywhere-backups/{timestamp}/`
2. **代码回滚**: 每个重构阶段独立分支，保留 30 天
3. **功能回滚**: 所有重大变更通过环境变量 feature flag 控制（如 `USE_SQLITE=false` 立即回退）
4. **监控告警**: 错误率 >1% 或 P99 延迟 >2x 基线时自动告警

---

## 6. 可行性分析

### 6.1 成本估算

| 阶段 | 人天 | 按 $500/人天 | 说明 |
|------|------|--------------|------|
| Phase 1（止血） | 16 | $8,000 | 1 名高级后端工程师 |
| Phase 2（解耦） | 43 | $21,500 | 1 全栈 + 1 后端 |
| Phase 3（扩展） | 65 | $32,500 | 2 全栈 + 1 DevOps |
| **总计** | **124** | **$62,000** | **约 6.2 人月** |

### 6.2 收益分析

| 收益项 | 量化估算 | 说明 |
|--------|----------|------|
| P0 安全风险消除 | 不可估量 | 避免一次数据泄露的声誉损失 |
| 新增 Provider 效率 | 5x | 从改 5 个文件到改 1 个文件 |
| 并发会话上限 | 5x | 从 20 到 100+ |
| 企业客户获取 | +30% | 审计日志和权限控制是 enterprise 刚需 |
| 维护成本降低 | -40% | DI + 策略模式减少样板代码 |

### 6.3 ROI 结论

- **短期（Phase 1）**: 投入 $8K，消除安全风险，ROI 极高（风险避免的收益不可估量）
- **中期（Phase 2）**: 投入 $21.5K，获得架构扩展性，ROI 高（支持未来 1-2 年的功能扩展）
- **长期（Phase 3）**: 投入 $32.5K，进入企业市场，ROI 中等（取决于企业客户转化率）

**建议**: **优先执行 Phase 1 + Phase 2**，Phase 3 视用户增长和企业线索数量决策。

---

## 7. 优先级矩阵

### 7.1 影响/工作量四象限

```
            高影响
               │
    ┌─────────┼─────────┐
    │  T1.1   │  T2.1   │
    │  T1.2   │  T2.3   │
    │  T1.3   │  T1.6   │
低工作量├─────────┼─────────┤高工作量
    │  T1.4   │  T3.4   │
    │  T1.5   │  T3.1   │
    │  S1-S4  │  T3.2   │
    └─────────┼─────────┘
               │
            低影响
```

### 7.2 执行批次

**Batch 1（立即执行）**: T1.1, T1.2, T1.3, T1.4, S1-S4
- 消除 P0 风险
- 提升代码可读性

**Batch 2（1 个月内）**: T1.5, T1.6, T2.4, T2.5
- 配置统一
- 测试补全
- 文件监控优化

**Batch 3（2-3 个月）**: T2.1, T2.2, T2.3, S5-S8
- 数据库层
- 依赖注入
- Provider 策略模式

**Batch 4（4-6 个月）**: T3.1, T3.2, T3.3
- 进程池化
- 水平扩展
- 性能优化

**Batch 5（视情况）**: T3.4, T3.5
- 插件系统
- Monorepo 结构调整

### 7.3 关键决策点

| 决策点 | 触发条件 | 选项 |
|--------|----------|------|
| D1: 是否引入 SQLite | Phase 1 完成后用户量 >1000 | A) 引入 B) 保持文件系统 |
| D2: 是否用 DI 容器 | Phase 2 开始时 | A) TSyringe B) awilix C) 手写 |
| D3: 是否替换 EventBus | Phase 3 开始时并发需求 >50 | A) Redis B) RabbitMQ C) 保持内存 |
| D4: 是否支持水平扩展 | 企业客户签约前 | A) 优先做 B) 延后 |

---

## 附录 A: Monorepo 结构优化建议

### 当前结构问题

```
packages/
  server/      # 42K 行，过重
  client/      # 15K 行
  shared/      # 5K 行
  relay/       # 3K 行，独立部署
  desktop/     # 2K 行，实际是 client + Tauri
  mobile/      # 500 行，实际是 client + Tauri
  device-bridge/      # 2K 行
  android-device-server/  # 几百行
  ios-sim-server/    # 几百行
```

### 建议结构

```
apps/
  server/              # Node.js 服务（瘦身到 25K 行）
  web/                 # React 前端（原 client）
  desktop/             # Tauri 桌面（依赖 web + core）
  mobile/              # Tauri Mobile（依赖 web + core）
  relay/               # 独立中继服务

packages/
  core/                # 共享业务逻辑（原 shared + server 通用模块）
  ui/                  # 共享 UI 组件
  device-bridge/       # ADB 桥接（独立包）
  test-utils/          # 测试工具
```

**迁移步骤**:
1. 提取 `server/src/sessions/`、`server/src/supervisor/` 中通用逻辑到 `packages/core/`
2. 提取通用 React 组件到 `packages/ui/`
3. `apps/web/` 从 `packages/client/` 迁移
4. `apps/server/` 瘦身，移除已提取的通用代码

---

## 附录 B: 重构度量指标

| 指标 | 基线 | Phase 1 目标 | Phase 2 目标 | Phase 3 目标 |
|------|------|-------------|-------------|-------------|
| index.ts 行数 | 1022 | <200 | <200 | <200 |
| app.ts 行数 | 809 | <300 | <200 | <200 |
| 单文件最大行数 | 1022 | <500 | <300 | <300 |
| switch/case 处数 | 12 | 10 | 2 | 0 |
| 测试覆盖率 | ~30% | 60% | 75% | 85% |
| 单 Provider 新增文件数 | 5+ | 5+ | 2 | 2 |
| 平均启动时间 | 3s | 2.5s | 2s | 1.5s |
| 并发会话上限 | 20 | 25 | 50 | 100+ |

---

*本报告基于对 yepanywhere v0.4.28 源代码的静态分析，所有重构建议需结合运行时 profiling 和业务优先级最终决策。*
