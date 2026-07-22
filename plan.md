# Plan: Session Editor Mode (VS Code-like Layout)

## Context

现有系统有两个独立界面：
- **SessionPage** (`/projects/:projectId/sessions/:sessionId`) — AI 对话界面
- **CodeEditorPage** (`/projects/:projectId/editor`) — 代码编辑器（文件树 + 编辑器 + AI Edit 弹窗）

用户希望在 Session 对话中直接编辑代码，形成"编辑模式"：左侧文件树、中间代码编辑、右侧 AI 对话，类似 VS Code 布局。

## Design Decisions

- **架构**：方案 B  —  新路由组合现有组件，零污染 SessionPage
- **入口**：SessionPage 头部增加"Editor Mode"按钮，跳转到编辑模式路由
- **移动端**：对话区域变为底部 Sheet（类似现有 AiEditPanel 的移动端样式），文件树为可收缩侧边栏

## Implementation

### 1. New Route

新增路由 `/projects/:projectId/sessions/:sessionId/editor`，渲染 `SessionEditorPage`。

需要同步更新：
- `AppRoutes.tsx`
- `remote-main.tsx`（根据项目注释，新增路由需同步）

### 2. New Component: `SessionEditorPage`

布局逻辑：

**Desktop (isWideScreen)**:
```
┌───────────┬──────────────┬──────────────┐
│ FileTree  │ CodeEditor   │ SessionPage  │
│(可收缩)   │              │  Content     │
│ 240px     │   flex-1     │   flex-1     │
└───────────┴──────────────┴──────────────┘
```

**Mobile**:
- 文件树：默认隐藏，通过按钮触发侧边栏滑出
- 编辑器：占据主区域
- 对话：底部 Sheet，可拖拽展开/收起（复用现有底部 Sheet 模式）

**组件复用**：
- `FileTree` — 已有，懒加载目录树
- `CodeEditor` — 已有，CodeMirror 6 编辑器
- `SessionPageContent` — 已有，完整对话功能（消息列表、输入框、工具审批、模型切换等）

### 3. State & Data Flow

- `SessionEditorPage` 管理编辑器状态：
  - `selectedFilePath` — 当前选中文件
  - `editorContent` / `savedContent` / `dirty` — 编辑器内容状态
  - `fileTreeCollapsed` — 文件树展开/收起（桌面端）
  - `chatSheetOpen` — 移动端对话 Sheet 开关

- 文件加载/保存复用现有 `api.getFile` / `api.writeProjectFile`
- 草稿持久化复用 CodeEditor 内置的 localStorage 机制

### 4. Entry Point

在 `SessionPage` 的头部工具栏（靠近 SplitViewButton/ThemeToggle 区域）增加一个编辑模式入口按钮：

```tsx
<Link
  to={`${basePath}/projects/${projectId}/sessions/${sessionId}/editor`}
  className="..."
>
  Editor
</Link>
```

从编辑模式返回：点击 SessionPageContent 中已有的项目 breadcrumb 或新增返回按钮。

### 5. Mobile Adaptation

**文件树侧边栏**：
- 类似现有 CodeEditorPage 中的移动端文件树实现（底部 sheet）
- 在编辑器工具栏增加"Files"按钮触发

**对话底部 Sheet**：
- 复用 AiEditPanel 的移动端底部 Sheet 模式
- 但内容是完整的 SessionPageContent（需要包装为无头部版本或隐藏头部）
- 拖拽把手展开/收起，类似现有实现

### 6. Key Files to Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/AppRoutes.tsx` | Edit | 新增 `/projects/:projectId/sessions/:sessionId/editor` 路由 |
| `packages/client/src/remote-main.tsx` | Edit | 同步新增路由 |
| `packages/client/src/pages/SessionEditorPage.tsx` | Create | 新页面，三栏布局容器 |
| `packages/client/src/pages/SessionPage.tsx` | Edit | 头部增加 Editor Mode 入口按钮 |
| `packages/client/src/components/editor/EditorToolbar.tsx` | Edit | 增加移动端 Files 按钮、返回按钮 |

### 7. Verification

1. 从 SessionPage 点击 Editor 按钮，正确跳转到编辑模式路由
2. 桌面端显示三栏布局：文件树、代码编辑器、对话
3. 文件树可以点击展开/折叠目录，点击文件在编辑器中打开
4. 编辑器支持语法高亮、保存（Ctrl+S）、草稿持久化
5. 右侧对话功能完整：发送消息、工具审批、模型切换、session 状态
6. 移动端：文件树通过按钮触发侧边栏，对话为底部可展开 Sheet
7. `pnpm lint && pnpm typecheck` 通过
