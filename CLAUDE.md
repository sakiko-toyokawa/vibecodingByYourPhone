# Yep Anywhere

跨项目上下文（本项目与其他 Kyle 项目的关系）见 `~/code/dotfiles/projects/README.md`。

一个面向移动端的 Claude Code 智能体监控器。类似 VS Code 的 Claude 扩展，但专为手机和多会话工作流设计。

**核心概念：**
- **Server-owned processes（服务端持有进程）** —— Claude 运行在你的开发机上；客户端断连不会打断工作
- **Multi-session dashboard（多会话仪表盘）** —— 一眼查看所有项目，无需来回切换窗口
- **Mobile supervision（移动监管）** —— 审批推送通知，可直接在锁屏界面响应
- **Zero external dependencies（零外部依赖）** —— 无需 Firebase，无需账号

**架构：** Hono 服务端管理 Claude SDK 进程。React 客户端通过 WebSocket 连接，实现实时流式传输。会话持久化为 jsonl 文件（由 SDK 处理）。

**远程访问：** 两种连接模式：
- **Direct（Tailscale/LAN）** —— 客户端直接连接服务端 WebSocket
- **Relay（中继）** —— 客户端通过中继服务器（`packages/relay/`）连接。采用 SRP（Secure Remote Password）认证，密码不会暴露给中继。所有消息通过 NaCl（XSalsa20-Poly1305）端到端加密，中继只能看到 opaque ciphertext。

详细总览见 `docs/project/`。历史愿景文档在 `docs/archive/`。

## 端口配置

所有端口都由单个 `PORT` 环境变量派生（默认：3400）：

| 端口 | 用途 |
|------|---------|
| PORT + 0 | 主服务端（默认：3400） |
| PORT + 1 | 维护服务端（默认：3401） |
| PORT + 2 | Vite 开发服务端（默认：3402） |

如需使用不同端口：
```bash
PORT=4000 pnpm dev  # 使用 4000、4001、4002
```

单独覆盖（很少需要）：
- `MAINTENANCE_PORT` - 覆盖维护端口（设为 0 可禁用）
- `VITE_PORT` - 覆盖 Vite 开发端口

## 数据目录与配置文件

服务端状态存储在数据目录中（默认：`~/.yep-anywhere/`），包括：
- `logs/` - 服务端日志
- `indexes/` - 会话索引缓存
- `uploads/` - 上传的文件
- `session-metadata.json` - 自定义标题、归档/星标状态
- `notifications.json` - 上次查看时间戳
- `push-subscriptions.json` - Web Push 订阅
- `vapid.json` - 推送用的 VAPID 密钥
- `auth.json` - 认证状态（密码哈希、会话）

### 同时运行多个实例

使用 profile 同时运行开发版和生产版（类似 Chrome 的 profile）：

```bash
# 生产环境（默认 profile，端口 3400）
PORT=3400 pnpm start

# 开发环境（dev profile，端口 4000）
PORT=4000 YEP_ANYWHERE_PROFILE=dev pnpm dev
```

这会创建独立的数据目录：
- 生产环境：`~/.yep-anywhere/`
- 开发环境：`~/.yep-anywhere-dev/`

环境变量：
- `YEP_ANYWHERE_PROFILE` - profile 名称后缀（会创建 `~/.yep-anywhere-{profile}/`）
- `YEP_ANYWHERE_DATA_DIR` - 数据目录的完整路径覆盖
- `CLAUDE_CONFIG_DIR` - Claude Code 配置目录（默认：`~/.claude`）。用于指向某个 Claude Code profile（例如 `~/.claude-work`）。会话从 `{CLAUDE_CONFIG_DIR}/projects/` 扫描。

注意：默认情况下，所有实例共享 `~/.claude/projects/`（由 SDK 管理会话）。如需为每个实例使用不同的 Claude Code profile，请设置 `CLAUDE_CONFIG_DIR`。

## Provider 与功能配置

限制可用的智能体 provider 与功能：

