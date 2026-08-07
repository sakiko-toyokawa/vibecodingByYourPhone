# state-002-run-ledger-serialization

## Problem

The run ledger (`runs/<run_id>.jsonl`) is an append-only JSONL file where each line is a self-contained typed entry. Per `docs/spec/04-存储约定.md` and `02-schema契约.md §8`:

1. `run_ledger_entry` and `decision_entry` share one file and are distinguished by a `type` field.
2. Entries must be schema-validated before writing.
3. Appends to the same run file must be serialized so lines never interleave.
4. Readers must skip corrupt or unparseable lines without crashing, and `readEntry` must return the latest valid `run_ledger_entry`.

The current baseline implements these behaviors in `packages/server/src/loop/state/run-ledger-store.ts`. This task captures the expected contract as tests.
