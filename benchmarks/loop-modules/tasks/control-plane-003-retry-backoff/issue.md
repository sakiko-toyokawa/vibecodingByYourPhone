# control-plane-003: Retry backoff

Implement or verify retry backoff calculation and its integration with the run state machine.

## Background

When a turn fails in a retryable way and the budget allows another attempt, the control plane decides `retry`. The run service then waits before calling `beginTurn` to start the next turn.

The phase-2 backoff policy is:

- Base delay: 1 minute (`60_000` ms)
- Exponential: `delay(n) = 1min × 2^(n-1)` where `n` is the retry number (1-indexed).
- Cap: 5 minutes (`300_000` ms)

So: retry 1 → 1min, retry 2 → 2min, retry 3 → 4min, retry 4+ → 5min.

## Requirements

1. Export `retryBackoffMs(retryNumber)` implementing the formula above.
2. Export `RETRY_BACKOFF_BASE_MS` and `RETRY_BACKOFF_CAP_MS` constants.
3. A `retry` decision is recorded in the decision ledger and the run moves to the `retry` state.
4. `beginTurn` transitions `retry` → `active` and advances the turn counter.
5. Idempotency: repeated `beginTurn` calls with the same turn must not append duplicate ledger entries.

## Verification

Your implementation should pass the tests in `public.test.ts` and `hidden.test.ts`.

Run from the repo root:

```bash
npx tsx --test benchmarks/loop-modules/tasks/control-plane-003-retry-backoff/public.test.ts
```
