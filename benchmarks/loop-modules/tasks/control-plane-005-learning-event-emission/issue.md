# control-plane-005: Learning event emission

Implement or verify that control-plane decisions emit learning events correctly.

## Background

The learning subsystem consumes `learning_event` records from `learning/events.jsonl` (spec `docs/spec/02-schema契约.md §8.4`). The control plane is the writer.

Emission rules:

- Emit when a transition reaches a terminal state: `complete`, `failed`, or `budget_limited`.
- Emit when a decision carries `failure_tags` (e.g. `verification_error`, `policy_error`, `runtime_blackbox_error`).
- Emission is fire-and-forget (`只发不等`): the run must continue even if the learning store fails.
- Each learning event must have a deterministic `event_id`, reference the source `run_id`/`loop_id`, record the control `decision`, the `judgment_ref`, relevant ledger refs, and `failure_tags`.

## Requirements

1. Wire a `LearningEventStore` into the control plane.
2. Emit one learning event per qualifying transition.
3. Do not duplicate events on idempotent replay.
4. Failure to append an event must not affect run progression or state persistence.

## Verification

Your implementation should pass the tests in `public.test.ts` and `hidden.test.ts`.

Run from the repo root:

```bash
npx tsx --test benchmarks/loop-modules/tasks/control-plane-005-learning-event-emission/public.test.ts
```
