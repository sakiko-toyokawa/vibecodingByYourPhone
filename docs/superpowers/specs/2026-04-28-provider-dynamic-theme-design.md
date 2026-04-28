# Provider 动态主题系统设计文档

## 背景

Yep Anywhere 支持多个 AI provider（Claude、Codex、Gemini、OpenCode）。当前 UI 使用统一的中性主题，各 provider 仅在 badge 颜色上有差异。用户希望在选中 project 时，整个 App 的视觉风格根据该 project 关联的 provider 发生完整变化——包括颜色、字体、动效等。

## 目标

- 选中 project 时，App 自动切换到该 provider 的品牌视觉风格
- 每个 provider 有独立的 light/dark 变体
- 无 project 上下文时（Projects 列表、Settings、Inbox 等），显示 Yep Anywhere 默认品牌风格
- 切换平滑，有过渡动画

## 非目标

- 不替换组件结构，只替换视觉表现
- 不添加 provider 专属功能逻辑
- 不在全局 sessions 列表中推断 provider（混合多种 provider 时保持默认风格）

## 方案

采用 **CSS 变量 + 条件类名 + 微组件** 方案：

- **CSS 变量**：每个 provider 定义完整颜色、字体、间距变量集，通过 `data-provider` 属性选择器切换
- **条件类名**：每个 provider 的动效差异通过注入到 `<html>` 的类名实现
- **微组件**：少量需要完全重写的组件（LoadingSpinner、SendButton 等）使用条件渲染

## 架构

```
┌─────────────────────────────────────────────────────────┐
│  <html data-provider="claude" data-theme="dark">        │
│  ├─ CSS 变量层：[data-provider="claude"] 选择器注入      │
│  ├─ 条件类名：.provider-anim-claude（动效 keyframes）   │
│  └─ 字体加载：Google Fonts 预加载                        │
└─────────────────────────────────────────────────────────┘
           ↑
    ProviderThemeContext (React)
           ↑
    当前 route 的 projectId → API 获取 provider → setProvider
```

### Provider 推断规则

| 路由 | Provider |
|------|----------|
| `/projects/:projectId/*` | 该 project 的 provider |
| `/projects` | 默认 |
| `/sessions` | 默认（混合 provider） |
| `/settings` | 默认 |
| `/agents` | 默认 |
| `/inbox` | 默认（混合 provider） |

### 新文件

- `packages/client/src/contexts/ProviderThemeContext.tsx` — Context + Provider
- `packages/client/src/hooks/useActiveProvider.ts` — 从 route 推断 provider
- `packages/client/src/styles/provider-themes.css` — 所有 provider CSS 变量
- `packages/client/src/styles/provider-animations.css` — 各 provider 动效 keyframes
- `packages/client/src/components/ProviderStyled/SendButton.tsx` — 条件渲染的发送按钮
- `packages/client/src/components/ProviderStyled/LoadingSpinner.tsx` — 条件渲染的加载动画

### 修改文件

- `packages/client/src/styles/index.css` — 添加基础 transition 和 provider 变量 fallback
- `packages/client/src/App.tsx` — 注入 ProviderThemeContext
- `packages/client/index.html` — 添加 Google Fonts 预加载链接
- `packages/client/src/components/ProviderBadge.tsx` — 更新颜色引用

## CSS 变量系统

每个 provider 定义 5 组变量：

```css
[data-provider="claude"] {
  /* 1. Color Palette */
  --bg-surface: #1C1917;
  --bg-secondary: #292524;
  --text-primary: #FAF9F6;
  --text-secondary: #A8A29E;
  --accent-primary: #E57035;
  --accent-secondary: #FDBA74;

  /* 2. Typography */
  --font-display: 'Source Serif 4', serif;
  --font-body: 'Source Sans 3', sans-serif;
  --font-mono: 'JetBrains Mono', monospace;

  /* 3. Spacing & Shape */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --shadow-card: 0 2px 8px rgba(229, 112, 53, 0.08);

  /* 4. Animation Tokens */
  --anim-duration-fast: 150ms;
  --anim-duration-normal: 300ms;
  --anim-easing: cubic-bezier(0.4, 0, 0.2, 1);

  /* 5. Provider-specific */
  --provider-gradient: linear-gradient(135deg, #292524 0%, #1C1917 100%);
  --provider-glow: 0 0 40px rgba(229, 112, 53, 0.15);
}
```

