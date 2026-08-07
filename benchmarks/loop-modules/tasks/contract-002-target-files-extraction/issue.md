# contract-002: target.files heuristic extraction

IntentContract 的 `target.files` 应从 `handoff.task` 自由文本中启发式提取相对路径形态的候选（02-schema契约.md §2）：

- task 是自由任务描述，LoopCard 没有精确的文件/符号来源，因此只能做形态匹配。
- 候选 token 必须含 "/" 且以扩展名结尾（如 `packages/server/src/loop/run-service.ts`、`src/foo/bar.tsx`）。
- 剥离 token 首尾的常见标点（引号、反引号、逗号、句号、括号、中文标点等）后再判定。
- 结果去重，最多保留 20 个。
- 丢弃 POSIX 绝对路径（以 `/` 开头）、Windows 盘符路径（含 `:`）、含 `..` 的父目录逃逸。
- `symbols` 不填：自由文本里无法可靠区分符号名与普通单词，宁缺不伪造。
- 一个候选都提不到时，`target` 字段整体缺席（optional 字段如实缺省，不伪造）。

请补全 `packages/server/src/loop/contract/intent-contract.ts` 中的 `extractTargetFiles` 与 `buildIntentContract` 的 target 装配逻辑，使本任务的 public/hidden 测试全部通过。
