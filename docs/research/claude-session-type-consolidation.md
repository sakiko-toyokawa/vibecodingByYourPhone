# Claude Session Type Consolidation

## Problem Statement

We have multiple overlapping TypeScript types for Claude session JSONL data. This creates confusion, maintenance burden, and inconsistency. We should consolidate to use the Zod-inferred types which are already validated against real data.

## Current State

### Type Inventory

| Type | Location | Purpose | Status |
|------|----------|---------|--------|
| `SessionEntry` | `shared/claude-sdk-schema/index.ts` | Zod-inferred union type for JSONL entries | **Keep - canonical** |
| `UserEntry`, `AssistantEntry`, `SystemEntry`, `SummaryEntry` | `shared/claude-sdk-schema/entry/*.ts` | Discriminated union members | **Keep - canonical** |
| `ClaudeRawSessionMessage` | `shared/session/UnifiedSession.ts` | Loose type for JSONL pass-through | **Remove - redundant** |
| `ClaudeRawContentBlock` | `shared/session/UnifiedSession.ts` | Loose content block type | **Remove - redundant** |
| `RawSessionMessage` | `server/sessions/dag.ts` | Alias for `ClaudeRawSessionMessage` | **Remove - redundant** |
| `SDKMessage` | `server/sdk/types.ts` | Streaming messages from SDK | **Review - similar shape** |
| `Message` | `server/supervisor/types.ts` | API response type | **Keep - different purpose** |
| `ContentBlock` | Multiple files (3 copies) | Content block in messages | **Consolidate** |
| `AppContentBlock` | `shared/app-types.ts` | Client content block | **Consolidate** |

### Validation Results

The Zod schemas are **99.998% accurate** against real JSONL data:

```
GRAND TOTAL: 123236/123238 lines valid across 5580 files

Errors (2 total): mock test files only
```

This means `SessionEntry` is production-ready as the canonical type.

### Why Loose Types Existed

The loose types (`ClaudeRawSessionMessage`, etc.) were created because:
1. Fear that Zod schemas might reject valid entries
2. Desire to preserve unknown fields for debugging
3. Backwards compatibility with older JSONL formats

**These concerns are now invalidated** by the 99.998% validation success rate.

## Proposed Changes

### 1. Update `ClaudeSessionFile` to use `SessionEntry[]`

```typescript
// packages/shared/src/session/UnifiedSession.ts

// Before
export interface ClaudeSessionFile {
  messages: ClaudeRawSessionMessage[];
}

// After
import type { SessionEntry } from "../claude-sdk-schema/types.js";

export interface ClaudeSessionFile {
  messages: SessionEntry[];
}
```

### 2. Remove redundant types

Delete from `shared/session/UnifiedSession.ts`:
- `ClaudeRawSessionMessage` interface
- `ClaudeRawContentBlock` interface

### 3. Update `dag.ts` to use `SessionEntry` directly

```typescript
// packages/server/src/sessions/dag.ts

// Before
import type { ClaudeRawSessionMessage } from "@yep-anywhere/shared";
export type RawSessionMessage = ClaudeRawSessionMessage;

// After
import type { SessionEntry } from "@yep-anywhere/shared";
// Use SessionEntry directly, no alias needed
```

### 4. Update exports

Remove from `shared/src/index.ts`:
- `ClaudeRawSessionMessage`
- `ClaudeRawContentBlock`

Remove from `shared/src/session/index.ts`:
- Same exports

### 5. Update downstream consumers

Files that import `RawSessionMessage` or `ClaudeRawSessionMessage`:
- `server/sessions/dag.ts`
- `server/sessions/normalization.ts`
- `server/sessions/reader.ts`

## Files to Modify

1. `packages/shared/src/session/UnifiedSession.ts` - Remove loose types, use `SessionEntry`
2. `packages/shared/src/session/index.ts` - Update exports
3. `packages/shared/src/index.ts` - Update exports
4. `packages/server/src/sessions/dag.ts` - Import `SessionEntry` directly
5. `packages/server/src/sessions/normalization.ts` - Update type usage
6. `packages/server/src/sessions/reader.ts` - Update type usage

## Future Consolidation Opportunities

After this change, consider:

1. **ContentBlock consolidation**: We have 3+ definitions of `ContentBlock`. Should use the Zod-inferred content types from `claude-sdk-schema/content/`.

2. **SDKMessage review**: `server/sdk/types.ts` has `SDKMessage` which is very similar to `SessionEntry`. May be able to unify or derive one from the other.

3. **AppMessage simplification**: `shared/app-types.ts` defines `AppMessage = SessionEntry & AppMessageExtensions`. This is the right pattern - extend the canonical type rather than redefine it.

## Testing

After changes:
1. Run `pnpm typecheck` - ensure no type errors
2. Run `pnpm test` - ensure all tests pass
3. Run `npx tsx scripts/validate-jsonl.ts --claude` - confirm validation still passes

## References

- Zod schemas: `packages/shared/src/claude-sdk-schema/`
- Validation script: `scripts/validate-jsonl.ts`
- Current loose types: `packages/shared/src/session/UnifiedSession.ts`
- DAG processing: `packages/server/src/sessions/dag.ts`
