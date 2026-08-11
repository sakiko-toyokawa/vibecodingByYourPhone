# PR Draft: open-multi-agent/open-multi-agent #488

## Title

`test(create-oma-app): isolate runtime tests from ambient OMA_MODEL`

## English PR Body

```markdown
## Summary

`packages/create-oma-app/tests/runtime.test.ts` restored selected environment
variables after each test, but it did not clear an inherited `OMA_MODEL` before
each test. When the invoking shell already defines `OMA_MODEL`, the Ollama
fallback and empty-model-list paths read that ambient value instead of the value
controlled by the test, producing `2 failed / 1 passed`.

This change adds a `beforeEach` hook that deletes `process.env.OMA_MODEL` before
each test. The existing `afterEach` hook still captures and restores the caller's
original environment, so the ambient value is preserved outside the focused
suite.

Fixes #488

## Reproduction

Before this change:

```powershell
$env:OMA_MODEL = 'ambient-model'
npm run test -w create-oma-app -- runtime.test.ts
```

Result: 2 failed, 1 passed.

After this change, the same command passes all 3 tests, and the suite also passes
when run without an ambient `OMA_MODEL`.

## Motivation

The focused runtime suite must be deterministic regardless of environment
variables inherited from the invoking shell. The existing test already restores
the original environment after each test, but that is not enough to prevent a
parent-shell `OMA_MODEL` from leaking into the Ollama fallback cases before the
test starts.

## Scope and impact

- Affected workspace: `create-oma-app`
- Changed file: `packages/create-oma-app/tests/runtime.test.ts`
- Production behavior: none
- Public API: none
- Dependency changes: none
- Compatibility or migration impact: none
- Security or privacy impact: none
- Intentional non-goals: no runtime, template, CLI, other workspace, CI,
  release, or security changes

## Validation

Commands run on Windows PowerShell:

```text
git diff --check
npm run lint -w create-oma-app
npm run test -w create-oma-app -- runtime.test.ts
$env:OMA_MODEL='ambient-model'; npm run test -w create-oma-app -- runtime.test.ts
npm run build -w create-oma-app
```

Results:

- `git diff --check`: clean
- `npm run lint -w create-oma-app`: passed
- `npm run test -w create-oma-app -- runtime.test.ts`: 3 passed
- Ambient `OMA_MODEL` focused run: 3 passed
- `npm run build -w create-oma-app`: passed
- Full `npm run test -w create-oma-app`: 30 passed, 1 pre-existing Windows path
  separator failure in `template-inputs.test.ts` (`src/server.ts` vs
  `src\server.ts`)
- `npm run typecheck:template -w create-oma-app`: pre-existing Windows runner
  failure, `spawnSync tsc ENOENT`; direct `.\node_modules\.bin\tsc.cmd --version`
  succeeds

CI remains the source of truth for the full Node 20/22/24 and Linux pre-merge
matrix.

## Checklist

- [x] Tests were added or updated for changed behavior
- [x] User-facing documentation and examples were updated, or this is not
  applicable
- [x] Compatibility, breaking changes, and migration requirements are
  documented, or this is not applicable
- [x] Dependency changes are justified and preserve the package ownership
  boundaries documented in CONTRIBUTING, or no dependency changes were made
```
