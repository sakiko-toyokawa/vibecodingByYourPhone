# learning-001-pipeline-advance

## 任务目标

确保 `ProposalPipeline.advanceEligible()` 正确实现提案发布管线的自动推进：

- `draft → shadow`：旁路评估，记录 scorecard，不改装配。
- `shadow → canary`：regression 档复跑 eval 最小集，全部通过才放行。
- regression 任一失败 → `rolled_back`。
- 自动推进到 `canary` 为止；`approved` / `published` 无自动路径。

## 验收标准

1. draft 提案调用 `advanceEligible()` 后进入 `shadow`，history 记录 shadow 档。
2. shadow 提案再次调用 `advanceEligible()` 后进入 `canary`（eval 集通过时）。
3. canary 之后继续调用 `advanceEligible()` 不再自动推进。
4. regression 失败时提案进入 `rolled_back`，history 保留失败明细与 scorecard 引用。
5. shadow 档产出的 scorecard 落盘到 `loops/eval/results/`。
6. 提案 payload 真实参与评估时，history 记录 applied 槽位。
