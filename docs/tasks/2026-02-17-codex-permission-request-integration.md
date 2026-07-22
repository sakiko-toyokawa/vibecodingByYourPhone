# Codex Permission Request Integration Investigation

Date: 2026-02-17

## Summary

Codex permission-elevation prompts are available, but yepanywhere's current `codex` provider cannot surface them because it uses the high-level `@openai/codex-sdk` `Thread.runStreamed()` API, which does not expose approval-request callbacks/events.

The Codex app-server JSON-RPC protocol does expose explicit approval requests and response hooks. Integrating Codex permission prompts in yepanywhere should be done by moving the runtime path from `@openai/codex-sdk` stream events to `codex app-server` JSON-RPC.

## Evidence Collected

1. Current provider limitation in code:
- `/Users/kgraehl/code/yepanywhere/packages/server/src/sdk/providers/codex.ts`
- `supportsPermissionMode = false`
- session loop uses `thread.runStreamed()` and only receives `thread/turn/item/error` events.

2. Codex SDK type surface lacks approval-request events:
- `/Users/kgraehl/code/yepanywhere/node_modules/.pnpm/@openai+codex-sdk@0.77.0/node_modules/@openai/codex-sdk/dist/index.d.ts`
- `ThreadEvent` union includes no permission-request event.

3. Real Codex persisted sessions show elevated tool calls include:
- `sandbox_permissions: "require_escalated"`
- `justification`
- optional `prefix_rule`
- Example files under `~/.codex/sessions/2026/02/17/*.jsonl`.

4. Codex app-server protocol generation confirms first-class approval requests:
- Generated via:
  - `codex app-server generate-json-schema --out /tmp/codex-proto`
  - `codex app-server generate-ts --out /tmp/codex-proto`
- Key protocol types:
  - `/tmp/codex-proto/ServerRequest.ts`
  - `/tmp/codex-proto/ClientRequest.ts`
  - `/tmp/codex-proto/ServerNotification.ts`
  - `/tmp/codex-proto/v2/CommandExecutionRequestApprovalParams.ts`
  - `/tmp/codex-proto/v2/FileChangeRequestApprovalParams.ts`
  - `/tmp/codex-proto/v2/CommandExecutionRequestApprovalResponse.ts`
  - `/tmp/codex-proto/v2/FileChangeRequestApprovalResponse.ts`
  - `/tmp/codex-proto/v2/AskForApproval.ts`
  - `/tmp/codex-proto/v2/SandboxMode.ts`
  - `/tmp/codex-proto/v2/TurnStartParams.ts`

Server -> client request methods include:
- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/tool/requestUserInput`

Decision models include:
- Command: `accept`, `acceptForSession`, `acceptWithExecpolicyAmendment`, `decline`, `cancel`
- File: `accept`, `acceptForSession`, `decline`, `cancel`

5. App-server turn/session methods and policy enums are explicit:
- client requests: `initialize`, `thread/start|resume`, `turn/start|interrupt`
- approval policy enum: `untrusted | on-failure | on-request | never`
- sandbox enum: `read-only | workspace-write | danger-full-access`
- command approval params include `command`, `cwd`, `commandActions`, optional `proposedExecpolicyAmendment`
- file approval params include optional `grantRoot`

## Current Architecture Gap

`Process` approval flow is currently centered on `onToolApproval` callback semantics (Claude/Gemini ACP style):
- prompt user via `InputRequest`
- return allow/deny to provider callback

This is sufficient for one-shot allow/deny, but codex app-server supports richer decisions (`acceptForSession`, exec policy amendment) that are not represented in current `ToolApprovalResult` and session input response API.

Relevant files:
- `/Users/kgraehl/code/yepanywhere/packages/server/src/supervisor/Process.ts`
- `/Users/kgraehl/code/yepanywhere/packages/server/src/sdk/types.ts`
- `/Users/kgraehl/code/yepanywhere/packages/server/src/routes/sessions.ts`
- `/Users/kgraehl/code/yepanywhere/packages/client/src/components/ToolApprovalPanel.tsx`
- `/Users/kgraehl/code/yepanywhere/packages/client/src/api/client.ts`

Codex item-shape mismatch to account for:
- current `@openai/codex-sdk` `ThreadItem` uses snake_case item types (`command_execution`, `file_change`)
- app-server `v2.ThreadItem` uses camelCase item types (`commandExecution`, `fileChange`)
- conversion logic in codex provider must be updated or dual-mapped

## Recommended Integration Approach

### 1. Runtime transport change for `codex` provider

Replace Codex turn runtime from high-level SDK stream to app-server JSON-RPC:
- Keep current app-server model-list code path as seed.
- Add a reusable app-server client for `initialize`, `thread/start|resume`, `turn/start`, notifications, and server-initiated requests.

Why this is required:
- Approval requests are delivered as JSON-RPC server requests, not as `ThreadEvent`s.

Suggested module split:
- `packages/server/src/sdk/providers/codex/app-server-client.ts`
  - spawn codex process (`codex app-server --listen stdio://`)
  - JSON-RPC request/response multiplexer
  - notification stream + server-request handlers
- `packages/server/src/sdk/providers/codex/app-server-mapper.ts`
  - map app-server notifications/items to `SDKMessage`
  - map approval request payloads to `InputRequest`
- `packages/server/src/sdk/providers/codex.ts`
  - orchestrate queue -> `turn/start`
  - wire `onToolApproval`
  - preserve existing provider public interface

