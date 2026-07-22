# File Upload Implementation Plan

## Overview

Add file upload capability to the message input panel. Users can attach files which are streamed to the server via WebSocket (to avoid OOM on large files), stored in the session's upload directory, and referenced by absolute path in messages to the agent.

**Key design goals:**
- **No size limits** - Agent decides how to handle large files (resize images, write scripts to analyze, etc.)
- **Streaming upload** - WebSocket chunked transfer prevents server OOM
- **Agent-friendly** - Files stored on filesystem with absolute paths the agent can access via Read tool, Bash, etc.

## Architecture

### File Storage
- **Location**: `~/.claude-anywhere/uploads/<encoded-path>/<session-id>/`
- Separate from `~/.claude` metadata directory
- Files stored per-session for isolation and easy cleanup
- Agent accesses via absolute filesystem paths
- UUID prefix on filenames prevents collisions

### Upload Protocol (WebSocket)

```
Client → Server: { type: "start", name: "big.csv", size: 50000000, mimeType: "text/csv" }
Client → Server: <binary chunk 1>  (e.g., 64KB)
Client → Server: <binary chunk 2>
...
Server → Client: { type: "progress", bytesReceived: 1048576 }  // periodic acks
...
Client → Server: { type: "end" }
Server → Client: { type: "complete", file: { id, name, path, size, mimeType } }
Server → Client: { type: "error", message: "..." }  // on failure
```

Server streams chunks directly to disk via `fs.createWriteStream()` - never buffers entire file in memory.

### Message Flow
1. User clicks attach button → file picker opens
2. File selected → WebSocket opened, chunks streamed to server
3. Progress displayed in UI during upload
4. On completion → attachment chip appears below textarea
5. User sends message → attachment paths included
6. Agent sees: `"User uploaded files:\n- filename (size): /absolute/path"`

## Codebase Context

### Key Files to Understand

**Server:**
- [app.ts](packages/server/src/app.ts) - Hono app setup, route mounting
- [routes/sessions.ts](packages/server/src/routes/sessions.ts) - Session REST endpoints, message handling
- [routes/stream.ts](packages/server/src/routes/stream.ts) - SSE streaming pattern (reference for WebSocket)
- [sdk/messageQueue.ts](packages/server/src/sdk/messageQueue.ts) - Converts UserMessage to SDK format, where attachment text formatting goes
- [sdk/types.ts](packages/server/src/sdk/types.ts) - `UserMessage` interface (has `images`, `documents` fields already)
- [projects/paths.ts](packages/server/src/projects/paths.ts) - Path utilities, `CLAUDE_PROJECTS_DIR`, session directory patterns
- [supervisor/Supervisor.ts](packages/server/src/supervisor/Supervisor.ts) - Manages processes, has `getProcess(sessionId)` to look up session info

**Client:**
- [components/MessageInput.tsx](packages/client/src/components/MessageInput.tsx) - The input component to modify
- [pages/SessionPage.tsx](packages/client/src/pages/SessionPage.tsx) - Parent component, handles `onSend`, manages session state
- [api/client.ts](packages/client/src/api/client.ts) - API client with `fetchJSON` helper
- [styles/index.css](packages/client/src/styles/index.css) - Global styles, follows dark theme with Claude orange accents

**Shared:**
- [types.ts](packages/shared/src/types.ts) - Shared types between client/server

### Existing Patterns

**WebSocket in Hono:** Hono supports WebSocket via `app.get('/path', upgradeWebSocket(...))`. See Hono docs.

**File paths:** Use `join()` from `node:path`. Session directories found via project scanning or Supervisor lookup.

**Message format:** `UserMessage` in `sdk/types.ts` already has `images?: string[]` and `documents?: string[]`. The `toSDKMessage()` function in `messageQueue.ts` converts these - we'll add `attachments` handling there.

---

## Phase 1: Server-Side Streaming Upload

**Goal:** WebSocket endpoint that streams file chunks to disk, returns metadata. Fully tested.

### 1.1 Add Shared Types

**File:** `packages/shared/src/types.ts`

```typescript
export interface UploadedFile {
  id: string;        // UUID
  name: string;      // Original filename
  path: string;      // Absolute path on server
  size: number;      // Bytes
  mimeType: string;  // MIME type
}

// WebSocket message types
export type UploadMessage =
  | { type: "start"; name: string; size: number; mimeType: string }
  | { type: "end" }
  | { type: "cancel" };

export type UploadResponse =
  | { type: "progress"; bytesReceived: number }
  | { type: "complete"; file: UploadedFile }
  | { type: "error"; message: string };
```

