# Codex Persisted Session Rendering Parity Plan

## Summary

Improve Codex persisted-session rendering so it degrades cleanly and more closely matches Codex Desktop behavior while using only persisted on-disk data. The current pipeline is Claude-first and misses several Codex-specific persisted variants, which causes invalid-line drops, tool pairing gaps, and lower-fidelity transcript display.

The work should focus on:

1. Correctly normalizing Codex persisted records into the shared UI message model.
2. Expanding Codex schema/validation coverage for observed persisted variants.
3. Improving tool-call/result rendering parity and fallback behavior.
4. Keeping unsupported/unknown payloads visible as structured fallbacks instead of silently losing context.

## Implementation Status (2026-02-17)

- Completed: Expanded Codex schema for `custom_tool_call`, `custom_tool_call_output`, `web_search_call`, `developer` role, `input_image`, and `turn_aborted`.
- Completed: Updated Codex normalization so tool outputs are emitted as user `tool_result` content blocks (pairable by existing client preprocessing).
- Completed: Added Codex tool-name canonicalization (`shell_command` -> `Bash`, `apply_patch` -> `Edit`, web-search variants -> `WebSearch`) on server normalization and client registry fallback.
- Completed: Excluded `developer` role messages from normalized transcript and Codex summary `messageCount`.
- Completed: Added `turn_aborted` normalization + client preprocessing visibility.
- Completed: Added support for compaction-related persisted entries/events (`compacted`, `context_compacted`, `item_completed`) and mapped compaction markers into system timeline entries.
- Completed: Added/expanded tests in server/client for tool pairing, custom tools, developer filtering, and turn-aborted rendering.
- Completed: Patched `Edit` renderer safety for aliased Codex `apply_patch` tool calls with missing `file_path` (fallback label now `Patch`; no `split` crash).
- Completed: Quality gates for this increment:
  - `pnpm --filter @yep-anywhere/server test -- test/sessions/codex-normalization.test.ts test/sessions/codex-reader-oss.test.ts`
  - `pnpm --filter @yep-anywhere/client test -- src/lib/__tests__/preprocessMessages.test.ts`
  - `pnpm lint`
  - `pnpm typecheck`
- Completed: Real-world Codex validation pass: `pnpm -s tsx scripts/validate-jsonl.ts --codex` -> `7407/7407` lines valid across `~/.codex/sessions`.
- In progress: Unknown-payload fallback card rendering and deeper parity tweaks for web-search/custom tool display details.

---

## Current Gaps Confirmed During Investigation

- Codex validator exists (`scripts/validate-jsonl.ts --codex`) but current schema does not cover all persisted variants.
- Observed unsupported `response_item.payload.type` values include:
  - `custom_tool_call`
  - `custom_tool_call_output`
  - `web_search_call`
- Observed unsupported role: `developer`.
- Observed unsupported content block type: `input_image`.
- Observed unsupported `event_msg.payload.type`: `turn_aborted`.
- Normalization mismatch: Codex `function_call_output` is normalized as top-level `tool_result` messages, but client pairing logic expects `tool_result` blocks inside a user message content array. This breaks tool call/result pairing and causes stale pending states.
- Tool names in persisted Codex data (`shell_command`, `apply_patch`, etc.) are not canonicalized to existing renderer contracts, so fallback rendering is too generic.
- `developer` messages are currently included in counts and may leak into transcript flow where they add noise.

---

## Scope

### In scope

- Schema and parsing support for currently observed persisted Codex variants.
- Normalization updates needed for correct UI pairing and rendering.
- Tool renderer mapping/parity updates for persisted Codex tool names.
- Additional tests across server normalization and client rendering preprocessing.

### Out of scope

- SDK streaming-path parity work.
- Reconstructing data not present in persisted JSONL.
- UI redesign beyond parity-focused rendering behavior.

---

## Implementation Plan

### 1. Fix Codex tool result pairing shape in normalization

Update Codex normalization so tool outputs are emitted in the same structural shape the client pairing logic already uses.

- Target file: `packages/server/src/sessions/normalization.ts`
- Change behavior:
  - For Codex `function_call_output` and `custom_tool_call_output`, emit a normalized message shape with `message.role = "user"` and `message.content` containing a `tool_result` block tied to `call_id`.
  - Keep/propagate output text in `tool_result.content`.
  - Preserve original event metadata on the normalized record (`source`, timestamps, ids).
- Goal: `preprocessMessages` can pair tool calls and results without Codex-specific client-side special-casing.

### 2. Extend Codex schema coverage to observed persisted variants

Expand zod/schema definitions for known persisted on-disk variants.

- Target files:
  - `packages/shared/src/codex-schema/session.ts`
  - `packages/shared/src/codex-schema/index.ts`
- Add support for:
  - `response_item.payload.type = "custom_tool_call"`
  - `response_item.payload.type = "custom_tool_call_output"`
  - `response_item.payload.type = "web_search_call"`
  - `response_item.payload.role = "developer"`
  - content block type `input_image`
  - `event_msg.payload.type = "turn_aborted"`
- Keep permissive passthrough for unknown additional fields.

### 3. Adjust transcript inclusion rules for developer-role content

Prevent developer role records from being treated as standard end-user transcript turns.

