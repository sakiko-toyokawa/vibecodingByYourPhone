# contract-003: Read-only vs write-capable contract shapes

`LoopCard.loop.policy.approval_mode` 决定 `buildIntentContract` 生成只读合约还是可在工作区内做有边界修改的合约（05-分阶段计划.md 阶段 2 "policy projection"）：

- 无 `policy` 块，或 `approval_mode === "manual"`：只读形状
  - `constraints` 含 `"read_only"`
  - 无 `handoff.task` 时 `raw_goal` 生成 `"Loop '<id>' read-only scan"`，并追加 discovery source/query
  - `task_type.primary` 默认 `"read_only_report"`
  - `outcome` / `success_criteria` 体现只读扫描，禁止写改动
- `approval_mode !== "manual"`（如 `"bypass"`）：可写形状
  - `constraints` 含 `"workspace_bounded"`，不含 `"read_only"`
  - `handoff.task` 优先作为 `raw_goal`；否则生成 `"Loop '<id>' task"`
  - `task_type.primary` 默认 `"maintenance"`
  - `outcome` / `success_criteria` 允许在工作区内做有边界修改，但禁止 merge/deploy/delete/publish/bill/notify/close 等硬闸门动作
- `handoff.max_items_per_run` 若存在，应作为额外 constraint（如 `"max_items_per_run=10"`）。
- `stop_rules.stop_on_repeated_failure` 若存在，投影到 `stop_rules.repetition.max_same_failure`；未声明时 `stop_rules` 整体缺席。
- `source` 映射：`"cron"` 保持 `"cron"`，其它（如 `"manual"`）映射为 `"ui"`。

请补全 `packages/server/src/loop/contract/intent-contract.ts` 中的 `buildIntentContract` 形状分支与 stop_rules 投影，使本任务的 public/hidden 测试全部通过。
