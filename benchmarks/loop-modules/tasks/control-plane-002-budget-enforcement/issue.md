# control-plane-002: Budget enforcement (max_turns / max_retries / tokens / time)

Implement or verify budget-aware control decisions in the loop control plane.

## Background

The run's `Budget` snapshot is maintained in `run_state` and drives stop decisions. Semantics (from `docs/spec/02-schema契约.md §2` and `loop-engineering/control-plane/预算与停止规则.md`):

- `max_turns` includes the first turn; `used_turns` is completed turns.
- `max_retries` excludes the first turn; `used_retries` counts retry decisions.
- `max_turns` and `max_retries` are both enforced, whichever is exhausted first stops the run (`先触者停`).
- `max_tokens == 0` means token budget is untracked.
- Time budget is also re-checked at turn start (`beginTurn`).

## Requirements

1. `applyJudgment` accumulates per-turn usage (`used_turns`, `used_tokens`, `used_time_minutes`) and increments `used_retries` on a `retry` decision.
2. A retryable failure with exhausted budget becomes `budget_limited`, not `retry`.
3. `beginTurn` checks remaining turn/time/token budget before starting the next turn and transitions to `budget_limited` if exhausted.
4. `supplementBudget` raises `max_*` limits and resumes a `budget_limited` run back to `active`.

## Verification

Your implementation should pass the tests in `public.test.ts` and `hidden.test.ts`.

Run from the repo root:

```bash
npx tsx --test benchmarks/loop-modules/tasks/control-plane-002-budget-enforcement/public.test.ts
```