### 1.2 Create Upload Manager

**File:** `packages/server/src/uploads/manager.ts` [NEW]

```typescript
import { createWriteStream, mkdir, readdir, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { UploadedFile } from "@anthropic-ai/claude-anywhere-shared";

export class UploadManager {
  /**
   * Get upload directory for a session, creating if needed.
   */
  async getUploadDir(sessionDir: string, sessionId: string): Promise<string> {
    const dir = join(sessionDir, sessionId, "uploads");
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Create a write stream for a new upload.
   * Returns the stream and file metadata (path not yet final until complete).
   */
  createUpload(
    uploadDir: string,
    originalName: string,
    mimeType: string
  ): { stream: WriteStream; fileId: string; filePath: string } {
    const fileId = randomUUID();
    const safeName = this.sanitizeFilename(originalName);
    const filePath = join(uploadDir, `${fileId}-${safeName}`);
    const stream = createWriteStream(filePath);
    return { stream, fileId, filePath };
  }

  /**
   * Finalize upload, return metadata.
   */
  async finalizeUpload(
    fileId: string,
    filePath: string,
    originalName: string,
    mimeType: string
  ): Promise<UploadedFile> {
    const stats = await stat(filePath);
    return {
      id: fileId,
      name: originalName,
      path: filePath,
      size: stats.size,
      mimeType,
    };
  }

  /**
   * List uploaded files for a session.
   */
  async listFiles(uploadDir: string): Promise<UploadedFile[]> {
    // Read directory, parse filenames, stat each file
    // Return array of UploadedFile
  }

  /**
   * Delete an uploaded file.
   */
  async deleteFile(uploadDir: string, fileId: string): Promise<void> {
    // Find file by ID prefix, unlink
  }

  /**
   * Remove dangerous characters from filename.
   */
  private sanitizeFilename(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
  }
}

export const uploadManager = new UploadManager();
```

### 1.3 Create WebSocket Upload Route

**File:** `packages/server/src/routes/uploads.ts` [NEW]

```typescript
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { uploadManager } from "../uploads/manager.js";
import { supervisor } from "../supervisor/Supervisor.js";
import type { UploadMessage, UploadResponse } from "@anthropic-ai/claude-anywhere-shared";

const app = new Hono();
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

// WebSocket upload endpoint
// GET /api/projects/:projectId/sessions/:sessionId/upload/ws (upgrades to WebSocket)
app.get(
  "/projects/:projectId/sessions/:sessionId/upload/ws",
  upgradeWebSocket((c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    let uploadDir: string;
    let stream: WriteStream | null = null;
    let fileId: string;
    let filePath: string;
    let originalName: string;
    let mimeType: string;
    let bytesReceived = 0;

    return {
      async onOpen(evt, ws) {
        // Validate projectId and get upload directory
        // Upload dir: ~/.claude-anywhere/uploads/<projectId>/<sessionId>/
      },

      async onMessage(evt, ws) {
        const data = evt.data;

        // Binary data = file chunk
        if (data instanceof ArrayBuffer || Buffer.isBuffer(data)) {
          if (!stream) {
            ws.send(JSON.stringify({ type: "error", message: "No upload in progress" }));
            return;
          }
          const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
          stream.write(chunk);
          bytesReceived += chunk.length;

          // Send progress every 1MB
          if (bytesReceived % (1024 * 1024) < chunk.length) {
            ws.send(JSON.stringify({ type: "progress", bytesReceived }));
          }
          return;
        }

        // JSON message
        const msg: UploadMessage = JSON.parse(data.toString());

        if (msg.type === "start") {
          originalName = msg.name;
          mimeType = msg.mimeType;
          const upload = uploadManager.createUpload(uploadDir, originalName, mimeType);
          stream = upload.stream;
          fileId = upload.fileId;
          filePath = upload.filePath;
          bytesReceived = 0;
        }

        else if (msg.type === "end") {
          if (stream) {
            stream.end();
            const file = await uploadManager.finalizeUpload(fileId, filePath, originalName, mimeType);
            ws.send(JSON.stringify({ type: "complete", file }));
          }
        }

        else if (msg.type === "cancel") {
          if (stream) {
            stream.destroy();
            // Clean up partial file
            await unlink(filePath).catch(() => {});
          }
          ws.close();
        }
      },

      onClose() {
        if (stream) {
          stream.destroy();
        }
      },

      onError(evt) {
        console.error("Upload WebSocket error:", evt);
        if (stream) {
          stream.destroy();
        }
      },
    };
  })
);

// REST endpoints for listing/deleting (optional, can add later)
// GET /api/projects/:projectId/sessions/:sessionId/uploads
// DELETE /api/projects/:projectId/sessions/:sessionId/uploads/:fileId

export default app;
```

