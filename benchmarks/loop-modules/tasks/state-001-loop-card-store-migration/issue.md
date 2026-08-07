# state-001-loop-card-store-migration

## Problem

The loop registry (`loops.json`) must follow the `SessionMetadataService` pattern specified in `docs/spec/04-存储约定.md`:

1. It carries a `version` field and a migration function chain so older registry shapes can be loaded by newer builds.
2. A corrupt or unparseable file must be backed up next to the original and the server must start with a fresh registry instead of crashing.
3. Writes must be debounced and serialized so bursts of updates do not produce interleaved or half-written files.
4. Write-back must use a temp file + atomic rename so a crash mid-write never leaves a truncated `loops.json`.

The current baseline implements these behaviors in `packages/server/src/loop/state/loop-card-store.ts`. This task captures the expected contract as tests.
