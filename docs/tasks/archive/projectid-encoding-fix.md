# ProjectId Encoding Fix Plan

> **Status**: Planning
> **Priority**: High - Recurring bug source
> **Estimated Phases**: 4

## Problem Statement

The codebase has two different encodings for project identification, both confusingly called "projectId":

| Encoding | Format | Example | Reversible | Used In |
|----------|--------|---------|------------|---------|
| **Base64url** | URL-safe base64 of absolute path | `L2hvbWUva2dyYWVobC9jb2RlL2NsYXVkZS1hbnl3aGVyZQ` | Yes | URLs, API, client |
| **Directory** | Slash-to-hyphen + optional hostname | `-home-kgraehl-code-claude-anywhere` or `hostname/-home-...` | No (lossy) | File paths in ~/.claude/projects/ |

Both are `string` types with identical names, making it impossible to catch mismatches at compile time. This has caused **at least 5 bugs** where one format is incorrectly compared to the other.

## Known Bugs (as of 2025-12-30)

### Bug 1: useSessions.ts - File change path matching (FIXED)
- **File**: `packages/client/src/hooks/useSessions.ts:55` (was)
- **Issue**: Compared base64url `projectId` from URL against directory-format `relativePath`
- **Status**: Fixed by matching on sessionId instead

### Bug 2: useSession.ts - Overly broad sessionId matching
- **File**: `packages/client/src/hooks/useSession.ts:225`
- **Code**: `if (!event.relativePath.includes(sessionId))`
- **Issue**: `.includes()` can match partial strings (session "test" matches path containing "latest")
- **Risk**: False positives triggering unnecessary refetches

### Bug 3: ExternalSessionTracker - Wrong projectId format in events
- **File**: `packages/server/src/supervisor/ExternalSessionTracker.ts:238-249`
- **Issue**: `emitStatusChange()` emits events with directory-format `projectId`
- **Impact**: Client `handleSessionStatusChange` filters by base64url projectId, so events never match

### Bug 4: routes/projects.ts - Mixed formats in activity counting
- **File**: `packages/server/src/routes/projects.ts:32-58`
- **Issue**: Same `Map` stores counts keyed by both formats
- **Impact**: External session counts always show as 0

### Bug 5: useSessions.ts - Status change filtering
- **File**: `packages/client/src/hooks/useSessions.ts:75-76`
- **Code**: `if (event.projectId !== projectId) return;`
- **Issue**: Compares directory-format `event.projectId` (from ExternalSessionTracker) with base64url `projectId` (from URL)
- **Impact**: External session status changes never update the UI

## Solution: Branded Types

Use TypeScript branded types to make format mismatches a compile-time error.

### Core Types (packages/shared)

```typescript
// Branded type pattern - values are still strings at runtime
// but TypeScript treats them as distinct types
export type UrlProjectId = string & { readonly __brand: "UrlProjectId" };
export type DirProjectId = string & { readonly __brand: "DirProjectId" };

// Type guards for runtime validation
export function isUrlProjectId(value: string): value is UrlProjectId {
  // Base64url uses only [A-Za-z0-9_-]
  return /^[A-Za-z0-9_-]+$/.test(value);
}

export function isDirProjectId(value: string): value is DirProjectId {
  // Directory format starts with hyphen or hostname
  return value.startsWith("-") || /^[a-zA-Z0-9.-]+\//.test(value);
}

// Constructors with validation
export function toUrlProjectId(absolutePath: string): UrlProjectId {
  return Buffer.from(absolutePath).toString("base64url") as UrlProjectId;
}

export function fromUrlProjectId(id: UrlProjectId): string {
  return Buffer.from(id, "base64url").toString("utf-8");
}

// Note: DirProjectId cannot be decoded - it's lossy
// Must look up via scanner.getProjectBySessionDirSuffix()
```

### Event Types Update

```typescript
// Before: projectId could be either format
interface SessionStatusEvent {
  projectId: string;  // Ambiguous!
}

// After: Explicit about which format
interface SessionStatusEvent {
  projectId: UrlProjectId;  // Always base64url for client consumption
}
```

---

## Implementation Phases

### Phase 1: Add Branded Types to Shared Package

**Goal**: Create the type infrastructure without breaking anything.

**Files to modify**:
- `packages/shared/src/index.ts` - Export new types
- `packages/shared/src/projectId.ts` - New file with types and utilities

**Tasks**:
1. Create `packages/shared/src/projectId.ts` with branded types
2. Add type guards and constructors
3. Export from `packages/shared/src/index.ts`
4. Add tests in `packages/shared/test/projectId.test.ts`

**Verification**:
```bash
pnpm -F shared build
pnpm -F shared test
```

---

### Phase 2: Migrate Server to Branded Types

**Goal**: Update server code to use branded types, fixing bugs in the process.

**Files to modify**:
| File | Changes |
|------|---------|
| `packages/server/src/projects/paths.ts` | Update `encodeProjectId` return type to `UrlProjectId` |
| `packages/server/src/supervisor/types.ts` | Re-export branded types |
| `packages/server/src/supervisor/Supervisor.ts` | Type `projectId` fields as `UrlProjectId` |
| `packages/server/src/supervisor/ExternalSessionTracker.ts` | **Fix Bug 3**: Convert dir→url before emitting events |
| `packages/server/src/watcher/EventBus.ts` | Update event types to use `UrlProjectId` |
| `packages/server/src/routes/projects.ts` | **Fix Bug 4**: Use consistent key format |
| `packages/server/src/projects/scanner.ts` | Add method to convert DirProjectId → Project |

