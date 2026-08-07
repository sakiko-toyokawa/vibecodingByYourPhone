# assembly-001-native-invocation-shape

Implement the `native_invocation` projection in `loop/assembly`.

A `RuntimeInputBundle` must carry a `native_invocation` object that reflects the provider's real bridge and runtime mode, without confusing the two layers:

- `claude` / `claude-ollama` → `adapter=claude`, `bridge=agent_sdk`, `surface=sdk`, `mode=print`
- `codex` / `codex-oss` → `adapter=codex`, `bridge=app_server`, `surface=json_rpc`, `mode=exec`
- Unknown providers still produce a record (`bridge=unknown`) for legacy read-only runs.
- `cwd_ref` must be `workspace://<loop_id>`.
- `resume_ref` is always `null` for the turn-1 bundle.
- `timeout_seconds` is `null` unless a published/canary `runtime_adapter_proposal` supplies a positive `timeout_seconds` via `payload.adapter_policy`.

Do not mix `bridge` and `mode`.
