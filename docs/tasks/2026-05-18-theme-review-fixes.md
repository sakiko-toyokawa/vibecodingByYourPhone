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

### 2026-05-18 3

- Completed the planned low-priority cleanup pass for the follow-up set:
  - normalized toast and reload banner tones to theme tokens
  - replaced sheet/modal overlay scrims with `--bg-overlay`
  - removed remaining light-only hover/background remnants from session list rows and subagent wrappers
  - updated `ExitPlanModeRenderer`, `GlobRenderer`, and `GrepRenderer` to stop using fixed terminal/light hover colors
  - switched the settings toggle knob from a hardcoded white fill to the input surface token
- Static verification:
  - no remaining matches for the targeted fixed-color patterns from this cleanup pass
  - no unresolved `var(--...)` references under `packages/client/src`
- Environment status:
  - `pnpm.cmd typecheck` still fails with the same `EPERM` reading the local TypeScript shim

### 2026-05-18 4

- Attempted the next validation step: an actual three-theme visual sweep with browser automation.
- Added a local helper script at `workspace/theme-sweep/capture-theme-screenshots.ps1` to drive a headless browser through the DevTools protocol.
- Verified that the local app can be started and reached:
  - `http://localhost:3400` returned `200`
  - `http://localhost:3402` returned `200`
- Blocker:
  - both Chrome and Edge launched in headless mode, but none of the requested remote debugging ports (`9223`, `9224`, `9225`, `9226`) ever exposed a reachable DevTools endpoint in this environment, so automated screenshots could not be captured.
- Outcome:
  - runtime availability is confirmed
  - visual verification remains pending until a working browser automation/debugging channel is available

## Verification Notes

- `pnpm.cmd typecheck` is currently blocked by a local `EPERM` error opening the TypeScript shim under `node_modules\\.pnpm\\typescript@5.9.3\\node_modules\\typescript\\bin\\tsc`.
- Re-run after code changes in case the environment issue clears; if not, keep it recorded as an environment blocker rather than a code regression.
