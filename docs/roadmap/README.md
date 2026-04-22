# Roadmap

Planned features for yepanywhere, prioritized by user value and competitive gaps.

## Priority Features

### 1. Git Worktrees
**Gap:** emdash, Conductor, HAPI, Codex App all have this

Create isolated git worktree per session:
- Option on session create: "Use isolated worktree"
- Auto-creates branch: `git worktree add -b session-{id}`
- Session metadata tracks worktree path
- Cleanup on archive/delete (or manual)

**Value:** Run multiple agents on same repo without conflicts.

---

### 2. Git Status & Diff Viewer
**Gap:** Most competitors have this

Show working tree state for session's repo:
- `git status` summary (staged, unstaged, untracked)
- File tree of changed files
- Click file → see diff (unified or side-by-side)
- `git diff main...HEAD` to see all changes vs base branch

**Value:** See what agent changed without leaving the UI.

---

### 3. Diff Commenting
**Gap:** Claude Desktop has this

Click line in diff → add comment → becomes message to session:
- Comment encodes file path + line numbers
- Sent as user message: "In `src/foo.ts:42-45`: Why did you remove the null check?"
- Agent can respond and potentially fix

**Value:** Code review workflow without copy-pasting line numbers.

---

### 4. Basic Git Operations
Commit and push from the UI:
- Stage files (checkbox per file)
- Commit with message
- Push to remote
- Create PR (via `gh pr create`)

**Value:** Complete the git workflow without terminal.

---

### 5. Scheduling / Cron
**Gap:** Codex App has "automations"

Trigger sessions on schedule or events:
- Cron expression: "Run every morning at 9am"
- Initial prompt: "Check for dependency updates and create PRs"
- Permission mode preset
- History of scheduled runs

**Value:** Automated maintenance tasks, daily reviews.

---

### 6. Signed Installer (Tauri)
**Gap:** Codex App, Claude Desktop, emdash, Conductor all have installers

See [desktop-app.md](desktop-app.md) for full design.

**Value:** Reach users who won't touch npm/CLI.

---

### 7. Polish Codex/Gemini Support
Finish experimental provider support:
- [ ] Gemini ACP: Wire up "allow always" / remember choice
- [ ] Codex OSS: LMStudio model detection
- [ ] Better error messages when CLI not installed
- [ ] Hide unsupported features per provider (thinking toggle, slash commands)

**Value:** Multi-provider is a differentiator; make it solid.

---

## Not Planned

Features competitors have that we're skipping:

| Feature | Why Not |
|---------|---------|
| **Terminal page** | Agent runs commands; redundant |
| **Voice commands** | Niche; phone keyboard is fine for supervision |
| **Cloud execution** | Requires infrastructure; users can self-host |
| **Compare agent outputs** | Multi-agent orchestration is complex; defer |

## Last Updated

2026-02-03
