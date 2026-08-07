# verification-004-per-turn-artifact-naming

## 任务目标

验证 `verify-run.ts` 的 per-turn 产物命名规则（02-schema契约.md §8.1）：

- `turn = 1` 时保持规范名（阶段 0/1 兼容）。
- `turn > 1` 时在 `.json` 扩展名前插入 `-turn<N>` 后缀，避免 retry 覆盖上一轮证据。
- 产物包括 `verification-input.json`、`verifier-reports.json`、`judgment-report.json`、`verifier-report-<phase>.json`。

## 验收标准

1. `verificationArtifactName` 对 turn 1 返回规范名。
2. `verificationArtifactName` 对 turn N（N > 1）返回 `-turnN.json` 后缀。
3. `verifyRun(..., turn: 1)` 写入规范名产物且不带 turn 后缀。
4. `verifyRun(..., turn: 2)` 写入 `-turn2` 产物，规范名文件不存在。
5. 引用返回的 artifact:// URI 与文件名一致。
