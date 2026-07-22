# Mobile Safe Area 适配设计

## 问题

移动端（Android Tauri 应用）在异形屏（刘海/挖孔屏）上存在安全区域（safe area）未处理的问题：

- **顶部**：PageHeader（汉堡菜单 + 标题）紧贴屏幕顶部，被刘海/挖孔区域遮挡
- **底部**：页面滚动内容被底部手势条/导航条截断

## 现状

- `packages/client/index.html` 已设置 `viewport-fit=cover` ✓
- `BulkActionBar.tsx` 已使用 `pb-[max(var(--space-3),env(safe-area-inset-bottom,0px))]` ✓
- `ReloadBanner.tsx` 已使用 `top-[env(safe-area-inset-top,0px)]` ✓
- 其他关键组件均未处理安全区域 ✗

## 方案

### 全局 CSS 变量（`packages/client/src/styles/index.css`）

在 `:root` 中添加安全区域 CSS 变量：

```css
:root {
  --safe-area-top: env(safe-area-inset-top, 0px);
  --safe-area-bottom: env(safe-area-inset-bottom, 0px);
  --safe-area-left: env(safe-area-inset-left, 0px);
  --safe-area-right: env(safe-area-inset-right, 0px);
}
```

### 关键组件修复

| 文件 | 修复内容 |
|------|----------|
| `PageHeader.tsx` | header 添加 `pt-[env(safe-area-inset-top,0px)]` |
| `Sidebar.tsx` | 移动端 overlay sidebar 添加 `pt-[env(safe-area-inset-top,0px)]` |
| `Toast.tsx` | 底部 toast 位置调整为 `bottom-[calc(100px+env(safe-area-inset-bottom,0px))]` |
| `FilterDropdown.tsx` | 移动端底部弹窗添加 `pb-[env(safe-area-inset-bottom,0px)]` |
| `ModeSelector.tsx` | 移动端底部弹窗添加 `pb-[env(safe-area-inset-bottom,0px)]` |
| `ProjectSelector.tsx` | 移动端底部弹窗添加 `pb-[env(safe-area-inset-bottom,0px)]` |
| `RollbackPanel.tsx` | 移动端底部弹窗添加 `pb-[env(safe-area-inset-bottom,0px)]` |
| `AgentsPage.tsx` | 检查并确保主体内容底部有 safe area padding |
| `SessionPage.tsx` | 检查并确保主体内容底部有 safe area padding |

### 验证方式

1. 构建 mobile APK：`cd packages/mobile && pnpm tauri android build`
2. 在 Android Emulator（Pixel 系列有刘海屏模拟）或小米真机上安装
3. 检查：
   - 顶部 PageHeader 是否与刘海保持安全距离
   - 底部滚动内容是否不被手势条遮挡
   - 底部弹窗（如 ModeSelector）是否正确上移
