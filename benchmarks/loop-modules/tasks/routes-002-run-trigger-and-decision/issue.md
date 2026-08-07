# routes-002-run-trigger-and-decision

Implement and verify the HTTP route behavior for run triggering, querying, human decisions, and budget supplement under `packages/server/src/routes/loops.ts` and `packages/server/src/routes/runs.ts`.

## Scope

- `POST /api/loops/:id/runs` — manually trigger a run; validate shape and error codes (`404 loop_not_found`, `409 run_active`, `409 loop_archived`).
- `GET /api/runs/:id` — return run summary, current run_state, and ledger_summary; `404 run_not_found` when missing.
- `POST /api/runs/:id/decision` — human response for a `needs_human` run:
  - `approve`, `reject`, `request_changes`, `pause`;
  - `400 invalid_decision` for bad body or `request_changes` without feedback;
  - `404 run_not_found`;
  - `409 invalid_state` when the run is not in `needs_human`.
- `POST /api/runs/:id/budget` — supplement a `budget_limited` run's budget and resume it (`budget_limited → active`):
  - `400 invalid_decision` when no budget field is supplied or the merged budget is invalid;
  - `404 run_not_found`;
  - `409 invalid_state` when the run is not `budget_limited`.

## Verification

Write `public.test.ts` and `hidden.test.ts` using the real `createLoopsRoutes` and `createRunsRoutes` wired with `LoopCardStore`, `RunStateStore`, `RunLedgerStore`, `ControlPlane`, `LoopRunService`, and the benchmark `FakeSupervisor` / `createFakeEventBus` fixtures. Tests must pass on the current baseline without modifying source code.
