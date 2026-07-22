# Codex Persisted `apply_patch` Rendering Plan (No Client-Side Highlighting)

## Scope

Plan only. No implementation in this document.

Goal: fix persisted Codex session UX where many `apply_patch` calls render as endless `Computing diff...`, using persisted data only.

Constraint: no new client-side diff parsing/highlighting logic.

## Root Cause Summary

1. Codex `apply_patch` is canonicalized to `Edit`, so it is routed through `EditRenderer`.
   - `packages/server/src/sessions/normalization.ts`
   - `packages/client/src/components/renderers/tools/index.tsx`
2. Persisted Codex `custom_tool_call` with `name=apply_patch` stores `payload.input` as a raw patch string (`*** Begin Patch ...`), not `Edit` fields (`file_path`, `old_string`, `new_string`).
   - Example: `/Users/kgraehl/.codex/sessions/2026/02/17/rollout-2026-02-17T12-52-12-019c6b71-984f-71e0-9a27-3bcea9f8cffd.jsonl`
3. Server `augmentEditInputs` only augments when those classic Edit fields exist, so Codex `apply_patch` calls do not get `_structuredPatch` / `_diffHtml`.
   - `packages/server/src/routes/sessions.ts`
4. `EditRenderer` shows `Computing diff...` when `structuredPatch` is missing, including completed items in collapsed preview paths.
   - `packages/client/src/components/renderers/tools/EditRenderer.tsx`

## Solution Options

### Option A: Client fallback only

Change `EditRenderer` to render non-loading fallback for missing patch data.

Pros:
- Very small change.
- Fastest way to remove broken loading UX.

Cons:
- No better diff quality for Codex `apply_patch`.
- Leaves server data gap unresolved.

### Option B: Server-side `apply_patch` parser + existing Edit augment path

Parse raw patch strings on the server and inject `_structuredPatch` (and optional `_diffHtml`) into tool input before response.

Pros:
- Reuses existing architecture.
- Produces good diff rendering for many cases.
- Keeps Claude Edit behavior unchanged.

Cons:
- Parser complexity for edge cases.
- Needs robust fallback when parse fails.

### Option C: Dedicated `apply_patch` renderer

Stop aliasing to `Edit` or add separate renderer branch for `apply_patch`.

Pros:
- Clear separation of patch-style tool semantics.

Cons:
- Higher maintenance and regression risk.
- Duplicates logic currently centralized in Edit path.

## Recommended Approach

Use **Option B + a hard fallback in EditRenderer**.

### Decision

1. Keep canonicalization `apply_patch -> Edit`.
2. Add server augmentation support for raw patch string input.
3. Make client fallback explicit so completed rows never show infinite loading.
4. Do not add new client-side highlighting/parsing logic.

## Implementation Steps (Decision-Complete)

1. Add server-side patch parsing utility for Codex `apply_patch` input.
   - New utility under `packages/server/src/augments/` (or adjacent helper) that accepts raw patch text and returns:
   - `structuredPatch: PatchHunk[]`
   - `filePath?: string` (best-effort)
   - `rawPatch: string`
   - Parse only persisted format patterns actually observed (`*** Begin Patch`, `*** Update File:`, `@@` hunks, `+/-/ ` lines).
2. Extend `augmentEditInputs` in `packages/server/src/routes/sessions.ts`.
   - Current branch: classic Edit object (`file_path`, `old_string`, `new_string`) unchanged.
   - New branch: if `block.name === "Edit"` and `block.input` is string patch text (or object containing raw patch), parse and inject:
   - `_structuredPatch` when parse succeeds
   - optional `_diffHtml` only from existing server functions
   - `_rawPatch` always for fallback rendering
3. Keep failures non-fatal.
   - If parse fails, do not throw and do not block response.
   - Ensure `_rawPatch` remains available so UI can render non-broken fallback.
4. Update `EditRenderer` fallback behavior in `packages/client/src/components/renderers/tools/EditRenderer.tsx`.
   - Pending/streaming classic Edit can still show `Computing diff...`.
   - Completed item with missing `structuredPatch`:
   - if `_rawPatch` present, render plain patch text preview (truncate + expand modal)
   - else render stable non-loading fallback text (`Patch preview unavailable`)
