# routes-001-loop-crud-pause-resume

Implement and verify the HTTP route behavior for loop lifecycle management under `packages/server/src/routes/loops.ts`.

## Scope

- `POST /api/loops` — create a loop from a LoopCard; validate zod schema; reject duplicates with `409 loop_exists`.
- `GET /api/loops` — list registered loops (archived loops hidden), with optional `status`/`limit`/`offset` query parameters.
- `GET /api/loops/:id` — return loop details plus current run state and last run summary; `404 loop_not_found` when missing or archived.
- `PATCH /api/loops/:id` — `pause`, `resume`, and `archive` actions and their error codes:
  - `400 invalid_action` for invalid or non-JSON bodies.
  - `404 loop_not_found` for unknown loops.
  - `409 invalid_state` when pausing a non-active run, resuming a non-paused run, operating on an archived loop, or archiving a loop that still has an active run.
- `archive` is a soft delete: the loop disappears from list/detail but its file is not deleted.
- `POST /api/loops/:id/runs` — manual run trigger; `409 loop_archived` when targeting an archived loop.

## Verification

Write `public.test.ts` and `hidden.test.ts` using the real `createLoopsRoutes` wired with `LoopCardStore`, `RunStateStore`, `RunLedgerStore`, `ControlPlane`, `LoopRunService`, and the benchmark `FakeSupervisor` / `createFakeEventBus` fixtures. Tests must pass on the current baseline without modifying source code.
