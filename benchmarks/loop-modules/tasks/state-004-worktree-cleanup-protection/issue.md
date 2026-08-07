# state-004-worktree-cleanup-protection

## Problem

Run worktrees live under `<dataDir>/worktrees/<loop_id>/<run_id>/`. Per `docs/spec/04-存储约定.md`:

1. Worktrees may be pruned after `cleanup_rule.max_age_days` of inactivity (default 7 days).
2. Runs in non-terminal states (`active`, `retry`, `paused`, `needs_human`) are protected: their worktrees must not be deleted even when stale, because recovery may depend on the existing directory.
3. `budget_limited` is intentionally **not** protected — recovery starts a new run, it does not reuse the old worktree.
4. Pruning must remove both the worktree directory and the `loop/<run_id>` branch.

The current baseline implements these behaviors in `packages/server/src/loop/worktree/worktree.ts`. This task captures the expected contract as tests.
