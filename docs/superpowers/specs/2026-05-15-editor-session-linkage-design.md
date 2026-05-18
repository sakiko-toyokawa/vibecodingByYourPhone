# Editor-Session Bidirectional Linkage

## Context

Yep Anywhere has a solid code editor (`CodeEditorPage`) and a session-aware editor (`SessionEditorPage` with file tree + editor + chat sidebar). However, the editor and AI session are still islands — users must copy-paste file paths and code snippets between them. This spec bridges the two directions:

1. **Session → Editor**: Click a file path in a message or tool call to open it in the editor
2. **Editor → Session**: Send selected code from the editor to the session chat

## Goals

- Eliminate copy-paste of file paths between session and editor
- Let users inspect/modify files that the agent touched without leaving the app
- Let users ask the AI about specific code selections without typing the context manually

## Non-Goals

- Independent `CodeEditorPage` remains unchanged (no session association)
- No new backend APIs (reuse existing message sending)
- No diff viewer / code review (that is the separate "Diff Viewer + Line Comments" feature, tracked as TODO)
- No auto-detection of file paths in free-form message text (only enhance existing `FilePathLink` and tool renderers)

## Architecture

```
SessionPage
  ├── FilePathLink ──► SessionEditorPage (or CodeEditorPage if no session context)
  ├── ReadRenderer ──► "Open in Editor" button
  └── EditRenderer ──► "Open in Editor" button

SessionEditorPage
  ├── FileTree (existing)
  ├── CodeEditor (existing)
  ├── EditorToolbar ──► NEW: "Ask AI" button when text selected
  │                     └── opens mini input → sends to session chat
  └── SessionPageContent (existing chat sidebar)
```

## Detailed Design

### 1. Session → Editor

#### 1.1 FilePathLink Enhancement

**File**: `packages/client/src/components/FilePathLink.tsx`

Current behavior: click opens `FileViewer` modal; middle-click opens `FilePage`.

Add to the modal footer:
- "Open in Editor" button
- If `sessionId` is available in context (e.g. passed as prop or from route params), navigate to `/projects/{projectId}/sessions/{sessionId}/editor?path={filePath}`
- If no `sessionId`, navigate to `/projects/{projectId}/editor?path={filePath}`

The `FilePathLink` already receives `projectId`. We need to optionally accept `sessionId`.

#### 1.2 ReadRenderer Enhancement

**File**: `packages/client/src/components/renderers/tools/ReadRenderer.tsx`

In `TextFileResult`, add a secondary "Open in Editor" icon button next to the existing "click to view" button. Navigation target: same logic as above (SessionEditorPage if in a session context, else CodeEditorPage).

The tool renderer context (`ToolRendererContext`) may need to expose the current `sessionId`.

#### 1.3 EditRenderer Enhancement

**File**: `packages/client/src/components/renderers/tools/EditRenderer.tsx`

In `EditInteractiveSummary` and `EditCollapsedPreview`, add an "Open in Editor" icon button next to the filename. The file path is already extracted via `getEditFilePath()`.

#### 1.4 FilePage Enhancement

**File**: `packages/client/src/pages/FilePage.tsx`

Add an "Open in Editor" button in the page header toolbar.

### 2. Editor → Session

#### 2.1 EditorToolbar Enhancement

**File**: `packages/client/src/components/editor/EditorToolbar.tsx`

Current: shows "AI Edit" button when text is selected.

Add:
- **"Ask AI" button** next to "AI Edit". Click opens a compact bottom input bar (similar to `MessageInput` but inline in the toolbar area).
- The input is pre-filled with the selected code as a fenced code block.
- User can type a question above/below the code block.
- Press Enter (or click Send) to send the message.

#### 2.2 Message Sending from Editor

**File**: `packages/client/src/pages/SessionEditorPage.tsx`

`SessionEditorPage` already has `sessionId`. Reuse the existing message sending mechanism:

Option A: Use the same WebSocket/API path that `SessionPageContent` uses internally.
Option B: Expose a `sendMessage` callback from `SessionPageContent` via React context or prop drilling.

**Recommended**: Option A — call `api.sendMessage(projectId, sessionId, messageText)` directly from `SessionEditorPage`. The `SessionPageContent` will receive the new message via its existing WebSocket subscription and display it.

#### 2.3 Save → "Review Changes" (Optional Enhancement)

After `handleSave` succeeds in `SessionEditorPage`, temporarily show a "Review Changes" button in `EditorToolbar` (e.g. for 5 seconds or until dismissed).

Clicking it:
1. Calls a backend endpoint to get `git diff` for the file (reuse or extend `packages/server/src/routes/git-status.ts`)
2. Sends a message to the session: "I updated `{filePath}`. Here's the diff:\n\n```diff\n{diff}\n```\nPlease review."

**Scope decision**: This is a nice-to-have. If complexity exceeds estimate, defer to a follow-up.

## Files to Modify

| File | Change |
|------|--------|
| `packages/client/src/components/FilePathLink.tsx` | Add "Open in Editor" to modal; accept optional `sessionId` |
| `packages/client/src/components/renderers/tools/ReadRenderer.tsx` | Add "Open in Editor" button to `TextFileResult` |
| `packages/client/src/components/renderers/tools/EditRenderer.tsx` | Add "Open in Editor" button to `EditInteractiveSummary` and `EditCollapsedPreview` |
| `packages/client/src/pages/FilePage.tsx` | Add "Open in Editor" button to header |
| `packages/client/src/components/editor/EditorToolbar.tsx` | Add "Ask AI" button + mini input UI |
| `packages/client/src/pages/SessionEditorPage.tsx` | Wire up message sending from toolbar; handle "Review Changes" |
| `packages/client/src/api/client.ts` | Add `sendMessage` if not already present |

## Error Handling

- If navigation target is invalid (missing `projectId`), show toast and do nothing
- If message sending fails, show error toast in `SessionEditorPage`
- If `sessionId` is not available (e.g. `CodeEditorPage`), "Ask AI" button is hidden

## Testing

1. **Manual**: From a session, click a `FilePathLink` → verify it opens `SessionEditorPage` with the file loaded and chat sidebar visible
2. **Manual**: In `SessionEditorPage`, select code, click "Ask AI", type a question, verify the message appears in the chat sidebar
3. **Unit**: `FilePathLink` modal renders "Open in Editor" button when expected

## Dependencies

- Reuses all existing editor and session infrastructure
- No new backend routes (unless "Review Changes" is implemented)
