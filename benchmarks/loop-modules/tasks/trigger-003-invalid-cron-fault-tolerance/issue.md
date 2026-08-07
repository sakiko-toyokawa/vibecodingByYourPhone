# trigger-003-invalid-cron-fault-tolerance

## Background

`packages/server/src/loop/trigger/cron-scheduler.ts` must never let a malformed or invalid cron expression crash the scheduler or prevent valid loops from firing. Per phase-0 design:

- Invalid cron is parsed once, cached as unmatchable, and warned about once per loop.
- Tick failures are caught by the interval wrapper so the server stays up.
- Fired-key persistence failures are logged but do not block firing.

## Problem

We need benchmark tasks that verify:

1. Invalid cron loops are silently skipped (no throw, no fire).
2. Valid loops continue to fire when registered alongside invalid-cron loops.
3. Manual-trigger loops are ignored by the cron scheduler.

## Expected

A self-contained benchmark task with an issue description, public tests for obvious boundaries, and hidden tests for warning-once caching, corrupted persistence files, and scheduler start/stop idempotency.

## Files

- `benchmarks/loop-modules/tasks/trigger-003-invalid-cron-fault-tolerance/issue.md`
- `benchmarks/loop-modules/tasks/trigger-003-invalid-cron-fault-tolerance/public.test.ts`
- `benchmarks/loop-modules/tasks/trigger-003-invalid-cron-fault-tolerance/hidden.test.ts`

## Acceptance

- `public.test.ts` and `hidden.test.ts` both pass when run with `npx tsx --test` from the repository root.
- Public tests expose invalid-cron skipping and manual-trigger ignoring.
- Hidden tests cover one-warning-per-loop caching, persistence corruption tolerance, and scheduler lifecycle idempotency.
