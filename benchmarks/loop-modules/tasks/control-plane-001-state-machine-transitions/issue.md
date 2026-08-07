# control-plane-001: 7-state run-state transition table

Implement or verify the run-state machine transition table for the loop control plane.

## Background

The control plane manages run lifecycle through a deterministic 7-state machine. The authoritative transition table is defined in `loop-engineering/control-plane/状态机.md` and `docs/spec/02-schema契约.md §7`:

- `active` → `complete`, `retry`, `needs_human`, `paused`, `failed`, `budget_limited`
- `retry` → `active`
- `needs_human` → `active`, `failed`, `paused`
- `paused` → `active`
- `budget_limited` → `active`
- `complete`, `failed` are terminal (no outgoing edges)

## Requirements

1. Provide/export a constant transition table (`RUN_STATE_TRANSITIONS`) keyed by every `RunState` value.
2. Provide `isLegalTransition(from, to)` and `assertLegalTransition(from, to, context)` helpers.
3. `assertLegalTransition` must throw an `IllegalTransitionError` for disallowed transitions; illegal transitions must not mutate persisted state or ledger entries.
4. The table must match the 7-state enum exactly.

## Verification

Your implementation should pass the tests in `public.test.ts` and `hidden.test.ts`.

Run from the repo root:

```bash
npx tsx --test benchmarks/loop-modules/tasks/control-plane-001-state-machine-transitions/public.test.ts
```