```bash
# 只显示 Claude Code（隐藏 Codex、Gemini 等）
ENABLED_PROVIDERS=claude pnpm dev

# 关闭语音输入（隐藏麦克风按钮）
VOICE_INPUT=false pnpm dev

# 组合示例：仅 Claude、无语音、dev profile
ENABLED_PROVIDERS=claude VOICE_INPUT=false PORT=4000 YEP_ANYWHERE_PROFILE=dev pnpm dev
```

环境变量：
- `ENABLED_PROVIDERS` - 暴露的 provider 列表，逗号分隔（默认：全部）。合法值：`claude`、`claude-ollama`、`codex`、`codex-oss`、`gemini`、`gemini-acp`、`opencode`
- `VOICE_INPUT` - 设为 `false` 可在服务端禁用语音输入按钮（默认：`true`）

## Android 模拟器测试

Android 模拟器可用时，务必优先使用它进行测试。运行 `source ~/.profile && adb devices` 检查设备，并尽可能在模拟器上部署/测试。

## 浏览器控制（UI 测试）

使用 `~/code/claw-starter` 的 claw-starter browser skill 来自动化测试 Web UI。它基于 Playwright + headless Chromium。

**启动浏览器服务端**（如果尚未运行）：

```bash
cd ~/code/claw-starter && npx tsx lib/browser/server.ts &
```

**CLI 命令**（在 `~/code/claw-starter` 下运行）：

```bash
npx tsx lib/browser-cli.ts status              # 检查服务端是否运行
npx tsx lib/browser-cli.ts open <url>           # 在新标签页打开 URL
npx tsx lib/browser-cli.ts navigate <url>       # 在当前标签页导航
npx tsx lib/browser-cli.ts snapshot --efficient  # 读取页面（accessibility tree）
npx tsx lib/browser-cli.ts screenshot           # 截图（返回路径）
npx tsx lib/browser-cli.ts click e5             # 点击 ref 对应的元素
npx tsx lib/browser-cli.ts type e5 "text"       # 在元素中输入文本
npx tsx lib/browser-cli.ts evaluate "JS expr"   # 运行 JS 并返回结果
npx tsx lib/browser-cli.ts tabs                 # 列出打开的标签页
npx tsx lib/browser-cli.ts close                # 关闭标签页
```

**工作流**：snapshot → 执行操作（click/type）使用元素 ref → 再次 snapshot 验证。

完整 CLI 参考见 `~/code/claw-starter/README.md`。

## ChromeOS 调试

Chromebook 的测试与调试（截图、输入、诊断）请使用 chromeos-testbed CLI —— 不要用 browser control skill（那是给本地 headless Chromium 用的）。

```bash
~/code/chromeos-testbed/bin/chromeos screenshot              # 截图并打印路径
~/code/chromeos-testbed/bin/chromeos screenshot output.png   # 保存为 output.png
~/code/chromeos-testbed/bin/chromeos help                    # 完整命令列表
```

需要 SSH 登录 `chromeroot`。详情见 `~/code/chromeos-testbed/CLAUDE.md`。

## 桌面端应用调试清单

调试 Tauri 桌面端应用时，**务必先检查依赖完整性**，再去排查代码变更：

```bash
# 检查 bundled server 是否包含 node_modules
ls ~/.yep-anywhere/node_modules/yepanywhere/node_modules/hono/package.json
ls ~/.yep-anywhere/node_modules/yepanywhere/node_modules/@hono/node-server/package.json
```

**原理：** 桌面端应用会把 `yepanywhere-server` 从 bundled resources 复制到 `{dataDir}/node_modules/yepanywhere/`。bundled package **已包含 `node_modules`**（构建时通过 `pnpm deploy --prod` 安装），因此如果核心依赖已存在，会跳过 `bun install`。如果数据目录之前被 CLI 安装版本用过（依赖树不同），请删除旧的 `node_modules`，避免模块解析冲突。

## 前端样式

三个前端目标共享代码，但样式并未集中在一处。修改样式时必须同时考虑对三端的影响：

