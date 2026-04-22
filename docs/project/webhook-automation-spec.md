# Lifecycle Webhooks

## Goal

Expose a single outbound webhook so external systems can react when a session stops making progress.

Yep remains an event emitter only. It does not store automation state, execute remote logic, parse webhook responses, or provide a session KV API.

## Scope

Settings category: `Lifecycle Webhooks`

Fields:
- `Enabled`
- `Webhook URL`
- `Bearer Token` optional
- `Dry Run` optional

No event-type picker in v1.
No session variables.
No webhook response parsing.

## Event

Start with one event only:

```ts
interface SessionInactiveWebhook {
  type: "session-inactive";
  timestamp: string;
  session: {
    id: string;
  };
  project: {
    id: UrlProjectId;
    path: string;
    name: string;
  };
  process?: {
    id: string;
    provider?: ProviderName;
    model?: string;
    executor?: string;
    permissionMode?: string;
  };
  reason?: "idle" | "error";
  summary?: string;
  lastUserMessageText?: string;
  lastMessageText?: string;
  dryRun: boolean;
}
```

Semantics:
- Emit on transition to idle.
- Emit on unexpected process termination with `reason: "error"`.
- Do not distinguish `idle` vs `completed`.
- Do not emit on manual abort.
- Do not emit on internal restart for thinking/model changes.
- Do not emit on every queued message.

## Delivery

POST JSON to the configured URL.

Headers:
- `Content-Type: application/json`
- `Authorization: Bearer <token>` if configured

Example:

```json
{
  "type": "session-inactive",
  "timestamp": "2026-04-02T12:34:56.000Z",
  "session": {
    "id": "session-1"
  },
  "project": {
    "id": "abc",
    "path": "/home/user/repo",
    "name": "repo"
  },
  "process": {
    "id": "proc-1",
    "provider": "claude",
    "model": "claude-sonnet-4-5",
    "permissionMode": "default"
  },
  "reason": "idle",
  "lastUserMessageText": "fix the tests",
  "lastMessageText": "I updated the failing test helpers.",
  "dryRun": false
}
```

Local receiver smoke test:

```bash
# Terminal 1: print webhook bodies locally
while true; do
  nc -l 127.0.0.1 8787 | sed -n '/^\r$/,$p'
done
```

```bash
# Terminal 2: inspect a representative payload
curl -sS http://127.0.0.1:8787/ \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer test-token' \
  -d '{
    "type": "session-inactive",
    "timestamp": "2026-04-02T12:34:56.000Z",
    "session": { "id": "session-1" },
    "project": {
      "id": "abc",
      "path": "/home/user/repo",
      "name": "repo"
    },
    "process": {
      "id": "proc-1",
      "provider": "claude",
      "model": "claude-sonnet-4-5",
      "permissionMode": "default"
    },
    "reason": "idle",
    "lastUserMessageText": "fix the tests",
    "lastMessageText": "I updated the failing test helpers.",
    "dryRun": false
  }'
```

The external receiver can decide what to do next with Yep's existing APIs. A minimal "keep going" loop looks like:

```bash
curl -sS -X POST http://localhost:3400/api/sessions/session-1/messages \
  -H 'content-type: application/json' \
  -d '{"message":"continue from the last stopping point"}'
```

## External Control Model

The external service uses Yep's existing APIs if it wants to act:
- `POST /api/sessions/:id/messages`
- `POST /api/projects/:pid/sessions/:id/resume`
- `POST /api/sessions/:id/input`

Yep does not interpret webhook responses.

## Implementation Shape

### Server settings

Add only:
- `lifecycleWebhooksEnabled: boolean`
- `lifecycleWebhookUrl?: string`
- `lifecycleWebhookToken?: string`
- `lifecycleWebhookDryRun?: boolean`

### Service

Add a small `LifecycleWebhookService` that:
1. Subscribes to `EventBus`
2. Listens for existing idle activity transitions
3. Listens for one small generic termination event
4. Builds the payload
5. POSTs the webhook
6. Logs failures without retry

### Supervisor changes

Absolute minimum:
- none for idle if existing `process-state-changed(activity: "idle")` is enough
- at most one generic termination bus event for unexpected errors

No new Maps/Sets.
No webhook-specific lifecycle callbacks.

## Non-Goals

Not in v1:
- event routing rules
- multiple webhook URLs
- event-type filtering UI
- session variables
- session metadata API for automation
- webhook response parsing
- retries/backoff
- action dispatch
- `message-queued` hooks

## Progress

- [x] Replace the old spec with the reduced lifecycle-webhooks design
- [x] Implement server-side lifecycle webhook settings
- [x] Implement lifecycle webhook delivery service
- [x] Implement minimal event source for unexpected termination
- [x] Add settings UI for lifecycle webhooks
- [x] Verify with tests/typecheck