**共存规则**：`data-theme` 控制 light/dark（保留现有系统），`data-provider` 控制品牌色。当 `data-provider` 存在时，其变量覆盖默认变量；不存在时回退到现有默认主题。

## Provider 视觉定义

### 1. Claude — Anthropic 暖色纸质感

| 属性 | Light | Dark |
|------|-------|------|
| 背景 | `#F5F0EB` | `#1C1917` |
| 表面 | `#FFFFFF` | `#292524` |
| 主文字 | `#2D2926` | `#FAF9F6` |
| 次文字 | `#78716C` | `#A8A29E` |
| 强调色 | `#E57035` | `#E57035` |
| 字体 | Source Serif 4 (标题) + Source Sans 3 (正文) | 相同 |
| 圆角 | 10px | 相同 |
| 质感 | 微妙纸张纹理噪点 | 相同 |
| 动效 | 柔和淡入 300ms | 相同 |

**标志性元素**: 消息气泡左侧 3px 橙色竖线装饰。按钮 hover 时产生暖橙色光晕。

### 2. Codex — OpenAI 极简深炭

| 属性 | Light | Dark |
|------|-------|------|
| 背景 | `#FFFFFF` | `#1A1A1A` |
| 表面 | `#F7F7F8` | `#2D2D2D` |
| 主文字 | `#1A1A1A` | `#ECECF1` |
| 次文字 | `#6E6E80` | `#8E8EA0` |
| 强调色 | `#19C37D` | `#19C37D` |
| 字体 | Inter | 相同 |
| 圆角 | 8px | 相同 |
| 质感 | 绝对干净，无纹理 | 相同 |
| 动效 | 干脆弹入 250ms | 相同 |

**标志性元素**: 翡翠绿圆角矩形发送按钮，hover 时上浮 1px。绿色脉冲加载点。

### 3. Gemini — Google 多彩流光

| 属性 | Light | Dark |
|------|-------|------|
| 背景 | `#FFFFFF` | `#1F1F1F` |
| 表面 | `#F8F9FA` | `#303030` |
| 主文字 | `#1F1F1F` | `#FFFFFF` |
| 次文字 | `#5F6368` | `#9AA0A6` |
| 强调色 | 渐变色 `#4285F4 → #EA4335` | 相同 |
| 字体 | Roboto | 相同 |
| 圆角 | 16px (Material 3) | 相同 |
| 质感 | 卡片底层彩色阴影 | 相同 |
| 动效 | 流光 shimmer 400ms | 相同 |

**标志性元素**: 顶部 4 色 Google 渐变装饰条。多彩旋转粒子 loading。

### 4. OpenCode — 极简工具精密感

| 属性 | Light | Dark |
|------|-------|------|
| 背景 | `#FFFFFF` | `#0A0A0A` |
| 表面 | `#FAFAFA` | `#141414` |
| 主文字 | `#0A0A0A` | `#E5E5E5` |
| 次文字 | `#737373` | `#A3A3A3` |
| 强调色 | `#3B82F6` | `#60A5FA` |
| 字体 | Inter + JetBrains Mono | 相同 |
| 圆角 | 4px (锋利) | 相同 |
| 质感 | 1px 精确边框，无阴影 | 相同 |
| 动效 | 无动画或 100ms 瞬间 | 相同 |

**标志性元素**: 透明背景 + 1px 边框按钮。hover 时填充强调色。IDE 精密感。

### 5. 默认 — Yep Anywhere 品牌

