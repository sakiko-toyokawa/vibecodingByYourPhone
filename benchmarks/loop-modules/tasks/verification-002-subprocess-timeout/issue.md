# verification-002-subprocess-timeout

## 任务目标

验证 `subprocess-verifier.ts` 的确定性子进程执行与超时行为：

- 命令退出码 0 → verifier report `passed`。
- 命令退出码非 0 → verifier report `failed`，recommendation `retry`。
- 命令执行时间超过 `timeoutMs` 时被强制终止，report 为 `inconclusive`，recommendation `escalate`。
- 命令不存在或无法启动时 → `spawn_failed` / `inconclusive`（不可运行，不误判为失败）。
- 多命令按最差状态聚合（`failed > inconclusive > passed`）。

## 验收标准

1. `runCommand` 在超时后返回 `kind: "timeout"` 且 `exitCode: null`。
2. `runVerificationCommands` 对超时命令产出 `status: "inconclusive"`、`recommendation: "escalate"`。
3. 自定义 `timeoutMs` 被实际使用（短超时即可触发）。
4. 不存在的命令返回 `spawn_failed`，经 verifier 后变为 `inconclusive`。
5. 混合结果中 `failed` 覆盖 `inconclusive` 与 `passed`。
