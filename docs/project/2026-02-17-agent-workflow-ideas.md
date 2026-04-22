# Agent Workflow Ideas (Roadmap-ish)

Date: 2026-02-17

## Context

Current workflow is intentionally simple:

- Mostly single checkout on `main`
- Sometimes multiple concurrent sessions/agents when conflict risk is low
- Occasional dedicated "committer" session to clean tree + run sanity checks + commit
- Frequent use of markdown notes/plans as external memory

Pain points:

- Session continuity across long multi-phase work
- Manual memory/copy-paste between sessions
- Large, ad-hoc markdown sprawl
- Lack of lightweight visibility into current working tree state

## Product Direction Guardrails

- Avoid "workflow religion" and hardcoded agent prototypes
- Keep sessions as the primary mental model
- Prefer optional affordances over mandatory flows
- Keep files as source of truth (especially markdown)

## Candidate Ideas

### 1. Bookmarks (Session Clone Shortcut)

Goal: speed up "clone from good context point" without UI clutter.

MVP shape:

- Add `Bookmark here` in existing message action menu (not persistent hover chrome)
- Session-level `Bookmarks` list/panel
- `Clone from bookmark` action that starts a new session from that message point
- Optional short note/title per bookmark

Why:

- Matches existing behavior (manual clone of good points)
- Minimal cognitive overhead
- No new required workflow

### 2. Markdown View (Read-first)

Goal: make existing markdown notes discoverable in-app without requiring new structure.

MVP shape:

- Project-level "Recent Markdown" list (mtime sorted)
- Basic markdown viewer (headings/code blocks/rendered text)
- Quick actions: copy path, open in editor, insert link/path into prompt
- Default filter to de-emphasize `archive/` folders

Why:

- Helps with docs/plans/tasks sprawl
- Treats existing files as first-class without forcing taxonomy

### 3. Working Tree Viewer (Read-only first)

Goal: lightweight visibility for parallel session work on `main`.

MVP shape:

- Show dirty files
- Per-file diff preview
- Optional overlap hints (recently touched by active sessions)

Why:

- Better awareness when multiple sessions are active
- Low risk if kept read-only initially

### 4. Commit Assist (Optional, later)

Goal: support "committer session" pattern without enforcing it.

Possible actions:

- Run configured sanity checks/tests
- Summarize working tree diff
- Generate commit message draft
- Optional stage+commit flow behind explicit confirmation

Why:

- Aligns with existing explicit "clean tree" behavior
- Useful but should remain optional

## Suggested Sequence (Lowest Cognitive Load)

1. Markdown view (read-first)
2. Bookmarks for clone-from-point
3. Working tree viewer (read-only)
4. Optional commit assist

## Open Questions

- Should bookmarks be project-local, global, or both?
- Should bookmark cloning include a generated context packet by default?
- How much overlap detection is useful before it becomes noise?
- Should commit-assist steps be user-configured per project?
