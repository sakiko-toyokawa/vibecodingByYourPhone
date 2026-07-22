# Yep Anywhere 项目操作手册

## 项目简介

Yep Anywhere 是一个面向移动端的 Claude Code 代理监控器。核心特点：服务端托管进程（客户端断开不影响工作）、多会话仪表盘、移动端推送通知、零外部依赖。

架构：Hono 服务端管理 Claude SDK 进程，React 客户端通过 WebSocket 实时连接，会话数据持久化为 jsonl 文件。

---

## 目录结构

```
packages/
  server/          # Hono 服务端
  client/          # React 前端
  shared/          # 共享类型和工具
  relay/           # 中继服务器（远程连接）
site/              # 官网（Astro）
scripts/           # 构建和开发脚本
docs/              # 项目文档
```

---

## 环境要求

- Node.js >= 20
- pnpm 9.15.1（由 packageManager 字段锁定）

---

## 安装

```bash
pnpm install
```

只安装核心包（server + client + shared）：
```bash
pnpm setup:core
```

---

## 开发命令

| 命令 | 作用 |
|------|------|
| `pnpm dev` | 启动完整开发环境（server + client） |
| `pnpm dev:auto` | 同时启动 server 和 client（后台） |
| `pnpm --filter server dev` | 只启动服务端 |
| `pnpm --filter client dev` | 只启动客户端 |
| `pnpm --filter client dev:remote` | 客户端以远程模式启动 |
| `pnpm staging` | 启动 staging 环境 |

服务端开发变体：
```bash
pnpm --filter server dev:watch      # watch 模式
pnpm --filter server dev:mock       # 禁用认证
```

---

## 构建

```bash
pnpm build              # 构建所有包
pnpm build:bundle       # 构建发布包
pnpm --filter client build:stable   # 构建稳定版客户端
pnpm --filter client build:remote   # 构建远程版客户端
```

---

## 代码检查

```bash
pnpm lint       # Biome 检查
pnpm format     # Biome 格式化
pnpm typecheck  # TypeScript 类型检查（不输出文件）
```

---

## 生产启动

```bash
pnpm start
# 等价于：NODE_ENV=production node packages/server/dist/index.js
```

---

## 端口配置

所有端口基于一个 `PORT` 环境变量（默认 3400）：

| 偏移 | 端口 | 用途 |
|------|------|------|
| +0 | 3400 | 主服务端 |
| +1 | 3401 | 维护服务器（HTTP 诊断接口） |
| +2 | 3402 | Vite 开发服务器 |

```bash
PORT=4000 pnpm dev   # 使用 4000, 4001, 4002
```

单独覆盖：`MAINTENANCE_PORT`、`VITE_PORT`

---

## 数据目录与多实例

默认数据目录：`~/.yep-anywhere/`

内容：
- `logs/` — 服务端日志
- `indexes/` — 会话索引缓存
- `uploads/` — 上传文件
- `session-metadata.json` — 会话元数据
- `notifications.json` — 通知时间戳
- `push-subscriptions.json` — Web Push 订阅
- `vapid.json` — VAPID 密钥
- `auth.json` — 认证状态

### 多实例运行（Profile）

```bash
# 生产实例（默认，端口 3400）
PORT=3400 pnpm start

# 开发实例（端口 4000，数据隔离）
PORT=4000 YEP_ANYWHERE_PROFILE=dev pnpm dev
```

数据目录：
- 默认：`~/.yep-anywhere/`
- dev profile：`~/.yep-anywhere-dev/`

环境变量：
- `YEP_ANYWHERE_PROFILE` — profile 后缀
- `YEP_ANYWHERE_DATA_DIR` — 完整数据目录路径
- `CLAUDE_CONFIG_DIR` — Claude Code 配置目录（默认 `~/.claude`）

---

## 功能开关

```bash
# 只启用 Claude Code（隐藏 Codex、Gemini 等）
ENABLED_PROVIDERS=claude pnpm dev

# 禁用语音输入
VOICE_INPUT=false pnpm dev

# 组合示例
ENABLED_PROVIDERS=claude VOICE_INPUT=false PORT=4000 YEP_ANYWHERE_PROFILE=dev pnpm dev
```

可用 provider：`claude`, `claude-ollama`, `codex`, `codex-oss`, `gemini`, `gemini-acp`, `opencode`

---

## 维护服务器

端口默认 `PORT + 1`（3401），提供 HTTP 诊断接口：

```bash
curl http://localhost:3401/status          # 内存、运行时间、连接数
curl -X PUT http://localhost:3401/log/level -d '{"console": "debug"}'
curl -X POST http://localhost:3401/inspector/open   # 开启 Chrome DevTools
curl -X POST http://localhost:3401/reload  # 重启服务端
```

可用端点：`/health`, `/status`, `/log/level`, `/proxy/debug`, `/inspector`, `/inspector/open`, `/inspector/close`, `/reload`

---

## 日志

服务端日志位置：`{dataDir}/logs/server.log`

实时查看：
```bash
tail -f ~/.yep-anywhere/logs/server.log
```

环境变量：
- `LOG_DIR` — 自定义日志目录
- `LOG_FILE` — 自定义日志文件名
- `LOG_LEVEL` — 日志级别（fatal, error, warn, info, debug, trace），默认 info
- `LOG_FILE_LEVEL` — 文件日志级别
- `LOG_TO_FILE` — 设为 true 开启文件日志
- `LOG_PRETTY` — 设为 false 禁用终端美化输出

---

## 远程连接

两种模式：

1. **直连（Tailscale/LAN）** — 客户端直连服务端 WebSocket
2. **中继** — 通过 `packages/relay/` 中继服务器连接。使用 SRP 认证，NaCl (XSalsa20-Poly1305) 端到端加密

---

## 发布

### npm 包

1. 更新 `CHANGELOG.md`
2. 提交变更
3. 打标签推送：
```bash
git tag v0.x.x
git push origin v0.x.x
```

CI 会自动验证 changelog、运行检查、构建并发布。

### 网站

网站部署与 npm 分离，需推送 `site-v*` 标签：
```bash
# 先更新 site/CHANGELOG.md
scripts/release-website.sh 1.x.x
```

---

## 常用脚本

```bash
# 生成 VAPID 密钥（用于 Web Push）
pnpm setup-vapid

# 验证会话 JSONL 文件
npx tsx scripts/validate-jsonl.ts

# 验证工具结果
npx tsx scripts/validate-tool-results.ts

# 更新 Codex 协议定义
pnpm codex:protocol:update
```

---

## 网站开发

```bash
pnpm site:dev     # 开发模式
pnpm site:build   # 构建
```

---

## 关键注意事项

1. **端口占用**：`PORT`, `PORT+1`, `PORT+2` 必须都可用
2. **数据隔离**：使用 `YEP_ANYWHERE_PROFILE` 实现开发/生产数据隔离
3. **Claude 配置**：会话从 `~/.claude/projects/` 读取，可通过 `CLAUDE_CONFIG_DIR` 指向不同 profile
4. **安全审计**：定期运行 `pnpm audit --prod`，关注 `web-push -> asn1.js -> bn.js` 依赖链
