# Phase 3: Extract Shared Relay Protocol

## Goal

Eliminate ~400 lines of duplicated relay protocol logic between `WebSocketConnection` (733 lines) and `SecureConnection` (1850 lines). After this, each class is lean and focused on its unique concern (plain WS connection vs SRP auth + encryption).

## Problem

Both classes independently implement identical relay protocol logic:
- Message routing (`handleEvent`, `handleResponse`, `handleUpload*`)
- API methods (`fetch`, `fetchBlob`, `subscribeSession`, `subscribeActivity`, `upload`)
- State management (`pendingRequests`, `pendingUploads`, `subscriptions` Maps)
- Lifecycle (`close`, reject-all-pending, notify-subscriptions-closed)

The ONLY real differences are:
| Concern | WebSocketConnection | SecureConnection |
|---------|---------------------|------------------|
| **send** | `encodeJsonFrame(msg)` | `encryptToBinaryEnvelope(JSON.stringify(msg))` |
| **receive** | `decodeJsonFrame(data)` | `decryptBinaryEnvelopeWithDecompression(data)` |
| **upload chunks** | `encodeUploadChunkFrame(...)` | `encryptBytesToBinaryEnvelope(payload, ...)` |
| **ready check** | `ws.readyState === OPEN` | `connectionState === "authenticated"` |

### Bugs from the duplication

1. **WebSocketConnection `handleResponse` is missing subscription error handling.** SecureConnection checks the `subscriptions` map when a response arrives with `status >= 400` and routes it to `onError`. WebSocketConnection doesn't — subscription failures (e.g., 404 no active process) are silently dropped with "Received response for unknown request."

2. **SecureConnection's `onclose` handler is copy-pasted 3 times** in `connectAndAuthenticate` (line 599), `resumeOnExistingSocket` (line 303), and `authenticateOnExistingSocket` (line 1763). Same ~30-line block, no shared method.

## Approach: Composition with `RelayProtocol`

Extract protocol logic into a composed helper class. Both connections create a `RelayProtocol` and provide transport-specific callbacks via closures.