| 目标 | 包 | 样式 | 说明 |
|--------|---------|---------|-------|
| **Web** | `packages/client` | Tailwind CSS v4 + `src/styles/index.css` | 桌面端主应用和移动端也使用 |
| **Desktop** | `packages/desktop` | `src/styles/index.css`（自定义 CSS） | 仅用于设置向导。主应用通过 `renderDesktopClient()` 挂载 `packages/client` |
| **Mobile** | `packages/mobile` | 继承 `packages/client` | Tauri v2 应用；`frontendDist` 指向 client `dist-remote`。无独立前端代码 |

**关键规则：** 修改 `packages/client/src/styles/index.css` 或 Tailwind class 会同时影响 **Web、Desktop（主应用）和 Mobile**。修改 `packages/desktop/src/styles/index.css` 只会影响 **Desktop 设置向导**。

## 修改代码后

修改 TypeScript 或其他源文件后，验证改动是否可编译并通过检查：

```bash
pnpm lint       # Biome 代码检查
pnpm typecheck  # TypeScript 类型检查（快速，无 emit）
pnpm test       # 单元测试
pnpm test:e2e   # E2E 测试（如果有 UI 改动）
```

对于站点改动（`site/` 中的营销页面）：
```bash
cd site && npm run build   # Astro check + build（或从根目录运行 pnpm site:build）
```

在认为任务完成前，先修复所有错误。

## 依赖安全维护

定期运行 `pnpm audit --prod`，并特别关注 `web-push -> asn1.js -> bn.js` 依赖链。在 `web-push` 上游修复发布前，保持 `bn.js` 处于已补丁状态（当前通过 pnpm override 实现）。

## Git 提交

提交信息中禁止提及 Claude、AI 或任何 AI 助手。请像人类开发者一样撰写提交信息。

## 发布到 npm

本包以 `yepanywhere` 发布到 npm，使用 GitHub Actions 的 OIDC trusted publishing（secrets 中不存储 npm token）。

**发布前：**

1. 在 `CHANGELOG.md` 中新增版本章节：
   ```markdown
   ## [0.1.11] - 2025-01-24

   ### Added
   - 新功能描述

   ### Fixed
   - Bug 修复描述
   ```

2. 提交 changelog 更新

3. 打标签并推送：
   ```bash
   git tag v0.1.11
   git push origin v0.1.11
   ```

CI workflow 会检查 changelog 是否包含待发布版本的条目。如果缺失，发布会失败并提示更新 changelog。

Workflow 会运行 lint、typecheck 和测试，然后使用 `pnpm build:bundle` 构建，并以 `--provenance` 发布以提供供应链证明。同时会创建 GitHub Release，并自动生成 release notes。

## 发布网站

网站（落地页 + `/remote` 的中继客户端）独立于 npm 部署到 GitHub Pages。**push 到 main 不会部署网站** —— 它只运行 CI（lint、typecheck、测试）。网站只在推送 `site-v*` 标签时部署（或手动触发 workflow_dispatch）。

完整流程见 `site/RELEASING.md`。

快速参考：
```bash
# 先更新 site/CHANGELOG.md，然后：
scripts/release-website.sh 1.5.3
```

## 服务端日志

服务端日志写入 `{dataDir}/logs/`（默认：`~/.yep-anywhere/logs/`）：

- `server.log` - 主服务端日志（dev 模式下使用 `pnpm dev`）
- `e2e-server.log` - E2E 测试期间的服务端日志

实时查看日志：`tail -f ~/.yep-anywhere/logs/server.log`

所有 `console.log/error/warn` 输出都会被捕获。日志文件中是 JSON 格式，控制台会美化打印。

环境变量：
- `LOG_DIR` - 自定义日志目录
- `LOG_FILE` - 自定义日志文件名（默认：server.log）
- `LOG_LEVEL` - 最低级别：fatal、error、warn、info、debug、trace（默认：info）
- `LOG_FILE_LEVEL` - 文件日志的单独级别（默认：与 LOG_LEVEL 相同）
- `LOG_TO_FILE` - 设为 "true" 启用文件日志（默认：关闭）
- `LOG_PRETTY` - 设为 "false" 禁用控制台美化日志（默认：开启）

## 客户端控制台日志

远程收集移动端浏览器的 `console.log/warn/error`。对无法打开 DevTools 的设备上的连接问题调试很有用。

