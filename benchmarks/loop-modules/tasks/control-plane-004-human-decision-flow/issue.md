# control-plane-004: Human decision flow

Implement or verify the human-in-the-loop decision flow.

## Background

When a run reaches `needs_human`, it blocks and emits a `run-decision-required` event. A human (via `POST /api/runs/:id/decision`) can choose one of four actions:

- `approve` → transitions `needs_human` → `active`; resume signal is emitted with `human_approve` cause.
- `request_changes` → transitions `needs_human` → `active`; feedback is required and injected into the next turn; resume signal is emitted with `human_request_changes` cause.
- `reject` → transitions `needs_human` → `failed`; resolved listeners fire.
- `pause` → transitions `needs_human` → `paused`; no resume signal. Resume later via `resumePaused`.

Additionally, an active run can be paused via `pauseActive`, and a paused run resumed via `resumePaused`.

## Requirements

1. `submitDecision` validates action/feedback and performs the correct transition.
2. `request_changes` requires non-empty feedback.
3. `approve`/`request_changes` emit resume signals; `reject` emits resolved notification; `pause` does neither.
4. `pauseActive` seeds a fresh run_state if needed and transitions `active` → `paused`.
5. `resumePaused` transitions `paused` → `active` with a resume signal.

## Verification

Your implementation should pass the tests in `public.test.ts` and `hidden.test.ts`.

Run from the repo root:

```bash
npx tsx --test benchmarks/loop-modules/tasks/control-plane-004-human-decision-flow/public.test.ts
```