Why composition over inheritance:
- No import chain issues (RelayProtocol doesn't touch SRP/crypto)
- SecureConnection has 4+ constructor variants that don't fit inheritance
- Protocol logic becomes independently testable
- Clearer separation: transport vs protocol

## Files

| File | Action | Lines before → after |
|------|--------|---------------------|
| `connection/RelayProtocol.ts` | **new** | ~400 |
| `connection/WebSocketConnection.ts` | modify | 733 → ~200 |
| `connection/SecureConnection.ts` | modify | 1850 → ~1050 |

No changes to: `types.ts`, `index.ts`, `DirectConnection.ts`, `FetchSSE.ts`, any server code.

## Steps

### Step 1: Create `RelayProtocol`

New file: `packages/client/src/lib/connection/RelayProtocol.ts`

**Transport interface (injected by caller):**

```ts
interface RelayTransport {
  sendMessage(msg: RemoteClientMessage): void;
  sendUploadChunk(uploadId: string, offset: number, chunk: Uint8Array): void;
  ensureConnected(): Promise<void>;
  isConnected(): boolean;
}

interface RelayProtocolOptions {
  debugEnabled?: () => boolean;
  logPrefix?: string;  // "[WebSocketConnection]" or "[SecureConnection]"
}
```

**What RelayProtocol owns:**

State:
- `pendingRequests: Map<string, PendingRequest>`
- `pendingUploads: Map<string, PendingUpload>`
- `subscriptions: Map<string, StreamHandlers>`

Methods extracted from both classes:
- `routeMessage(msg: YepMessage)` — the switch (response/event/upload_*)
- `handleEvent(event)` — route to subscription handlers, call onOpen for "connected"
- `handleResponse(response)` — subscription error check **then** pending request resolution
- `handleUploadProgress/Complete/Error(msg)` — forward to pending upload
- `fetch<T>(path, init?)` — build RelayRequest, correlate, timeout (30s)
- `fetchBlob(path)` — build request, decode base64 response
- `subscribeSession(sessionId, handlers, lastEventId?)` — register + send subscribe
- `subscribeActivity(handlers)` — register + send subscribe (with browserProfileId/originMetadata)
- `upload(projectId, sessionId, file, options?)` — upload_start/chunks/upload_end
- `rejectAllPending(error)` — reject all pending requests + uploads
- `notifySubscriptionsClosed()` — call onClose on each subscription, clear
- `close()` — rejectAllPending + notifySubscriptionsClosed

Debug logging is conditional on `options.debugEnabled?.()`, making it available for SecureConnection and a no-op for WebSocketConnection.

`PendingRequest` uses a unified type with optional debug fields:
```ts
interface PendingRequest {
  resolve: (response: RelayResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  startTime?: number;
  method?: string;
  path?: string;
}
```

### Step 2: Refactor WebSocketConnection to use RelayProtocol

Remove all protocol logic. What remains (~200 lines):

- `ws` field, `connectionPromise`, reconnect config
- `getWsUrl()`, `ensureConnected()`, `connect()`
- `send(msg)` — `encodeJsonFrame(msg)` → `ws.send(...)`
- `handleMessage(data)` — decode binary/text → `this.protocol.routeMessage(msg)`
- Delegation methods: `fetch`, `fetchBlob`, `subscribeSession`, `subscribeActivity`, `upload` → `this.protocol.*`
- `close()` — `this.protocol.close()` + close WebSocket

Create protocol in constructor:
```ts
this.protocol = new RelayProtocol({
  sendMessage: (msg) => this.send(msg),
  sendUploadChunk: (id, offset, chunk) => {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("WebSocket not connected");
    this.ws.send(encodeUploadChunkFrame(id, offset, chunk));
  },
  ensureConnected: () => this.ensureConnected(),
  isConnected: () => this.ws?.readyState === WebSocket.OPEN,
}, { logPrefix: "[WebSocketConnection]" });
```

Update `ws.onclose` to use `this.protocol.rejectAllPending(closeError)` + `this.protocol.notifySubscriptionsClosed()`.

### Step 3: Refactor SecureConnection to use RelayProtocol

Same pattern. Additionally:

**Extract `handleSocketClose` method** — the onclose logic duplicated 3 times. Single method that:
1. Checks if was authenticated
2. Clears auth state (`sessionKey`, `srpSession`)
3. Creates `WebSocketCloseError`
4. Calls `this.protocol.rejectAllPending(closeError)`
5. Calls `this.protocol.notifySubscriptionsClosed()`
6. Rejects auth promise or calls `onDisconnect` depending on prior state

Transport implementation:
```ts
this.protocol = new RelayProtocol({
  sendMessage: (msg) => this.send(msg),
  sendUploadChunk: (id, offset, chunk) => {
    const payload = encodeUploadChunkPayload(id, offset, chunk);
    const envelope = encryptBytesToBinaryEnvelope(payload, BinaryFormat.BINARY_UPLOAD, this.sessionKey!);
    this.ws!.send(envelope);
  },
  ensureConnected: () => this.ensureConnected(),
  isConnected: () => this.connectionState === "authenticated" && this.ws?.readyState === WebSocket.OPEN,
}, { debugEnabled: () => getRelayDebugEnabled(), logPrefix: "[SecureConnection]" });
```

**What stays in SecureConnection (unique, ~1050 lines):**
- SRP auth: hello/challenge/proof/verify/resume (~400 lines)
- Session persistence: StoredSession type, 4 constructor variants (~150 lines)
- Relay reconnection: `reconnectThroughRelay()` (~85 lines)
- `forceReconnect()` — uses `protocol.rejectAllPending()` + `protocol.notifySubscriptionsClosed()` (~65 lines)
- `sendCapabilities()` (~25 lines)
- `handleMessage(data)` — decrypt → `this.protocol.routeMessage(msg)` (~50 lines)
- Connection lifecycle: `ensureConnected()`, `connectAndAuthenticate()`, `handleSocketClose()` (~200 lines)
- `send(msg)` — encrypt + send (~15 lines)
- `isAuthenticated()`, `close()` (~20 lines)

**Update `forceReconnect()`:** Replace inline pending-request/subscription loops with `this.protocol.rejectAllPending()` and `this.protocol.notifySubscriptionsClosed()`.

### Step 4: Verify

```bash
pnpm lint        # No dead imports
pnpm typecheck   # Types work
pnpm test        # Unit tests pass
pnpm test:e2e    # ws-transport.e2e.test.ts, ws-secure.e2e.test.ts pass
```

## Bug fixes included for free

1. **Subscription error handling on WebSocketConnection** — `handleResponse` in `RelayProtocol` checks `subscriptions` map for error responses before checking `pendingRequests`. Subscription failures now correctly call `onError` on both transports.

2. **Duplicated onclose in SecureConnection** — extracted to single `handleSocketClose()` method, eliminating 3 copies of ~30 lines each.

## What this does NOT change

- `DirectConnection` stays as-is (HTTP fetch + SSE subscriptions)
- Server-side code — no changes
- Public `Connection` interface — no changes
- Import rules — SecureConnection still not re-exported from index.ts
- Transport selection in `useSSE`/`activityBus` — no changes (later phase)
