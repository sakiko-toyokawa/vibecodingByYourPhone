# contract-001: Budget projection from LoopCard stop_rules

IntentContract 的 `budget` 块必须从 `LoopCard.loop.stop_rules` 投影，并遵守 02-schema契约.md §2 与 05-分阶段计划.md 阶段 2 的语义：

- `max_turns` 是总轮次上限，**含首轮**，必须 >= 1。
- `max_retries` 是 retry 次数上限，**不含首轮**，必须 >= 0。
- `max_retries` 与 `max_turns` 同时生效、先触者停，因此 `max_retries >= max_turns` 是合法的（曾经的 "max_retries 必须严格小于 max_turns" 是私加约束，已移除，见 06 偏差 #31）。
- `max_time_minutes` 必须 > 0。
- `max_tokens` 写 0：LoopCard 没有 token 预算来源，0 表示"不跟踪"，不参与停止判定。
- 非法值在 contract 构造期兜底抛出 `ContractValidationError`（正常路径 API 层已 400，这里是构造期二次校验）。

请补全 `packages/server/src/loop/contract/intent-contract.ts` 中的 `buildBudgetLimits` 与相关校验逻辑，使本任务的 public/hidden 测试全部通过。