**启用：** 开发者模式设置 → "Remote Log Collection" 开关。

**存储：** `{dataDir}/logs/client-logs/`（默认：`~/.yep-anywhere/logs/client-logs/`）。每个设备每天一个 JSONL 文件，命名为 `client-{YYYY-MM-DD}-{deviceId}.jsonl`。设备 UUID 持久化在客户端的 `localStorage` 中。

每一行是一条日志事件：
```json
{"timestamp":1770790157738,"level":"log","prefix":"[SecureConnection]","message":"[SecureConnection] Closed: 1006","_receivedAt":1770790161477}
```

每次会话开始会写入一条 `[ClientInfo]` 条目，包含 user agent、屏幕尺寸、DPR 和语言。

```bash
# 列出设备日志文件
ls ~/.yep-anywhere/logs/client-logs/

# 查看某设备今天的日志
cat ~/.yep-anywhere/logs/client-logs/client-$(date +%Y-%m-%d)-<deviceId>.jsonl

# 实时跟踪新日志
tail -f ~/.yep-anywhere/logs/client-logs/*.jsonl
```

**实现：** `packages/client/src/lib/diagnostics/ClientLogCollector.ts`（客户端），`packages/server/src/routes/client-logs.ts`（服务端 `POST /api/client-logs`）。

## 维护服务端

一个轻量的独立 HTTP 服务端运行在 PORT + 1（默认 3401），用于带外诊断。当主服务端无响应时很有用。

```bash
# 检查服务端状态
curl http://localhost:3401/status

# 运行时开启代理调试日志
curl -X PUT http://localhost:3401/proxy/debug -d '{"enabled": true}'

# 运行时调整日志级别
curl -X PUT http://localhost:3401/log/level -d '{"console": "debug"}'

# 开启 Chrome DevTools inspector
curl -X POST http://localhost:3401/inspector/open
# 然后在 Chrome 中打开 chrome://inspect

# 触发服务端重启
curl -X POST http://localhost:3401/reload
```

可用端点：
- `GET /health` - 健康检查
- `GET /status` - 内存、运行时长、连接数
- `GET|PUT /log/level` - 获取/设置日志级别
- `GET|PUT /proxy/debug` - 获取/设置代理调试日志
- `GET /inspector` - inspector 状态
- `POST /inspector/open` - 启用 Chrome DevTools
- `POST /inspector/close` - 禁用 Chrome DevTools
- `POST /reload` - 重启服务端

环境变量：
- `MAINTENANCE_PORT` - 维护端口（默认：PORT + 1，设为 0 禁用）
- `PROXY_DEBUG` - 启动时开启代理调试日志（默认：false）

## 验证会话数据

使用 Zod schema 验证 JSONL 会话文件：

```bash
# 验证 ~/.claude/projects 中的所有会话
npx tsx scripts/validate-jsonl.ts

# 验证指定文件或目录
npx tsx scripts/validate-jsonl.ts /path/to/session.jsonl
```

schema 变更后运行此脚本，验证与现有会话数据的兼容性。

## 验证工具结果

针对 SDK 原始日志中的 `tool_use_result` 字段验证 ToolResultSchemas：

```bash
# 验证 sdk-raw.jsonl（默认位置）
npx tsx scripts/validate-tool-results.ts

# 仅输出摘要（无错误详情）
npx tsx scripts/validate-tool-results.ts --summary

# 按工具名过滤
npx tsx scripts/validate-tool-results.ts --tool=Edit
```

当设置 `LOG_SDK_MESSAGES=true` 时，SDK 会提供结构化的 `tool_use_result` 对象，并记录到 `~/.yep-anywhere/logs/sdk-raw.jsonl`。新增工具 schema 或调试工具结果解析时运行此脚本。

## 类型系统

类型定义位于 `packages/shared/src/claude-sdk-schema/`（以 Zod schema 为唯一事实来源）。

关键模式：
- **消息识别**：使用 `getMessageId(m)` 辅助函数，返回 `uuid ?? id`
- **内容访问**：优先使用 `message.content` 而非顶层 `content`
- **类型判别**：使用 `type` 字段（user/assistant/system/summary）
