# Server-Side Deferred Message Queue

Queue messages server-side so they survive navigation/disconnect. Server holds them and auto-sends when the agent's turn ends.

## Server Changes

### 1. `packages/server/src/supervisor/types.ts` — New event type

Add to `ProcessEvent` union:
```ts
| { type: "deferred-queue"; messages: { tempId?: string; content: string; timestamp: string }[] }
```

### 2. `packages/server/src/supervisor/Process.ts` — Deferred queue on Process

**New state:**
- `private deferredQueue: { message: UserMessage; timestamp: string }[] = []`

**New methods:**
- `deferMessage(message: UserMessage)` — adds to `deferredQueue`, emits `deferred-queue` event with summaries for SSE clients. Returns `{ success: true }`.
- `cancelDeferredMessage(tempId: string)` — removes by tempId, emits updated `deferred-queue` event. Returns success/failure.
- `getDeferredQueueSummary()` — returns `{ tempId, content, timestamp }[]` for SSE events and connected sync.
- Private `processDeferredQueue()` — shifts first message, calls `this.queueMessage()`, emits updated event. Returns true if processed.

**Modify `transitionToIdle()`** (line 1281):
```ts
private transitionToIdle(): void {
  this.clearIdleTimer();
  // Feed next deferred message before transitioning to idle
  if (this.deferredQueue.length > 0) {
    const next = this.deferredQueue.shift()!;
    this.emitDeferredQueueChange();
    this.queueMessage(next.message); // stays in-turn, SDK picks it up
    return;
  }
  this.setState({ type: "idle", since: new Date() });
  this.startIdleTimer();
  this.processNextInQueue();
}
```

Key: when deferred messages exist, the process never transitions to idle — it stays in-turn and feeds the next message directly to the SDK via messageQueue. No idle flicker.

### 3. `packages/server/src/routes/sessions.ts` — Route changes

**Modify POST `/sessions/:sessionId/messages`** (line 1028):
- Parse `deferred: boolean` from request body
- If `deferred && !process.isTerminated`: call `process.deferMessage(userMessage)` instead of `supervisor.queueMessageToSession()`
- Return `{ queued: true, deferred: true }`

**New route: DELETE `/sessions/:sessionId/deferred/:tempId`**:
- Calls `process.cancelDeferredMessage(tempId)`
- Returns `{ cancelled: true }` or 404

### 4. `packages/server/src/subscriptions.ts` — Forward deferred-queue events

Add case in the subscriber switch (after line 145):
```ts
case "deferred-queue":
  emit("deferred-queue", { messages: event.messages });
  break;
```

Include `deferredMessages` in the "connected" event payload (line ~161) so reconnecting clients get the current queue state.

## Client Changes

### 5. `packages/client/src/api/client.ts` — API methods

- Modify `queueMessage()` to accept optional `deferred?: boolean` in body
- New `cancelDeferredMessage(sessionId, tempId)` → DELETE `/sessions/:sessionId/deferred/:tempId`

### 6. `packages/client/src/hooks/useSession.ts` — Track deferred queue from SSE

**New state:**
```ts
const [deferredMessages, setDeferredMessages] = useState<DeferredMessage[]>([]);
```

**SSE handling:**
- Handle `deferred-queue` event → `setDeferredMessages(data.messages)`
- Handle `connected` event → sync `deferredMessages` from payload
- Handle `complete` event → clear deferredMessages (process is done)

Export `deferredMessages` from the hook.

### 7. `packages/client/src/pages/SessionPage.tsx` — Wire up queue action

**New `handleQueue` function:**
- Captures current text + attachments, clears them, clears draft
- Calls `api.queueMessage(sessionId, text, mode, attachments, tempId, thinking, true)` with `deferred: true`
- Triggers scroll
- On error: restore draft + attachments, show toast

**Pass to MessageInput:**
- `onQueue={status.owner !== "none" ? handleQueue : undefined}` — only when agent is running

**Pass to MessageList:**
- `deferredMessages={deferredMessages}`
- `onCancelDeferred={(tempId) => api.cancelDeferredMessage(sessionId, tempId)}`

### 8. `packages/client/src/components/MessageInput.tsx` — Queue prop + keyboard shortcut

- Add `onQueue?: (text: string) => void` prop
- Add `handleQueue` callback (mirrors `handleSubmit` but calls `onQueue`)
- In `handleKeyDown`: when `onQueue` is defined and `Ctrl+Enter` is pressed, call `handleQueue()` instead of normal Enter behavior. When `onQueue` is not defined, Ctrl+Enter keeps its existing behavior.
- Pass `onQueue` to `MessageInputToolbar`

### 9. `packages/client/src/components/MessageInputToolbar.tsx` — Queue button

- Add `onQueue?: () => void` prop
- When `onQueue && canSend`: render queue button left of send/stop button
- Queue button: 36x36, `background: var(--attention-color)` (blue), white SVG icon (list/queue lines). Title: `"Queue message (Ctrl+Enter)"`

### 10. `packages/client/src/components/MessageList.tsx` — Display deferred messages

- Add `deferredMessages` and `onCancelDeferred` props
- Render after pending messages, before compacting indicator
- Each shows: message bubble (dimmed, blue left border), "Queued (next)" / "Queued (#2)" label, cancel (x) button

### 11. `packages/client/src/styles/index.css` — Styles

- `.queue-button`: extend `.send-button, .stop-button` shared base to include `.queue-button`, set `background: var(--attention-color)`
- `.deferred-message`, `.deferred-message-bubble`, `.deferred-message-footer`, `.deferred-message-status`, `.deferred-message-cancel`: similar pattern to `.pending-message` styles but with blue accent

## Edge Cases

- **Multiple deferred messages**: processed one at a time. Agent finishes → `transitionToIdle` → feeds next → stays in-turn → finishes → repeats.
- **Process terminates**: deferred messages lost (process is dead). Client receives complete/terminated event, clears deferred state.
- **Client reconnects**: `connected` SSE event includes current `deferredMessages` → client syncs.
- **Waiting-input (tool approval)**: processState is `waiting-input`, not idle. `transitionToIdle` doesn't fire. Deferred messages wait until user handles approval and agent finishes.
- **Thinking mode changes**: deferred messages use the process's current thinking settings when sent. No special handling.

## Verification

1. `pnpm typecheck` — no type errors
2. `pnpm lint` — no lint errors
3. `pnpm test` — existing tests pass
4. Manual: start session, send message, while agent runs type follow-up and click blue Queue button → appears as "Queued" in message list. Agent finishes → auto-sends. Test cancel button. Test Ctrl+Enter on desktop. Test queue button only appears when agent is running. Navigate away and back — queued message survives (visible after reconnect).