| 属性 | Light | Dark |
|------|-------|------|
| 背景 | `#FAFAFA` | `#181818` |
| 表面 | `#FFFFFF` | `#1F1F1F` |
| 主文字 | `#1A1A1A` | `#E0E0E0` |
| 次文字 | `#737373` | `#B0B0B0` |
| 强调色 | `#10B981` | `#10B981` |
| 字体 | 系统字体 | 相同 |
| 圆角 | 8px | 相同 |
| 动效 | 温和过渡 200ms | 相同 |

## 切换机制

### 触发逻辑

在 `App.tsx` 的 `AppContent` 中：

```tsx
const activeProvider = useActiveProvider();

useEffect(() => {
  const root = document.documentElement;
  if (activeProvider) {
    root.setAttribute('data-provider', activeProvider);
  } else {
    root.removeAttribute('data-provider');
  }
}, [activeProvider]);
```

### 过渡动画

```css
:root {
  transition: background-color 400ms ease-out,
              color 400ms ease-out,
              border-color 400ms ease-out,
              box-shadow 400ms ease-out;
}

/* 首次加载禁止动画，避免闪烁 */
:root[data-first-load="true"] {
  transition: none !important;
}
```

### 动效类名注入

```tsx
const providerAnimClass = activeProvider ? `provider-anim-${activeProvider}` : '';

useEffect(() => {
  const html = document.documentElement;
  html.classList.remove('provider-anim-claude', 'provider-anim-codex',
                        'provider-anim-gemini', 'provider-anim-opencode');
  if (providerAnimClass) html.classList.add(providerAnimClass);
}, [activeProvider]);
```

## 微组件重写点

以下组件需要 provider 条件渲染：

| 组件 | 差异 |
|------|------|
| `LoadingSpinner` | Claude: 暖橙呼吸点 / Codex: 绿色脉冲 / Gemini: 多彩旋转 / OpenCode: 蓝色进度条 |
| `SendButton` | Claude: 圆角矩形+光晕 / Codex: 翡翠绿上浮 / Gemini: 渐变胶囊 / OpenCode: 直角边框 |
| `MessageBubble` | Claude: 左侧橙色边线 / Codex: 无装饰 / Gemini: 底部彩色渐变条 / OpenCode: 精确边框 |
| `ConnectionBar` | 各 provider 品牌色 |

## 字体加载

在 `index.html` 中预加载所有字体（约 200KB 压缩后）：

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@400;600;700&family=Source+Sans+3:wght@400;500;600&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
```

使用 `font-display: swap` 避免 FOIT。

## 兼容性

- 保留现有 `data-theme="auto|light|dark|verydark"` 系统
- 当 `data-provider` 存在时，provider 变量覆盖默认变量
- 当 `data-provider` 不存在时，完全回退到现有行为
- 不破坏任何现有组件

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 字体加载延迟导致布局偏移 | `font-display: swap` + 系统字体回退 |
| 颜色过渡在低端设备上卡顿 | 400ms 过渡时间适中，可通过 `prefers-reduced-motion` 禁用 |
| 5 套 CSS 变量增加文件体积 | 使用 CSS 变量而非重复规则，gzip 后增量极小 |
| Provider 推断错误（API 失败） | 失败时 graceful fallback 到默认品牌 |

## 验收标准

- [ ] 进入 Claude project 时，App 变为 Anthropic 暖色风格（暗色/亮色根据当前 theme 设置）
- [ ] 进入 Codex project 时，App 变为 OpenAI 墨绿风格
- [ ] 进入 Gemini project 时，App 变为 Google 多彩风格
- [ ] 进入 OpenCode project 时，App 变为极简工具风格
- [ ] 在 Projects 列表、Settings、Inbox 页面显示默认 Yep 品牌风格
- [ ] 切换 provider 时颜色平滑过渡（400ms）
- [ ] 各 provider 的 LoadingSpinner、SendButton 有独特视觉
- [ ] Light/dark 切换在每个 provider 下都正常工作
- [ ] `prefers-reduced-motion` 禁用所有动效
