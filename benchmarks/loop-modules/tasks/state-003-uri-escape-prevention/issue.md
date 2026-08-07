# state-003-uri-escape-prevention

## Problem

Loop URIs (`artifact://`, `ledger://`, `workspace://`, `intent://`, `policy://`) are resolved to file-system paths by a single shared resolver in `loop/state/uri.ts`. Per `docs/spec/04-存储约定.md`:

1. All URI parsing must be centralized; callers must not hand-roll path concatenation.
2. File-resolvable schemes must map to deterministic paths under `loops/` or `worktrees/`.
3. Run IDs, artifact names, loop IDs, and policy profile names must be validated against a safe-name whitelist.
4. Any attempt to escape the allowed directory tree using `..`, path separators, or URL-encoded variants must be rejected with `UriResolutionError`.

The current baseline implements these behaviors in `packages/server/src/loop/state/uri.ts`. This task captures the expected contract as tests.
