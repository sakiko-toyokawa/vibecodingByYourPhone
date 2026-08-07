# state-005-proposal-store-transitions

## Problem

Improvement proposals are stored as individual JSON files under `loops/learning/proposals/<proposal_id>.json`. Per `docs/spec/02-schema契约.md §8.5` and `04-存储约定.md`:

1. Proposals must start in `draft` status.
2. Only legal status transitions are allowed:
   - `draft → shadow | rejected`
   - `shadow → canary | rejected | rolled_back`
   - `canary → approved | rejected | rolled_back`
   - `approved → published | rolled_back`
   - `published → rolled_back`
3. Every transition must be appended to an auditable `history` with stage, actor (`by`), and reason.
4. The proposal index must be rewritten atomically on every change.
5. Corrupt proposal files must be backed up and skipped during initialization, never crashing the store.

The current baseline implements these behaviors in `packages/server/src/loop/state/proposal-store.ts`. This task captures the expected contract as tests.
