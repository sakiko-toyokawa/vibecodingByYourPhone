# assembly-003-fail-closed-provider-guard

The `loop/assembly` layer must fail closed when a policy-enabled LoopCard targets a provider whose permission hook is not wired to enforce the policy projection.

Requirements:

- Cards with a non-manual policy and a provider outside the verified set (`claude`, `claude-ollama`, `codex`, `codex-oss`) must throw `AssemblyError` during assembly.
- `claude`, `claude-ollama`, `codex`, and `codex-oss` are accepted.
- Cards without a policy block (legacy read-only) never trigger the guard.
- `approval_mode: "manual"` never triggers the guard because it degrades to read-only behavior.
- The error message must identify the loop, its `approval_mode`, and the unsupported provider.
