# Theme Review Fixes

## Context

- Date: 2026-05-18
- Baseline commit: `4938e4e` (`Checkpoint current editor and client work`)
- Goal: fix theme coverage and styling drift across the Claude, Codex, and Gemini themes in `packages/client`

## Execution Plan

1. Establish baseline commit and task log.
2. Fix high-severity theme issues:
   - missing token aliases / undefined CSS variables
   - provider-style routing tied to UI theme instead of session provider
   - hardcoded styling and forced dark context in tool approval surfaces
   - editor and file-tree surfaces relying on undefined theme tokens
3. Fix medium-severity hardcoded styling in renderers, sidebar, and shared UI surfaces.
4. Run verification passes and record any remaining risk.

## Checkpoints

### 2026-05-18 1

- Baseline commit created: `4938e4e`
- Next: implement high-severity token and theme routing fixes

### 2026-05-18 2

- Completed high-severity fixes:
  - added alias tokens for newer editor/theme variable names in `packages/client/src/styles/index.css`
  - corrected provider-style routing so tool cards and edit diffs use the session provider instead of the active UI theme
  - removed forced dark renderer context from tool approval and task surfaces
  - replaced the worst hardcoded approval panel styles with theme tokens
- Completed medium-priority fixes:
  - themed fallback tool renderer and task output/task status surfaces
  - removed the main hardcoded sidebar light-only surfaces and fixed new-session buttons to use theme primary tokens
  - cleaned remaining hardcoded black/gray styling from `ToolCallRow`
- Static verification:
  - no unresolved `var(--...)` references remain under `packages/client/src`
  - `pnpm.cmd typecheck` still fails with the same local `EPERM` when Node tries to open `node_modules\\.pnpm\\typescript@5.9.3\\node_modules\\typescript\\bin\\tsc`
- Next: optional follow-up pass for lower-priority hardcoded surfaces still outside the reviewed fix set

## Verification Notes

- `pnpm.cmd typecheck` is currently blocked by a local `EPERM` error opening the TypeScript shim under `node_modules\\.pnpm\\typescript@5.9.3\\node_modules\\typescript\\bin\\tsc`.
- Re-run after code changes in case the environment issue clears; if not, keep it recorded as an environment blocker rather than a code regression.