5. Preserve Claude Edit behavior.
   - Do not change existing classic Edit result rendering path.
   - Do not alter `computeEditAugment` inputs/semantics for Claude.
6. Keep future variants resilient.
   - Handle unknown Codex shapes defensively:
   - string input
   - object input with `patch` or similar field
   - malformed patch text
   - always degrade to `_rawPatch` display when parsing cannot produce hunks.

## Required Type / Contract Changes

1. Server augment type extension:
   - `packages/server/src/augments/types.ts`
   - Extend `EditInputWithAugment` with optional `_rawPatch?: string`.
2. Client renderer local type extension:
   - `packages/client/src/components/renderers/tools/EditRenderer.tsx`
   - Add optional `_rawPatch?: string` on `EditInputWithAugment`.
3. API/session response contract clarification:
   - `Edit` tool input may now be one of:
   - classic Edit object (+ augment fields)
   - raw patch derived shape with `_rawPatch` and optional `_structuredPatch`.
4. No persisted schema format changes required.

## Test Plan

### Server Unit Tests

1. `packages/server/test/augments/edit-augments.test.ts` (or new focused parser test file):
   - parse valid raw `*** Begin Patch` into non-empty `PatchHunk[]`
   - tolerate malformed patch without throwing
   - keep raw patch fallback when parsing fails.
2. Add route/session augmentation coverage:
   - in `packages/server/test/incremental-session.test.ts` (or new sessions route test), create a Codex-style session with `custom_tool_call` `apply_patch` string input and assert API output contains `_structuredPatch` or `_rawPatch`.

### Client Unit Tests

1. Add tests for Edit renderer fallback behavior (new test file for tool renderer if needed):
   - completed Edit with `_rawPatch` but no `_structuredPatch` renders patch text, not `Computing diff...`
   - pending Edit without patch data still renders `Computing diff...`
   - classic Edit with `_structuredPatch` renders existing diff path unchanged.

### Real Session Validation Check

Use session:
- `019c6b71-984f-71e0-9a27-3bcea9f8cffd`
- file: `/Users/kgraehl/.codex/sessions/2026/02/17/rollout-2026-02-17T12-52-12-019c6b71-984f-71e0-9a27-3bcea9f8cffd.jsonl`

Validate in UI:
1. No completed Codex `apply_patch` row is stuck on `Computing diff...`.
2. Each row shows either:
   - structured diff preview, or
   - plain raw patch fallback.
3. No renderer crashes for malformed patch entries.

## Acceptance Criteria

1. Completed persisted Codex `apply_patch` calls do not display endless loading.
2. Good diff is shown when server can parse patch text.
3. Useful non-broken fallback is shown when parser cannot produce hunks.
4. Existing Claude Edit behavior is unchanged.
5. Unknown/future Codex variants degrade safely without client-side parsing/highlighting additions.

## Current Status (Completed)

This plan is complete, including the syntax-highlighting follow-up phase.

1. Server parses persisted raw `apply_patch` text and injects `_structuredPatch` when possible.
2. Server preserves `_rawPatch` for stable completed-row fallback rendering.
3. Server now generates `_diffHtml` for parsed raw patch hunks using the existing server highlighting pipeline.
4. Client `EditRenderer` reuses existing `_diffHtml` rendering path; no new client-side diff parsing/highlighting logic was added.
5. Completed rows no longer get stuck on `Computing diff...`; they render one of:
   - syntax-highlighted structured diff (`_diffHtml`),
   - structured diff fallback (`_structuredPatch`),
   - raw patch fallback (`_rawPatch`),
   - stable text fallback (`Patch preview unavailable`) when no patch data is available.
6. Claude classic Edit behavior remains unchanged.

Validation summary:

1. Unit tests cover server parser/augment behavior and client completed-row fallback behavior.
2. Session `019c6b71-984f-71e0-9a27-3bcea9f8cffd` validates with no completed Edit rows missing renderable data.
