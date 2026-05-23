# Changelog

## [0.2.6] - 2026-05-23

### Fixed
- Bundle `fast-glob` as a direct dependency to fix desktop server startup failure on Windows. `awilix@13.0.3`'s ESM entry imports `fast-glob`, but it was missing from the bundled node_modules because pnpm keeps it as a transitive dependency.

## [0.2.5] - 2026-05-23

### Fixed
- Restore desktop voice input availability when Web Speech API is supported.
- Expose all Codex permission modes in session controls.
- Stop mixing local session actions into provider slash commands.
- Keep session loading resilient when dynamic slash command discovery fails.

## [0.2.4] - 2026-05-21

### Fixed
- Fix race condition where Node.js server process was left behind after quit, causing next launch to hang on "Starting server..."
- Add `last_pid` fallback in `kill_sync` so force-kill works even when child handle was already consumed by `stop_server`
- Add force-kill fallback in `stop_server` when graceful shutdown times out
- Add 10-second timeout protection to tray quit handler
- Add diagnostic logging to server startup for easier future debugging

## [0.2.3] - 2026-05-19

### Changed
- Bump desktop and mobile versions to 0.2.3

## [0.1.0] - Unreleased

### Added
- Initial desktop app with setup wizard
- Bundled Bun runtime for running Yep Anywhere server
- Agent installation (Claude Code, Codex CLI)
- System tray with server management
- Auto-start and window state persistence
- Auto-updater support
