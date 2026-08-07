# Loop Modules Benchmark

A SWE-bench style benchmark for the Yep Anywhere `loop` subsystem. Each task targets one module defined in `docs/spec/01-架构.md`:

- `trigger`
- `contract`
- `assembly`
- `control-plane`
- `verification`
- `state`
- `learning`
- `routes`

Every task contains:

- `issue.md` — problem statement in GitHub-issue style.
- `public.test.ts` — tests visible to the agent for local debugging.
- `hidden.test.ts` — tests used during evaluation.

## Run a single task

```bash
npx tsx --test benchmarks/loop-modules/tasks/<task-id>/public.test.ts
npx tsx --test benchmarks/loop-modules/tasks/<task-id>/hidden.test.ts
```

Or via the harness:

```bash
npx tsx benchmarks/loop-modules/harness/run-task.ts <task-id>
```

## Run all tasks

```bash
npx tsx benchmarks/loop-modules/harness/run-all.ts
```

## Score

```bash
npx tsx benchmarks/loop-modules/harness/score.ts
```

## Add a task

1. Create `benchmarks/loop-modules/tasks/<module>-<NNN>-<short-name>/`.
2. Add `issue.md`, `public.test.ts`, `hidden.test.ts`.
3. Append a line to `benchmarks/loop-modules/tasks.jsonl`.
4. Verify both test files pass against the current baseline.

## Design notes

- Tests use the Node built-in test runner and `node:assert/strict`.
- Integration tests use shared fixtures in `benchmarks/loop-modules/fixtures/`.
- No source code under `packages/` is modified by the benchmark itself.