### 1.4 Mount Routes

**File:** `packages/server/src/app.ts`

Add import and mount:
```typescript
import uploadRoutes from "./routes/uploads.js";
// ... after other routes
app.route("/api", uploadRoutes);
```

### 1.5 Session Directory Lookup

**Implemented:** Include `projectId` in the upload URL (`/api/projects/:projectId/sessions/:sessionId/upload/ws`). The client already has `projectId` available, and the server uses it to construct the upload directory path: `~/.claude-anywhere/uploads/<projectId>/<sessionId>/`.

### 1.6 Unit Tests

**File:** `packages/server/test/uploads/manager.test.ts` [NEW]

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { uploadManager } from "../../src/uploads/manager.js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("UploadManager", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "upload-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("creates upload directory", async () => {
    const dir = await uploadManager.getUploadDir(tempDir, "session-123");
    expect(dir).toContain("session-123/uploads");
  });

  it("streams file to disk", async () => {
    const dir = await uploadManager.getUploadDir(tempDir, "session-123");
    const { stream, fileId, filePath } = uploadManager.createUpload(dir, "test.txt", "text/plain");

    stream.write(Buffer.from("hello "));
    stream.write(Buffer.from("world"));
    stream.end();

    await new Promise(resolve => stream.on("finish", resolve));

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("hello world");
  });

  it("sanitizes dangerous filenames", async () => {
    const dir = await uploadManager.getUploadDir(tempDir, "session-123");
    const { filePath } = uploadManager.createUpload(dir, "../../../etc/passwd", "text/plain");

    expect(filePath).not.toContain("..");
    expect(filePath).toContain("_etc_passwd");
  });
});
```

**File:** `packages/server/test/uploads/websocket.test.ts` [NEW]

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import { app } from "../../src/app.js";
// ... test WebSocket upload flow end-to-end
// Send start message, binary chunks, end message
// Verify file exists on disk with correct content
```

---

## Phase 2: Client Upload Logic

**Goal:** Client-side upload function that chunks files and sends via WebSocket. Testable without browser APIs.

### 2.1 Core Upload Function

**File:** `packages/client/src/api/upload.ts` [NEW]

```typescript
import type { UploadedFile, UploadMessage, UploadResponse } from "@anthropic-ai/claude-anywhere-shared";

const CHUNK_SIZE = 64 * 1024; // 64KB chunks

export interface UploadProgress {
  bytesUploaded: number;
  totalBytes: number;
  percent: number;
}

export interface UploadOptions {
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

/**
 * Upload file chunks over WebSocket.
 * Accepts an async iterable of chunks for testability.
 */
export async function uploadChunks(
  ws: WebSocket,
  name: string,
  size: number,
  mimeType: string,
  chunks: AsyncIterable<Uint8Array>,
  options?: UploadOptions
): Promise<UploadedFile> {
  return new Promise((resolve, reject) => {
    let bytesUploaded = 0;

    ws.onmessage = (event) => {
      const msg: UploadResponse = JSON.parse(event.data);
      if (msg.type === "complete") {
        resolve(msg.file);
      } else if (msg.type === "error") {
        reject(new Error(msg.message));
      } else if (msg.type === "progress") {
        // Server confirmed receipt
      }
    };

    ws.onerror = (err) => reject(err);
    ws.onclose = () => reject(new Error("Connection closed"));

    options?.signal?.addEventListener("abort", () => {
      ws.send(JSON.stringify({ type: "cancel" }));
      ws.close();
      reject(new Error("Upload cancelled"));
    });

    // Start upload
    ws.send(JSON.stringify({ type: "start", name, size, mimeType }));

    // Send chunks
    (async () => {
      for await (const chunk of chunks) {
        ws.send(chunk);
        bytesUploaded += chunk.length;
        options?.onProgress?.({
          bytesUploaded,
          totalBytes: size,
          percent: Math.round((bytesUploaded / size) * 100),
        });
      }
      ws.send(JSON.stringify({ type: "end" }));
    })().catch(reject);
  });
}

/**
 * Create async chunk iterator from a File (browser API).
 * Separated for testability - can mock this in tests.
 */
export async function* fileToChunks(file: File): AsyncGenerator<Uint8Array> {
  let offset = 0;
  while (offset < file.size) {
    const slice = file.slice(offset, offset + CHUNK_SIZE);
    const buffer = await slice.arrayBuffer();
    yield new Uint8Array(buffer);
    offset += CHUNK_SIZE;
  }
}

/**
 * High-level upload function for browser use.
 */
export async function uploadFile(
  projectId: string,
  sessionId: string,
  file: File,
  options?: UploadOptions
): Promise<UploadedFile> {
  const wsUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/projects/${projectId}/sessions/${sessionId}/upload/ws`;
  const ws = new WebSocket(wsUrl);

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = reject;
  });

  try {
    return await uploadChunks(
      ws,
      file.name,
      file.size,
      file.type || "application/octet-stream",
      fileToChunks(file),
      options
    );
  } finally {
    ws.close();
  }
}
```

### 2.2 Unit Tests (No Browser APIs)

**File:** `packages/client/src/api/upload.test.ts` [NEW]

```typescript
import { describe, it, expect, vi } from "vitest";
import { uploadChunks } from "./upload.js";

