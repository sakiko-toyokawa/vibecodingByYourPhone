# Loop Modules Benchmark — Baseline Report

Generated against the current codebase baseline.

## Summary

| Module | Tasks | Resolved | Rate |
|---|---|---|---|
| trigger | 3 | 3 | 100.0% |
| contract | 3 | 3 | 100.0% |
| assembly | 4 | 4 | 100.0% |
| control-plane | 5 | 5 | 100.0% |
| verification | 5 | 5 | 100.0% |
| state | 5 | 5 | 100.0% |
| learning | 3 | 3 | 100.0% |
| routes | 3 | 3 | 100.0% |

**Overall:** 31/31 tasks resolved (100.0%).

## Method

- Each task has a `public.test.ts` (visible to agents) and a `hidden.test.ts` (used for scoring).
- Tests run with `npx tsx --test <file>` from the repository root.
- Scoring via `npx tsx benchmarks/loop-modules/harness/score.ts`.

## Notes

- All 31 tasks pass on the current baseline, confirming the benchmark exercises existing behavior correctly.
- The benchmark does not modify source code under `packages/`.
- Future code changes that break spec behavior will be caught by the hidden tests.
