# routes-003-proposal-approve-publish-rollback

Implement and verify the HTTP route behavior for improvement-proposal lifecycle management under `packages/server/src/routes/proposals.ts` and the loop-scoped proposal list under `packages/server/src/routes/loops.ts`.

## Scope

- `POST /api/proposals` — human-created proposal starts as `draft`; `created_by` is forced to `"human"`; invalid body returns `400 invalid_proposal`.
- `GET /api/proposals/:id` — proposal details plus auditable history.
- `POST /api/proposals/:id/approve` — canary → approved; `404 proposal_not_found`; `409 invalid_transition` from wrong status.
- `POST /api/proposals/:id/publish` — approved → published; request body must carry `{ "by": "human" }` or the route returns `403 human_required`; `404 proposal_not_found`; `409 invalid_transition` from non-approved status.
- `POST /api/proposals/:id/rollback` — any non-terminal status → `rolled_back`; terminal statuses cannot roll back (`409 invalid_transition`); history is preserved.
- `GET /api/loops/:id/proposals` — list proposals whose `target` starts with `<loop_id>.` or whose `payload.canary_loops` includes the loop; `404 loop_not_found`.
- Worker-created meta-rule proposals cannot be approved or published (use `ProposalStore` to seed these). Attempts return `403 meta_rule_requires_human`.

## Verification

Write `public.test.ts` and `hidden.test.ts` using the real `createProposalsRoutes` (and `createLoopsRoutes` for the loop-scoped list) wired with `LoopCardStore`, `ProposalStore`, and the benchmark `createFakeEventBus` fixture. Use the `ProposalStore` directly to seed proposals in states that the HTTP routes cannot create (e.g., worker-authored or pipeline-advanced statuses). Tests must pass on the current baseline without modifying source code.
