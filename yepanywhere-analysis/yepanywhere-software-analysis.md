# YepAnywhere 软件分析报告

> 分析对象: yepanywhere (https://github.com/afumu/yepanywhere)
> 基准版本: 0.4.28 (MIT License)
> 分析日期: 2026-04-22

---

## 1. 项目概述与定位

### 1.1 一句话定义

YepAnywhere 是一个**自托管、端到端加密、移动优先**的 Web 应用，让开发者通过手机浏览器远程监督和控制运行在电脑上的 Claude Code / Codex AI 代理。

### 1.2 目标用户与核心痛点

| 用户画像 | 痛点 | YepAnywhere 的解决方式 |
|----------|------|------------------------|
| 移动开发者 | 离开电脑后无法查看 AI 代理进度 | 手机浏览器即可查看所有会话状态 |
| 远程工作者 | 家中电脑跑长任务，外出时想干预 | 通过 Relay 从任何地方安全连接 |
| 多项目管理者 | 多个 AI 会话在不同终端 tab 中分散 | 分层收件箱聚合所有会话 |
| 需要快速反馈者 | AI 等待用户批准时无法及时响应 | Web Push 推送通知到锁屏 |
| 移动场景用户 | 手机终端体验差（等宽字体、无文件上传） | 专为移动优化的 UI + 相册上传 |

### 1.3 差异化卖点

1. **无数据库、无云账户**：直接复用 Claude CLI 的文件系统持久化
2. **端到端加密远程访问**：SRP-6a + TweetNaCl，Relay 服务商无法解密
3. **多提供商统一界面**：Claude / Codex / Gemini / OpenCode / Ollama 一个入口
4. **服务器端渲染优化**：Markdown 和语法高亮在服务端完成，手机加载快
5. **Android 模拟器远程控制**：WebRTC 流式传输 + 触摸输入

---

## 2. 系统架构

### 2.1 四层架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                         用户设备层                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐    │
│  │手机浏览器 │  │桌面浏览器 │  │Tauri桌面 │  │Tauri Mobile App  │    │
│  │(PWA)     │  │          │  │应用      │  │(iOS/Android)     │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬─────────┘    │
└───────┼─────────────┼─────────────┼─────────────────┼──────────────┘
        │             │             │                 │
        └─────────────┴──────┬──────┴─────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         网络传输层                                    │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────┐   │
│  │ 本地 HTTP/HTTPS  │    │ Relay 服务器      │    │ WebSocket    │   │
│  │ (localhost:3400) │    │ (wss://relay.*)  │    │ 实时推送     │   │
│  └──────────────────┘    └──────────────────┘    └──────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         服务端层 (Node.js/Hono)                       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ REST API │ │ WebSocket│ │ FileWatch│ │ Supervisor│ │ Session │  │
│  │ 路由     │ │ 中继     │ │ 文件监控  │ │ 进程调度  │ │ 读写器   │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ SRP-6a   │ │ TweetNaCl│ │ Web Push │ │ Device   │ │ Markdown│  │
│  │ 认证     │ │ E2E加密  │ │ 推送通知  │ │ Bridge   │ │ 渲染    │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         AI 运行时层                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │ Claude Code  │  │ Codex CLI    │  │ Gemini CLI   │               │
│  │ (官方 SDK)   │  │ (官方 SDK)   │  │ (本地进程)   │               │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘               │
│         │                 │                 │                       │
│         ▼                 ▼                 ▼                       │
│  ┌──────────────────────────────────────────────────────┐           │
│  │ 文件系统持久化 (~/.claude/projects, ~/.codex/sessions)│           │
│  └──────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 三种部署模式

| 模式 | 网络拓扑 | 适用场景 |
|------|----------|----------|
| **本地模式** | 浏览器 ↔ localhost:3400 | 同一台电脑开发和监控 |
| **局域网模式** | 手机 ↔ 电脑 IP:3400（同一 WiFi）| 同一网络下手机监督 |
| **远程模式** | 手机 ↔ Relay ↔ 家里电脑（互联网）| 外出时远程控制 |

---

## 3. 核心模块拆解

### 3.1 Monorepo 包职责

| 包名 | 职责 | 部署形态 |
|------|------|----------|
| `@yep-anywhere/server` | 核心 Node.js 服务 | 长期运行进程 |
| `@yep-anywhere/client` | React 前端应用 | 静态文件（由 server 托管）|
| `@yep-anywhere/shared` | 类型定义和纯函数工具 | 被 server/client 依赖 |
| `@yep-anywhere/relay` | 公共连接配对服务 | 独立部署（官方托管或自托管）|
| `@yep-anywhere/desktop` | Tauri 桌面壳 + xterm | 本地安装应用 |
| `@yep-anywhere/mobile` | Tauri Mobile 壳 | App Store / APK |
| `@yep-anywhere/device-bridge` | ADB 通信桥接 | 随 server 启动 |

### 3.2 Server 内部关键组件

#### Supervisor（进程调度中心）
- 维护 `Process` 实例池，每个 `Process` 包装一个 AI SDK 会话子进程
- `WorkerQueue` 管理待处理请求队列，支持优先级和并发限制
- 空闲超时清理、优雅关闭时 abort 所有活跃进程
- `ExternalSessionTracker` 追踪外部工具（VS Code 等）创建的会话

#### Process（单个 AI 会话包装器）
- 通过 `@anthropic-ai/claude-agent-sdk` 或 `@openai/codex-sdk` 启动 CLI 子进程
- 将用户的 HTTP/WS 请求转换为 SDK 消息
- 实时读取 CLI 输出的 JSONL 事件流
- 支持权限模式切换（Approve Once / Approve All / Auto-reject）

#### FileWatcher + EventBus
- `fs.watch` 监控 `~/.claude/projects`、`~/.codex/sessions` 等目录
- 去抖动（debounce 200ms）减少重复事件
- Codex 在 macOS 上使用定期全量重扫（5s 间隔）作为 fs.watch 的 fallback
- `EventBus` 是内存中的发布-订阅总线，连接文件监控、Supervisor、推送服务

#### Session Reader 家族
- `ClaudeSessionReader`: 读取 `local/*.jsonl`，解析 Claude SDK Schema
- `CodexSessionReader`: 读取 `~/.codex/sessions/*.jsonl`
- `GeminiSessionReader`: 读取 `~/.gemini/tmp/*.jsonl`
- `OpenCodeSessionReader`: 读取 OpenCode 格式
- 统一的 `ISessionReader` 接口，通过 `readerFactory` 根据 provider 类型创建对应实例

---

## 4. 数据流转链路详解

### 4.1 用户发消息 → AI 响应（完整链路）

```
[用户点击发送]
    │
    ▼
[Frontend] MessageInput 组件收集文本 + 附件
    │ POST /api/sessions/{id}/messages
    ▼
[Server] routes/sessions.ts 接收请求
    │ 解析 executor（SSH 别名或本地）
    ▼
[Supervisor] getOrCreateProcess(sessionId)
    │ 检查现有 Process，无则新建
    ▼
[Process] 调用 realSdk.sendMessage()
    │ 通过 Claude Agent SDK 发送
    ▼
[Claude CLI] 接收消息 → 思考 → 输出响应
    │ 写入 local/{session}.jsonl（Append-only）
    ▼
[FileWatcher] 检测到文件变化
    │ 广播 event: "session-updated"
    ▼
[EventBus] 推送给所有订阅者
    │
    ├─→ [PushNotifier] 检查是否需要用户输入 → 触发 Web Push
    ├─→ [ConnectedBrowsers] SSE 推送到前端
    └─→ [SessionIndexService] 更新索引缓存
    ▼
[Frontend] MessageList 组件收到 SSE/WS 更新
    │ 增量渲染新消息
    ▼
[用户看到回复]
```

### 4.2 远程访问链路

```
[Server 启动]
    │ 读取 remote-access.json（SRP salt + verifier）
    ▼
[RelayClientService] 连接 wss://relay.yepanywhere.com/ws
    │ 发送注册消息（username + installId + 版本信息）
    ▼
[Relay Server] 将服务器加入等待队列（waiting pool）
    │
[Client 浏览器访问 yepanywhere.com/remote]
    │ 输入 username + password
    ▼
[Client JS] SRP-6a Step 1: 生成客户端公钥 A + 证明 M1
    │ 通过 Relay 转发给 Server
    ▼
[Server] SRP-6a Step 2: 验证 M1，返回服务端证明 M2
    │ 双方派生相同 sessionKey
    ▼
[Client & Server] 使用 sessionKey 作为 TweetNaCl 密钥
    │ 所有后续 payload: nacl.secretbox(message, nonce, key)
    ▼
[Relay] 仅转发加密后的二进制帧，无法解密内容
    ▼
[Client] 解密后像本地模式一样调用 REST API
    │ 请求被封装为 WebSocket 消息 → Relay → Server
    ▼
[Server] 解密 → 路由到对应 Hono handler → 业务处理
```

### 4.3 文件上传链路

```
[Frontend] 用户选择手机相册图片
    │ 通过 WebSocket 连接发送二进制帧
    ▼
[Server] ws-relay.ts / upload.ts 接收
    │ 解析 binary framing 协议
    ▼
[UploadManager] 校验文件大小（默认 100MB 上限）
    │ 写入 ~/.yep-anywhere/uploads/{uuid}-{filename}
    ▼
[Server] 返回文件元数据（URL、MIME 类型）
    │
[Frontend] 在消息中引用该文件
    │ 用户发送消息时附带 uploadedFiles 数组
    ▼
[Claude SDK] 将文件作为 image/document content block 发送
```

### 4.4 Android 模拟器控制链路

```
[Server] detectAdb() 查找 ADB 可执行文件
    │
[DeviceBridgeService] 启动 sidecar 进程（device-bridge 包编译的二进制）
    │ 通过 ADB 获取模拟器屏幕帧（h264 编码）
    ▼
[WebRTC] 建立 P2P 或 Relay 视频流
    │ 自适应码率（根据网络质量调整）
    ▼
[Frontend] EmulatorStream 组件接收 video 流
    │ 渲染 <video> 元素
    ▼
[用户触摸手机屏幕]
    │ Frontend 将触摸坐标按比例映射到模拟器分辨率
    ▼
[Server] 通过 ADB 发送 touch 事件
    │ 支持多点触摸、滑动、导航按键
```

---

## 5. 远程访问与安全机制详解

### 5.1 威胁模型

| 威胁 | 缓解措施 |
|------|----------|
| Relay 运营商窃听 | TweetNaCl E2E 加密，Relay 只能看到密文 |
| 中间人攻击 | SRP-6a 双向认证，派生密钥不经过 Relay |
| 密码泄露 | 服务器只存储 SRP verifier，不存密码 |
| 本地未授权访问 | 可选 Cookie 认证（bcrypt）|
| XSS | sanitize-html + CSP |
| 路径遍历 | 本地图片服务有路径白名单 |
| CSRF | 自定义请求头校验（X-Requested-With）|

### 5.2 SRP-6a 认证流程

1. **注册阶段**（一次性）
   - 用户设置 username + password
   - 客户端：`generateVerifier(username, password)` → `{salt, verifier}`
   - 服务器只保存 `salt` 和 `verifier`，**密码本身永不离开客户端**

2. **认证阶段**（每次连接）
   - 客户端生成随机数 `a`，计算 `A = g^a mod N`
   - 服务器生成随机数 `b`，计算 `B = k*v + g^b mod N`
   - 双方各自计算共享密钥 `K`（基于 SRP-6a 协议）
   - 客户端发送 `M1`（证明知道密码），服务器验证后回复 `M2`
   - `K` 作为 TweetNaCl secretbox 的对称密钥

### 5.3 本地安全

- **Host 头验证**：防止 DNS rebinding 攻击
- **CORS**：严格限制来源
- **X-Custom-Header**：所有 API 请求必须携带特定自定义头，防止简单 CSRF
- **文件权限**：`enforceOwnerReadWriteFilePermissions()` 确保敏感文件只有 owner 可读写

---

## 6. 技术栈选型分析

### 6.1 后端框架：Hono vs Express/Fastify

| 维度 | Hono | Express | Fastify |
|------|------|---------|---------|
| 启动速度 | 快（轻量） | 中等 | 快 |
| 中间件生态 | 够用（官方提供 node-server/node-ws）| 极其丰富 | 丰富 |
| TypeScript 支持 | 原生优秀 | 需 @types | 原生优秀 |
| 包大小 | 极小 | 中等 | 中等 |
| WebSocket 集成 | @hono/node-ws 原生 | 需额外库 | 需额外库 |
| 选择原因 | **轻量 + 现代 TS + 官方 Node 适配器** | — | — |

### 6.2 无数据库架构

**决策**：直接读写文件系统，不复用 Claude CLI 的 JSONL 文件，自建 JSON 元数据文件。

**优势**：
- 零配置（无需安装/配置数据库）
- 与 CLI 数据天然一致（Single Source of Truth）
- 备份简单（复制目录即可）

**劣势**：
- 无事务（并发写入可能损坏 JSON）
- 查询性能差（全量扫描）
- 难以做复杂查询和聚合

**折中措施**：
- `SessionIndexService` 做内存缓存 + JSON 持久化
- `proper-lockfile` 做文件级锁
- 定期全量验证（默认 30s）

### 6.3 服务器端 Markdown 渲染

**决策**：Marked + Shiki 在服务端渲染 Markdown 和代码高亮。

**原因**：
- 手机 CPU 弱，客户端渲染大量代码块会卡顿
- 服务端可以复用 Shiki 的 VS Code 主题和语法定义
- 减少前端包体积

### 6.4 SRP + NaCl 而非纯 TLS

**决策**：即使底层用 WSS/TLS，仍在应用层做 SRP-6a + TweetNaCl E2E。

**原因**：
- TLS 终止在 Relay，Relay 运营商能看到明文
- E2E 确保即使 Relay 被攻破，通信内容仍保密
- SRP 提供**前向保密**和**无密码存储**

### 6.5 Tauri 而非 Electron

**决策**：桌面/移动端使用 Tauri（Rust + 系统 WebView）。

**原因**：
- 包体积极小（相比 Electron）
- Rust 侧可以调用系统原生 API
- 安全模型更好（不需要完整 Chromium）

---

## 7. 代码规模统计

| 包 | 文件数 (ts/tsx) | 估算行数 | 说明 |
|----|-----------------|----------|------|
| server | ~210 | ~42,000 | 含大量路由和 Provider 适配 |
| client | ~140 | ~15,000 | React 组件 + Hooks |
| shared | ~60 | ~5,000 | Schema 定义为主 |
| relay | ~15 | ~3,000 | 独立服务 |
| desktop | ~20 | ~2,000 | Tauri 壳 + xterm |
| mobile | ~5 | ~500 | Tauri Mobile 配置 |
| device-bridge | ~10 | ~2,000 | ADB 桥接 |
| **总计** | **~460** | **~69,500** | 含类型定义和注释 |

> 注：含 docs/、scripts/、site/ 后全仓库约 500+ 文件。

---

## 8. 关键设计决策分析

### 8.1 为什么无数据库？

**深层原因**：项目核心定位是"Claude CLI 的远程界面"，而非独立应用。Claude CLI 已经用文件系统做了持久化，再建数据库会造成数据双写和同步问题。

**代价**：查询和统计功能受限，需要手动实现索引和缓存。

### 8.2 为什么 fs.watch 而非轮询？

**原因**：轮询在大目录下 I/O 开销大，fs.watch 是操作系统原生事件。

**代价**：
- macOS 上 fs.watch 不可靠（FSEvents 在大量文件时丢事件）→ Codex 加了 5s 定期重扫 fallback
- 不同操作系统行为不一致（Linux inotify / Windows ReadDirectoryChangesW）

### 8.3 为什么每个会话一个子进程？

**原因**：Claude Agent SDK 的设计是每个 CLI 实例对应一个长期运行的子进程，通过 stdin/stdout 通信。

**代价**：
- OS 进程数限制（默认 ~50 并发）
- 进程启动延迟（秒级）
- 内存占用大（每个 Node.js 子进程几十 MB）

### 8.4 为什么服务器端语法高亮？

**原因**：手机浏览器渲染大文件性能差，Shiki 在 Node.js 上运行更快且主题一致。

**代价**：CPU 开销转移到服务器，高并发时可能成为瓶颈。

### 8.5 为什么用 Hono 而非 Express？

**原因**：项目 2024-2025 年开发，Hono 是当时最现代的 TypeScript-first 框架，@hono/node-ws 提供原生 WebSocket 支持。

### 8.6 为什么用 Tauri 而非 Electron？

**原因**：追求极小安装包和原生系统集成。Electron 需要打包完整 Chromium（~150MB），Tauri 使用系统 WebView（~5MB）。

### 8.7 为什么维护独立文档目录？

项目有庞大的 `docs/` 目录（竞争分析、设计决策、博客），体现团队的**文档优先文化**。

**代价**：文档与代码可能不同步（存在 archive/ 目录存放废弃设计）。

---

## 9. 总结与评价

### 优势

1. **架构简洁清晰**：Monorepo 边界合理，模块职责单一
2. **安全设计到位**：SRP + E2E + 多层本地防护
3. **移动体验优秀**：服务器端渲染、PWA、推送通知
4. **多提供商抽象**：统一接口覆盖 Claude/Codex/Gemini
5. **自托管友好**：单二进制启动，无外部依赖
6. **测试全面**：单元 + E2E（含 Android soak 测试）

### 风险

1. **无数据库成为瓶颈**：会话量大时索引和扫描性能下降
2. **单节点限制**：无法水平扩展，所有状态在内存
3. **进程模型不可持续**：每个会话一个子进程，扩展性差
4. **fs.watch 不可靠**：不同平台行为差异大
5. **Relay 单点依赖**：远程模式依赖公共 Relay（可自托管缓解）
6. **多提供商 switch/case 蔓延**：新增提供商需要修改多处代码

### 适用场景

- 个人开发者日常监督 1-5 个 AI 会话
- 小型团队共享一台开发服务器
- 需要外出时偶尔干预 AI 代理

### 不适用场景

- 企业级大规模部署（>50 并发会话）
- 需要审计日志和合规报告的团队
- 要求 99.99% 可用性的生产环境

---

*本报告基于对 yepanywhere v0.4.28 源代码的静态分析。*