- Target files:
  - `packages/server/src/sessions/codex-reader.ts`
  - `packages/server/src/sessions/normalization.ts`
- Behavior:
  - Exclude `developer` role from user-visible `messageCount` unless explicitly requested by debug mode.
  - Normalize `developer` payloads into a non-primary display path (collapsed metadata/system channel) so they are inspectable but do not pollute main chat flow.

### 4. Canonicalize Codex tool names to existing renderer contracts

Map persisted Codex tool identifiers to renderer tool types currently used by Claude-oriented components.

- Target files:
  - `packages/server/src/sessions/normalization.ts` (preferred central mapping)
  - `packages/client/src/components/renderers/tools/index.tsx` (fallback support)
- Add mapping table (minimum):
  - `shell_command` -> `Bash` renderer type (or explicit `shell_command` renderer alias)
  - `apply_patch` -> `Edit`/patch renderer alias
  - web-search variants -> `WebSearch` alias
- Preserve original tool name as metadata for accurate labels when available.

### 5. Handle `turn_aborted` cleanly in normalized timeline

- Add normalized representation for `turn_aborted` events.
- Display as lightweight status marker/timeline event rather than dropping it.
- Ensure this does not break turn grouping.

### 6. Improve fallback rendering for unknown Codex payloads

When payload types are still unknown, render a structured fallback block instead of silently omitting content.

- Include:
  - raw type identifier
  - concise summary
  - expandable raw JSON (bounded)
- This preserves investigability and prevents silent context loss.

### 7. Add/expand validation and parity tests

#### Server tests

- Target files:
  - `packages/server/test/sessions/codex-normalization.test.ts`
  - `packages/server/test/sessions/codex-reader-oss.test.ts`
- Add cases for:
  - `custom_tool_call` + `custom_tool_call_output` pairing
  - `web_search_call` round-trip normalization
  - `developer` role exclusion from transcript count
  - `turn_aborted` normalized event emission

#### Client tests

- Target files:
  - `packages/client/src/lib/preprocessMessages.ts` tests (add if missing)
  - `packages/client/e2e/codex-oss.spec.ts`
- Add cases for:
  - paired Codex tool call/result rendering status transitions (`pending` -> `completed`)
  - renderer mapping correctness for `shell_command` and `apply_patch`
  - unknown payload fallback visibility

#### Validation script checks

- Re-run `scripts/validate-jsonl.ts --codex` before/after changes.
- Assert reduction in invalid-line count for known variants.

---

## Public Interfaces / Type Changes

### Codex schema additions

- Extend discriminated unions in Codex session schemas:
  - message roles include `developer`
  - response item payload types include `custom_tool_call`, `custom_tool_call_output`, `web_search_call`
  - content blocks include `input_image`
  - event message payload types include `turn_aborted`

### Normalized message contract

- Ensure Codex tool outputs conform to the same normalized shape as other sources that `preprocessMessages` expects:
  - `message.role = "user"`
  - `message.content[]` includes `type = "tool_result"`, with `tool_use_id/call_id` linkage and content.

### Renderer compatibility contract

- Define and document a canonical tool-name mapping layer to stabilize tool renderer selection across source formats.

---

## Test Scenarios and Acceptance Criteria

1. Tool pairing fidelity
- Given persisted Codex `function_call` + `function_call_output`, UI shows one paired row with completed status and output text attached.
- Same for `custom_tool_call` + `custom_tool_call_output`.

2. Schema acceptance for known persisted variants
- Validator accepts lines containing currently observed variants (`developer`, `web_search_call`, `input_image`, `turn_aborted`, custom tool call/output).

3. Transcript cleanliness
- Developer-role messages are not counted as normal user/assistant turns in standard view.
- Developer content remains inspectable through metadata/debug path.

4. Unknown variant resilience
- Unknown payload types render as structured fallback cards and do not crash or disappear silently.

5. Parity-focused rendering
- `shell_command` and `apply_patch` display with tool labels and summaries closer to Codex Desktop behavior.

---

## Assumptions and Defaults

- Primary objective is persisted-format fidelity, not SDK-stream parity.
- If a payload appears both as `event_msg.agent_message` and as assistant `response_item.message`, prefer one canonical transcript representation to avoid duplicates (default: prefer assistant `response_item.message`).
- Developer-role content default visibility is collapsed/off in main timeline.
- Unknown future Codex payload types should be preserved via fallback rendering rather than dropped.
- Existing Claude rendering architecture remains the foundation; Codex support is added through schema + normalization + mapping rather than a parallel renderer stack.

---

## Risks and Mitigations

- Risk: adding many Codex variants could increase normalization complexity.
  - Mitigation: centralize mapping/normalization tables and keep client assumptions source-agnostic.
- Risk: duplicate transcript entries from multiple persisted channels.
  - Mitigation: explicit de-dup strategy with deterministic precedence.
- Risk: future persisted format drift.
  - Mitigation: keep validator in CI/nightly checks on sampled session corpus and maintain fallback renderer.

---

## Rollout Notes

1. Land schema and normalization changes first.
2. Land tool mapping and fallback rendering updates.
3. Land tests and validator baseline updates.
4. Verify against a local persisted-session corpus from `~/.codex/sessions` and compare to expected timeline behavior.
