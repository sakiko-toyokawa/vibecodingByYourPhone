# learning-002-meta-rule-protection

## 任务目标

确保发布管线的元规则保护生效：修改发布管线/验证层自身的提案（类型为
`verification_rule_proposal` / `eval_task_proposal`，或 target 命中
`pipeline` / `eval` / `verifier` 段）必须由人工发起；worker 自动推进时不得
将其带入管线。

同时验证 worker 会把 open 的失败模式同步为 eval 集的 golden task（只增不改）。

## 验收标准

1. worker 创建的元规则提案调用 `advanceEligible()` 后仍停留在 `draft`。
2. 人工创建的元规则提案可以正常推进到 `shadow`。
3. `isMetaRuleProposal()` 能识别元规则类型与 target。
4. 被阻挡的 worker 元规则提案在多次 `advanceEligible()` 调用后仍保持 `draft`。
5. worker 的 `syncGoldenCases()` 把 open failure pattern 转化为 eval 集的
   command case，case_id 为 `golden-<pattern_id>`，expect 为 `"fail"`。