### 2. Map app-server approval requests into yepanywhere approval flow

When app-server sends:
- `item/commandExecution/requestApproval`: map to tool approval (`Bash`)
- `item/fileChange/requestApproval`: map to tool approval (`Edit`)

Bridge to existing flow by invoking provider `onToolApproval` callback and awaiting response.

Minimal initial mapping:
- allow -> `accept`
- deny -> `decline`

MVP approval payload mapping:
- command request `toolInput`: `{ command, cwd, reason, commandActions, proposedExecpolicyAmendment }`
- file request `toolInput`: `{ reason, grantRoot }`
- retain `itemId/threadId/turnId` in `toolInput` for correlation/debug

### 3. Add richer decision support (phase 2)

Extend internal approval response model to carry optional scope/policy choice:
- once
- session
- execpolicy amendment (command)

Then map to app-server decisions:
- `accept`
- `acceptForSession`
- `acceptWithExecpolicyAmendment`

This needs coordinated updates in server API + client approval UI.

### 4. Provider capability updates

After phase 1 transport integration:
- set Codex provider `supportsPermissionMode` to `true`
- remove client metadata claim "No out-of-band tool approval"

Files:
- `/Users/kgraehl/code/yepanywhere/packages/server/src/sdk/providers/codex.ts`
- `/Users/kgraehl/code/yepanywhere/packages/client/src/providers/implementations/CodexProvider.ts`

## Permission Mode Mapping (Codex)

Current mapping in provider is coarse and tied to SDK options. For app-server, recommended initial behavior:

- `default`
  - `approvalPolicy = on-request`
  - `sandbox = workspace-write`
- `acceptEdits`
  - same app-server policy as `default` initially; rely on process auto-allow for edit tools (MVP)
- `plan`
  - `approvalPolicy = on-request`
  - optional stricter `sandbox = read-only` (recommended for consistency)
- `bypassPermissions`
  - `approvalPolicy = never`
  - `sandbox = danger-full-access`

Notes:
- `on-failure` is insufficient for explicit escalation prompts; use `on-request`.
- `untrusted` can be evaluated later for stricter policy presets.

## Implementation Phases

### Phase 1 (MVP: real prompt support)

1. Add Codex app-server JSON-RPC runtime client.
2. Port message conversion from current codex provider to app-server notifications (`thread/started`, `turn/completed`, `item/started|completed`, `error`).
3. Handle `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` with allow/deny only.
4. Wire to existing `Process.handleToolApproval` callback path.
5. Switch `codex` provider to `supportsPermissionMode = true`.
6. Update client codex provider metadata ("No out-of-band tool approval" removal).
7. Add tests for approval request/decision roundtrip using mocked app-server stream.

### Phase 2 (Parity with Codex desktop prompt options)

1. Extend approval response schema to represent:
- `acceptForSession`
- optional exec policy amendment / prefix-like approvals
2. Update UI to render dynamic second option for codex requests.
3. Persist and surface approval choice metadata in session timeline where useful.

### Phase 3 (Policy persistence parity)

1. Support command prefix / execpolicy amendment UX and routing to `acceptWithExecpolicyAmendment`.
2. Support per-session approvals via `acceptForSession`.
3. Add safety guardrails and visibility for persisted policy grants.

## API/UI Delta for Phase 2+

Server/API:
- extend input response payload beyond `approve|approve_accept_edits|deny`
- add optional structured approval response:
  - `decisionScope`: `once|session|policy`
  - `policyAmendment?: string[]`

Shared types:
- extend `InputRequest` with optional normalized action metadata for richer option rendering
- extend `ToolApprovalResult` to carry provider-specific approval decision hints

Client UI:
- generalize `ToolApprovalPanel` options from hard-coded edit-mode buttons to request-driven options
- keep current keyboard shortcuts for backward compatibility

## Test Plan

1. Unit tests (provider):
- request -> mapped `InputRequest`
- approve -> JSON-RPC response payload
- deny -> JSON-RPC response payload
- stream continues correctly after response

2. Process/API tests:
- pending request visible at `/sessions/:id/pending-input`
- POST `/sessions/:id/input` resolves request
- state transitions: `in-turn -> waiting-input -> in-turn/idle`

3. E2E (real codex app-server):
- trigger command requiring escalation
- verify approval UI appears
- approve and ensure command executes
- deny and ensure command does not execute (declined status)

4. Compatibility:
- resume existing codex session IDs still works through `thread/resume`
- no-regression for codex model list path
- no-regression for non-approval codex turns

## Risks

1. Protocol compatibility drift across codex versions.
- Mitigation: codegen contract checks in CI from `codex app-server generate-*` snapshots.

2. More complex transport layer than current SDK wrapper.
- Mitigation: encapsulate JSON-RPC client in isolated module with integration tests.

3. UX mismatch for "don't ask again" semantics.
- Mitigation: phase in richer response model after MVP allow/deny is stable.

4. Item type schema drift (snake_case vs camelCase).
- Mitigation: version-gated mapping helpers + fixture tests from generated app-server examples.

## Bottom Line

To support Codex permission-elevation prompts in yepanywhere, the key change is not UI-first; it is transport-level: adopt Codex app-server JSON-RPC for live sessions and handle server-initiated approval requests. The current `@openai/codex-sdk` stream API does not provide enough hooks for this feature.
