# Client-Side Remote Log Collector

Capture frontend connection logs, buffer in IndexedDB, flush to server on reconnect. For diagnosing phone sleep/wake reconnection issues.

## New Files

### 1. `packages/client/src/lib/diagnostics/idb.ts`
Thin promisified IndexedDB helpers (~60 lines):
- `openDatabase(name, version, onUpgrade)` → `Promise<IDBDatabase>`
- `putEntry(db, store, entry)` → `Promise<number>`
- `getAllEntries<T>(db, store, count?)` → `Promise<T[]>`
- `deleteEntries(db, store, keys)` → `Promise<void>`
- `countEntries(db, store)` → `Promise<number>`

### 2. `packages/client/src/lib/diagnostics/ClientLogCollector.ts`
Core class. DB: `"yep-anywhere-client-logs"`, store: `"entries"`, auto-increment key.

```
LogEntry: { id?, timestamp, level, prefix, message }
```

- `start()` — open IDB, wrap `console.log/warn/error`, subscribe to `connectionManager.on("stateChange")` for auto-flush on `"connected"`
- `stop()` — restore originals, close DB, unsubscribe
- Console wrapper: check if first arg matches `CAPTURED_PREFIXES` (`[ConnectionManager]`, `[SecureConnection]`, `[ActivityBus]`, `[WebSocketConnection]`, `[RemoteConnection]`, `[Relay]`, `[RelayProtocol]`). If no match → bail (zero overhead). If match → fire-and-forget `writeEntry()`.
- `flush()` — read up to 500 entries, POST to `/api/client-logs` via `getGlobalConnection()?.fetch() ?? directConnection.fetch()`, delete on success
- `trimEntries()` — enforce 2000 max cap on write
- If IDB unavailable (private browsing): fall back to in-memory array

### 3. `packages/client/src/lib/diagnostics/index.ts`
Singleton + lifecycle:
```typescript
export const clientLogCollector = new ClientLogCollector();
export function initClientLogCollection(): () => void;
```
`initClientLogCollection()` checks `getRemoteLogCollectionEnabled()`, starts/stops collector, subscribes to setting changes via the `useDeveloperMode` external store `listeners` set. Returns cleanup fn.

### 4. `packages/server/src/routes/client-logs.ts`
Hono route factory following existing pattern (`createClientLogsRoutes({ dataDir })`):
- `POST /` — receives `{ entries: LogEntry[], meta?: { userAgent, connectionMode } }`, writes JSONL to `{dataDir}/logs/client-logs/client-{isoTimestamp}-{random}.jsonl`
- Cap 500 entries per request, `mkdir -p` on first write

## Modified Files

### 5. `packages/client/src/hooks/useDeveloperMode.ts`
Add `remoteLogCollectionEnabled: boolean` to `DeveloperModeSettings` (default: `false`). Add `setRemoteLogCollectionEnabled` callback. Add `getRemoteLogCollectionEnabled()` non-React getter.

### 6. `packages/client/src/pages/settings/AboutSettings.tsx`
Add "Connection Diagnostics" toggle after "Launch Wizard" item. Uses `useDeveloperMode()` hook. Toggle switch with description: "Capture connection logs and send to server for debugging."

### 7. `packages/client/src/lib/connection/ConnectionManager.ts`
Add `console.log("[ConnectionManager] ...")` at key points (captured automatically by collector when enabled):
- `_setState()`: `"{prev} → {new}"`
- `_scheduleReconnect()`: `"attempt {n}/{max}, delay {ms}ms"`
- `_executeReconnect()` catch: `"reconnect failed: {message}"`
- `_checkStale()`: `"stale ({elapsed}ms), forcing reconnect"`
- `_handleBecameVisible()`: `"visible after {duration}ms hidden"` + whether threshold exceeded
- `handleError()` / `handleClose()`: error message + retryable status
- `forceReconnect()`: `"force reconnect"`

### 8. `packages/client/src/RemoteApp.tsx` (or `App.tsx`)
Call `initClientLogCollection()` in a top-level `useEffect`.

### 9. `packages/server/src/app.ts`
Mount: `app.route("/api/client-logs", createClientLogsRoutes({ dataDir }))` — inherits existing auth middleware.

## Verification

1. `pnpm typecheck` — no type errors
2. `pnpm lint` — no lint errors
3. `pnpm test` — existing tests pass
4. Unit test for `idb.ts` helpers (vitest jsdom environment has fake-indexeddb)
5. Unit test for `ClientLogCollector` — mock console, verify capture/filter/flush
6. Manual: enable toggle → see `[ConnectionManager]` logs captured → disconnect/reconnect → verify logs appear in `~/.yep-anywhere/logs/client-logs/`