describe("uploadChunks", () => {
  it("sends start, chunks, and end messages", async () => {
    const messages: any[] = [];
    const mockWs = {
      send: vi.fn((data) => messages.push(data)),
      onmessage: null as any,
      onerror: null as any,
      onclose: null as any,
      close: vi.fn(),
    };

    // Simulate server responses
    setTimeout(() => {
      mockWs.onmessage?.({ data: JSON.stringify({ type: "progress", bytesReceived: 100 }) });
    }, 10);
    setTimeout(() => {
      mockWs.onmessage?.({ data: JSON.stringify({
        type: "complete",
        file: { id: "123", name: "test.txt", path: "/tmp/test.txt", size: 100, mimeType: "text/plain" }
      })});
    }, 20);

    // Mock chunks
    async function* mockChunks() {
      yield new Uint8Array([1, 2, 3]);
      yield new Uint8Array([4, 5, 6]);
    }

    const result = await uploadChunks(
      mockWs as any,
      "test.txt",
      100,
      "text/plain",
      mockChunks()
    );

    expect(messages[0]).toBe(JSON.stringify({ type: "start", name: "test.txt", size: 100, mimeType: "text/plain" }));
    expect(messages[1]).toBeInstanceOf(Uint8Array);
    expect(messages[2]).toBeInstanceOf(Uint8Array);
    expect(messages[3]).toBe(JSON.stringify({ type: "end" }));
    expect(result.id).toBe("123");
  });
});
```

### 2.3 Add to API Client

**File:** `packages/client/src/api/client.ts`

```typescript
// Add export
export { uploadFile } from "./upload.js";
export type { UploadProgress, UploadOptions } from "./upload.js";
```

---

## Phase 3: UI Integration

**Goal:** Attach button in MessageInput, file chips with progress, wire into message send.

### 3.1 Update MessageInput Props

**File:** `packages/client/src/components/MessageInput.tsx`

```typescript
interface Props {
  // ... existing props
  sessionId?: string;  // Required for uploads
  attachments?: UploadedFile[];
  onAttach?: (files: File[]) => void;  // Triggers upload in parent
  onRemoveAttachment?: (id: string) => void;
  uploadProgress?: Map<string, UploadProgress>;  // fileId -> progress
}
```

### 3.2 Add UI Elements

```tsx
// Hidden file input
const fileInputRef = useRef<HTMLInputElement>(null);

// In toolbar, between mode button and actions:
<button
  type="button"
  className="attach-button"
  onClick={() => fileInputRef.current?.click()}
  disabled={!sessionId}
  title={sessionId ? "Attach files" : "Send a message first to enable attachments"}
>
  📎
  {attachments?.length ? <span className="attach-count">{attachments.length}</span> : null}
</button>

