# trigger-001-cron-matching

## Background

The loop trigger module includes a minimal 5-field cron matcher (`packages/server/src/loop/trigger/cron-matcher.ts`) used by the in-process scheduler. It parses expressions such as `* * * * *`, `*/5`, ranges, lists, and steps, and matches them against a JavaScript `Date` interpreted in server-local time.

## Problem

We need benchmark tasks that verify the matcher correctly:

1. Parses standard cron syntax (wildcards, steps, ranges, lists).
2. Matches dates according to local-time minute/hour/day/month/weekday.
3. Rejects malformed or out-of-range expressions with a distinguishable error.

## Expected

A self-contained benchmark task with an issue description, public tests for the main success path, and hidden tests for edge cases.

## Files

- `benchmarks/loop-modules/tasks/trigger-001-cron-matching/issue.md`
- `benchmarks/loop-modules/tasks/trigger-001-cron-matching/public.test.ts`
- `benchmarks/loop-modules/tasks/trigger-001-cron-matching/hidden.test.ts`

## Acceptance

- `public.test.ts` and `hidden.test.ts` both pass when run with `npx tsx --test` from the repository root.
- Public tests expose parsing, matching, and invalid-expression boundaries.
- Hidden tests cover day-of-week aliasing, combined field restrictions, whitespace, and a broad invalid-expression matrix.
