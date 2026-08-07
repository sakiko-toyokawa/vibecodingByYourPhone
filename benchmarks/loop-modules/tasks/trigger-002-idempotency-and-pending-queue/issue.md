# trigger-002-idempotency-and-pending-queue

## Background

`packages/server/src/loop/trigger/cron-scheduler.ts` evaluates registered LoopCards once per minute and fires `onTrigger` for loops whose cron matches the current server-local time. Two responsibilities are central to phase-0:

1. **Idempotency**: the same loop can only fire once per firing instant (minute precision).
2. **Pending queue**: when a loop already has an active run, the trigger is queued rather than dropped, and drained later by priority (`urgent > normal > background`).

## Problem

We need benchmark tasks that verify:

- A matching loop fires exactly once per minute and again on the next minute.
- A busy loop is queued and fired when it becomes free.
- Queue ordering follows `loop.schedule.queue` priority.

## Expected

A self-contained benchmark task with an issue description, public tests for the main success path, and hidden tests for edge cases around concurrency-like behavior and persistence.

## Files

- `benchmarks/loop-modules/tasks/trigger-002-idempotency-and-pending-queue/issue.md`
- `benchmarks/loop-modules/tasks/trigger-002-idempotency-and-pending-queue/public.test.ts`
- `benchmarks/loop-modules/tasks/trigger-002-idempotency-and-pending-queue/hidden.test.ts`

## Acceptance

- `public.test.ts` and `hidden.test.ts` both pass when run with `npx tsx --test` from the repository root.
- Public tests expose idempotency, busy-loop queuing, and priority ordering.
- Hidden tests cover queue deduplication, multi-loop priority draining, restart-safe fired-key persistence, and serial-run guarantees.