<input
  ref={fileInputRef}
  type="file"
  multiple
  style={{ display: "none" }}
  onChange={(e) => {
    if (e.target.files?.length) {
      onAttach?.(Array.from(e.target.files));
      e.target.value = "";  // Reset for re-selection
    }
  }}
/>

// Below textarea, show attachment chips:
{(attachments?.length || uploadProgress?.size) && (
  <div className="attachment-list">
    {attachments?.map(file => (
      <div key={file.id} className="attachment-chip">
        <span className="name" title={file.path}>{file.name}</span>
        <span className="size">{formatSize(file.size)}</span>
        <button className="remove" onClick={() => onRemoveAttachment?.(file.id)}>×</button>
      </div>
    ))}
    {/* Show uploading files */}
    {Array.from(uploadProgress?.entries() || []).map(([id, progress]) => (
      <div key={id} className="attachment-chip uploading">
        <span className="name">Uploading...</span>
        <span className="progress">{progress.percent}%</span>
      </div>
    ))}
  </div>
)}
```

### 3.3 Update SessionPage

**File:** `packages/client/src/pages/SessionPage.tsx`

```typescript
const [attachments, setAttachments] = useState<UploadedFile[]>([]);
const [uploadProgress, setUploadProgress] = useState<Map<string, UploadProgress>>(new Map());

const handleAttach = async (files: File[]) => {
  for (const file of files) {
    const tempId = crypto.randomUUID();
    setUploadProgress(prev => new Map(prev).set(tempId, { bytesUploaded: 0, totalBytes: file.size, percent: 0 }));

    try {
      const uploaded = await uploadFile(sessionId, file, {
        onProgress: (p) => setUploadProgress(prev => new Map(prev).set(tempId, p)),
      });
      setAttachments(prev => [...prev, uploaded]);
    } catch (err) {
      // Show error toast
    } finally {
      setUploadProgress(prev => {
        const next = new Map(prev);
        next.delete(tempId);
        return next;
      });
    }
  }
};

const handleRemoveAttachment = (id: string) => {
  setAttachments(prev => prev.filter(a => a.id !== id));
  // Optionally call DELETE endpoint
};

// In handleSend, include attachments:
const handleSend = async (text: string) => {
  const attachmentPaths = attachments.map(a => a.path);
  // ... send message with attachments
  setAttachments([]);  // Clear after send
};
```

### 3.4 Update Message Sending

**Files to update:**
- `packages/client/src/api/client.ts` - Add `attachments` param to `queueMessage`, `resumeSession`, `startSession`
- `packages/server/src/routes/sessions.ts` - Accept `attachments` in request body
- `packages/server/src/sdk/types.ts` - Add `attachments?: UploadedFile[]` to `UserMessage`
- `packages/server/src/sdk/messageQueue.ts` - Format attachment info in `toSDKMessage()`

### 3.5 Format Attachments for Agent

**File:** `packages/server/src/sdk/messageQueue.ts`

```typescript
private toSDKMessage(msg: UserMessage): SDKUserMessage {
  let text = msg.text;

  // Append attachment info for agent
  if (msg.attachments?.length) {
    const attachmentLines = msg.attachments.map(f =>
      `- ${f.name} (${this.formatSize(f.size)}, ${f.mimeType}): ${f.path}`
    );
    text += `\n\nUser uploaded files:\n${attachmentLines.join("\n")}`;
  }

  // ... rest of method
}

private formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
```

### 3.6 Styles

**File:** `packages/client/src/styles/index.css`

```css
.attach-button {
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 4px 8px;
  cursor: pointer;
  position: relative;
}

.attach-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.attach-button .attach-count {
  position: absolute;
  top: -6px;
  right: -6px;
  background: var(--claude-orange);
  color: white;
  border-radius: 50%;
  font-size: 10px;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.attachment-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 0;
}

.attachment-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--surface-secondary);
  border-radius: 16px;
  padding: 4px 8px 4px 12px;
  font-size: 12px;
}

