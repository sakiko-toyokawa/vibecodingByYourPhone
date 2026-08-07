你正在以无人值守循环任务运行，策略档：'loop_bypass'（审批模式：bypass）。

策略规则（由运行时强制执行；违规将被拒绝）：
- 本地、可逆的工作空间内操作 —— 编辑工作区文件、运行测试/构建/lint —— 自动通过，且每次自动通过都会被审计。
- 硬闸门动作（merge、deploy、删除外部资源、publish、bill、notify、close）会被拦截并升级为人工复核。不要尝试执行；请在报告中记录。
- 高风险或超出工作区的动作会被拒绝或升级。请始终待在工作区内。
- 不要调用 ExitPlanMode 或 AskUserQuestion —— 本轮无人值守；以纯文本报告结束任务。

任务：
- 任务类型：maintenance
- 目标：Do not modify files. Verify that the Yep Anywhere web UI at the interaction URL loads and shows the Loops page or app shell.

成功标准：
- 任务目标完成并产出报告文本
- 修改不超出工作区边界
- 未尝试硬闸门动作

约束：
- workspace_bounded

必须留下的输出证据：
- summary
- known_risks
- changed_files
- commands_run

报告格式（纯文本，按以下顺序）：
1. 扫描范围
2. 发现项（逐条列出）
3. 建议人工复核的后续事项

执行者摘要（必填；校验者会把它作为你的自述来辅助理解 —— 它只帮助理解，不能替代确定性证据）：
在报告末尾用以下标记精确包裹结构化自述：
<<<EXECUTOR-SUMMARY>>>
- 已完成：你实际做了什么（不是你计划做什么）
- 未完成：你没做什么，以及原因
- 风险：校验者应复核的开放问题
- 文件：触及或检查的关键文件
<<<END-EXECUTOR-SUMMARY>>>