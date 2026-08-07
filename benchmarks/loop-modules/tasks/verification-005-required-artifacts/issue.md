# verification-005-required-artifacts

## 任务目标

验证 `required-artifacts.ts` 对 `LoopCard.observability.required_artifacts` 的存在性检查：

- 规范名产物存在 → 无标注。
- 规范名产物缺失 → `missing_required_artifact:<name>` 标注。
- `turn > 1` 时优先查找 `-turn<N>` 后缀变体（扩展名前插），找不到再回落规范名。
- 产物目录不可读时返回 `required_artifacts_check_unavailable`，避免全部缺失误报。

## 验收标准

1. 产物存在时返回空数组。
2. 产物缺失时返回对应 `missing_required_artifact:<name>` 标注。
3. `turnSuffixedArtifactName` 对 turn 1 保持规范名，turn > 1 正确插入后缀。
4. turn > 1 时 `-turnN` 后缀变体命中即不标注缺失。
5. turn > 1 时后缀变体不存在但规范名存在仍可命中（回落）。
6. 目录读不到时返回 `required_artifacts_check_unavailable`。