**Key Fix in ExternalSessionTracker**:
```typescript
// Before (Bug 3)
private emitStatusChange(sessionId: string, projectId: string, status: SessionStatus) {
  // projectId is directory format here!
}

// After
private async emitStatusChange(sessionId: string, dirProjectId: DirProjectId, status: SessionStatus) {
  // Convert to URL format before emitting
  const project = await this.scanner.getProjectBySessionDirSuffix(dirProjectId);
  if (!project) return;

  const event: SessionStatusEvent = {
    projectId: project.urlId,  // Now correctly typed as UrlProjectId
    // ...
  };
}
```

**Verification**:
```bash
pnpm -F server build
pnpm -F server test
pnpm typecheck
```

---

### Phase 3: Migrate Client to Branded Types

**Goal**: Update client code to use branded types.

**Files to modify**:
| File | Changes |
|------|---------|
| `packages/client/src/types.ts` | Import and use `UrlProjectId` |
| `packages/client/src/hooks/useSession.ts` | **Fix Bug 2**: Use exact match instead of `.includes()` |
| `packages/client/src/hooks/useSessions.ts` | **Fix Bug 5**: Types will now match |
| `packages/client/src/hooks/useFileActivity.ts` | Update event type definitions |

**Key Fix in useSession.ts (Bug 2)**:
```typescript
// Before (Bug 2)
if (!event.relativePath.includes(sessionId)) {
  return;
}

// After - exact match on filename
const filename = event.relativePath.split("/").pop();
const fileSessionId = filename?.replace(".jsonl", "");
if (fileSessionId !== sessionId) {
  return;
}
```

**Verification**:
```bash
pnpm -F client build
pnpm -F client test
pnpm typecheck
```

---

### Phase 4: Add Runtime Validation & Documentation

**Goal**: Add defensive checks and document the pattern for future developers.

**Tasks**:

1. **Add runtime validation at API boundaries**:
   ```typescript
   // In route handlers, validate incoming projectId
   const projectId = c.req.param("projectId");
   if (!isUrlProjectId(projectId)) {
     return c.json({ error: "Invalid project ID format" }, 400);
   }
   ```

2. **Update CLAUDE.md** with guidance:
   ```markdown
   ## Project ID Formats

   This codebase has TWO project ID formats. Always use the correct type:
   - `UrlProjectId` - For URLs, API, client state (base64url encoded)
   - `DirProjectId` - For file system paths (slash-to-hyphen, lossy)

   Never compare these directly. Use `scanner.getProjectBySessionDirSuffix()`
   to convert from DirProjectId to a Project with both formats.
   ```

3. **Add ESLint rule** (optional) to warn on `projectId: string` in event types

**Verification**:
```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
```

---

## File Change Summary

### New Files
- `packages/shared/src/projectId.ts`
- `packages/shared/test/projectId.test.ts`

### Modified Files (by phase)

**Phase 1** (shared):
- `packages/shared/src/index.ts`

**Phase 2** (server):
- `packages/server/src/projects/paths.ts`
- `packages/server/src/projects/scanner.ts`
- `packages/server/src/supervisor/types.ts`
- `packages/server/src/supervisor/Supervisor.ts`
- `packages/server/src/supervisor/ExternalSessionTracker.ts`
- `packages/server/src/watcher/EventBus.ts`
- `packages/server/src/routes/projects.ts`
- `packages/server/src/app.ts`

**Phase 3** (client):
- `packages/client/src/types.ts`
- `packages/client/src/hooks/useSession.ts`
- `packages/client/src/hooks/useSessions.ts`
- `packages/client/src/hooks/useFileActivity.ts`

**Phase 4** (docs/validation):
- `CLAUDE.md`
- Route handlers (validation)

---

## Testing Strategy

Each phase should pass these checks before proceeding:

```bash
# After each phase
pnpm typecheck          # No type errors
pnpm lint               # No lint errors
pnpm test               # Unit tests pass
pnpm test:e2e           # E2E tests pass (after Phase 3)
```

### Manual Testing Checklist

After Phase 3, verify these scenarios work:

- [ ] Start a new internally-managed session → title updates from "Untitled"
- [ ] External session detected → appears in session list with correct status
- [ ] External session status changes → UI updates in real-time
- [ ] Project list shows correct active session counts (owned + external)
- [ ] File changes in session → triggers refetch only for that session

---

## Rollback Plan

If issues are found after deployment:

1. The branded types are compile-time only - no runtime behavior change
2. Types can be aliased back to `string` if needed: `type UrlProjectId = string`
3. Each phase is independent - can revert individual phases

---

## Future Improvements

Once branded types are in place, consider:

1. **Nominal types** with a runtime tag for even stronger guarantees
2. **Zod schemas** for API validation that produce branded types
3. **Code generation** for event types to ensure consistency
