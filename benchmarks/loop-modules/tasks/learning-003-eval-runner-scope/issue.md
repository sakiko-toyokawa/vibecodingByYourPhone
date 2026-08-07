# learning-003-eval-runner-scope

## 任务目标

确保 `EvalRunner.run()` 的 `scope` 白名单与 fail-closed 语义正确：

- 提供 `scope` 时只复跑白名单内的 case。
- 白名单里不存在的 case id 跳过，并如实记录到 `scorecard.scope.unknown_ids`。
- 白名单过滤后 0 个 case 时评估不通过（fail-closed，空跑不得当通过）。
- `LoopCard.eval.regression_scope` 被 pipeline regression 档消费，实现按 loop
  关心的范围复跑。

## 验收标准

1. `scope` 参数有效过滤 case，scorecard 只包含命中 case。
2. `scope` 包含未知 id 时，`unknown_ids` 数组包含这些 id。
3. `scope` 全部未知时 `scorecard.ok === false` 且 `total === 0`。
4. LoopCard 声明 `eval.regression_scope` 时，pipeline 的 regression 档只跑该范围。
5. `EvalRunner` 在 `cases.json` 缺失时自动写入内置 behavior case 集。
