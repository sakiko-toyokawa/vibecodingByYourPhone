# verification-001-static-runtime-command-selection

## 任务目标

验证 `loop/verification` 阶段 1 的 static / runtime 命令选择逻辑：

- LoopCard 显式钉死 `loop.verification.commands.static` / `runtime` 时，直接采用卡片命令（card-pinned）。
- 未显式钉死时，回退到 workspace `package.json` scripts 探测：
  - static 段匹配 `lint`、`typecheck` 脚本；
  - runtime 段匹配 `test` 脚本。
- 探测不到时返回空数组，由后续 verifier 报告 `inconclusive`。

## 验收标准

1. 显式 static 命令优先于 package.json 脚本；runtime 同理。
2. 无显式命令时，static 正确探测 `pnpm run lint`、`pnpm run typecheck`。
3. 无显式命令时，runtime 正确探测 `pnpm run test`。
4. 显式空数组不被脚本探测覆盖。
5. 无 package.json、scripts 缺失、package.json 损坏时返回空数组且不抛异常。