.attachment-chip .name {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-chip .size {
  color: var(--text-muted);
}

.attachment-chip .remove {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 50%;
}

.attachment-chip .remove:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.attachment-chip.uploading {
  opacity: 0.7;
}

.attachment-chip .progress {
  color: var(--claude-orange);
}
```

---

## Phase 4: E2E Tests

**Goal:** Playwright tests covering full upload flow, including large files.

### 4.1 Test File

**File:** `packages/client/e2e/upload.spec.ts` [NEW]

```typescript
import { test, expect } from "@playwright/test";

test.describe("File Upload", () => {
  test("uploads a small file and sends message", async ({ page }) => {
    await page.goto("/");
    // Create or navigate to a session first
    await page.fill("textarea", "Hello");
    await page.click("button:has-text('Send')");
    await page.waitForSelector(".message-list .user");

    // Now attach button should be enabled
    const attachButton = page.locator(".attach-button");
    await expect(attachButton).not.toBeDisabled();

    // Upload a file
    await page.setInputFiles("input[type='file']", {
      name: "test.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Hello from uploaded file!"),
    });

    // Wait for upload to complete
    await expect(page.locator(".attachment-chip")).toBeVisible();
    await expect(page.locator(".attachment-chip .name")).toHaveText("test.txt");

    // Send message with attachment
    await page.fill("textarea", "Please read the attached file");
    await page.click("button:has-text('Send')");

    // Verify attachment was cleared
    await expect(page.locator(".attachment-chip")).not.toBeVisible();
  });

  test("handles large file upload with progress", async ({ page }) => {
    // Create 10MB buffer
    const largeBuffer = Buffer.alloc(10 * 1024 * 1024, "x");

    await page.goto("/session/existing-session-id");
    await page.setInputFiles("input[type='file']", {
      name: "large.bin",
      mimeType: "application/octet-stream",
      buffer: largeBuffer,
    });

    // Should show progress
    await expect(page.locator(".attachment-chip.uploading")).toBeVisible();

    // Wait for completion
    await expect(page.locator(".attachment-chip:not(.uploading)")).toBeVisible({ timeout: 30000 });
  });

  test("can remove attachment before sending", async ({ page }) => {
    // ... test remove button
  });

  test("attach button disabled before session exists", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".attach-button")).toBeDisabled();
  });
});
```

---

## Files Summary

### New Files
| File | Description |
|------|-------------|
| `packages/shared/src/types.ts` | Add `UploadedFile`, `UploadMessage`, `UploadResponse` types |
| `packages/server/src/uploads/manager.ts` | File storage, streaming, cleanup |
| `packages/server/src/routes/uploads.ts` | WebSocket upload endpoint |
| `packages/server/test/uploads/manager.test.ts` | Unit tests for UploadManager |
| `packages/server/test/uploads/websocket.test.ts` | Integration tests for WebSocket endpoint |
| `packages/client/src/api/upload.ts` | Client upload logic, chunking |
| `packages/client/src/api/upload.test.ts` | Unit tests (no browser APIs) |
| `packages/client/e2e/upload.spec.ts` | Playwright E2E tests |

### Modified Files
| File | Change |
|------|--------|
| `packages/server/src/app.ts` | Mount upload routes |
| `packages/server/src/sdk/types.ts` | Add `attachments` to `UserMessage` |
| `packages/server/src/sdk/messageQueue.ts` | Format attachment text for agent |
| `packages/server/src/routes/sessions.ts` | Accept `attachments` in request bodies |
| `packages/client/src/api/client.ts` | Export upload function, add attachments to API calls |
| `packages/client/src/components/MessageInput.tsx` | Add attach button, chips, progress |
| `packages/client/src/pages/SessionPage.tsx` | Wire up upload state and handlers |
| `packages/client/src/styles/index.css` | Attachment styling |

---

## Edge Cases & Future Work

1. **New session (no sessionId)**: Attach button disabled until session exists
2. **Upload errors**: Show toast, remove failed upload from progress
3. **Connection drop mid-upload**: Clean up partial file on server
4. **Cancel upload**: Send cancel message, close WebSocket
5. **Duplicate filenames**: UUID prefix handles this
6. **Session cleanup**: Delete upload directory when session deleted (future)
7. **Resume interrupted upload**: Track offset, resume from last byte (future)

---

## Testing Checklist

After each phase:
```bash
pnpm typecheck  # Type checking
pnpm lint       # Biome linter
pnpm test       # Unit tests
pnpm test:e2e   # E2E tests (Phase 4)
```

Manual testing:
- [ ] Upload small text file
- [ ] Upload large file (100MB+), verify no OOM
- [ ] Upload multiple files
- [ ] Remove attachment before send
- [ ] Send message with attachments
- [ ] Verify agent sees file paths
- [ ] Verify agent can read uploaded files
