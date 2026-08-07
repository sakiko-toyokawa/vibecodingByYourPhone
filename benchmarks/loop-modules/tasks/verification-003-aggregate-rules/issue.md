# verification-003-aggregate-rules

## 任务目标

验证 `aggregate.ts` 中 `verifier_report[] → judgment_report` 的聚合规则（02-schema契约.md §6）：

- `overall` 取最差状态：`failed > inconclusive > passed`。
- `requires_human` 任一报告为 `true` 时透传为 `true`，优先级最高，决定 `next_action = needs_human`。
- `next_action` 顺序：`needs_human → complete（全 passed 且无 escalate）→ escalate → retry（failed + allowRetry + 预算未耗尽）→ stop`。
- `retryable = overall != passed && allowRetry && !budgetExhausted`。
- `evidence` 与 `unresolved_risks` 跨报告平铺。

## 验收标准

1. 单份 passed 报告 → overall passed / next_action complete / retryable false。
2. 多份报告 worst status 生效。
3. requires_human 不被其他报告的 passed 覆盖。
4. failed + allowRetry + budget 充足 → retry / retryable true。
5. retry 不允许或预算耗尽 → stop / retryable false。
6. escalate recommendation 优先级高于 complete。
7. evidence 与 unresolved_risks 跨报告聚合。
