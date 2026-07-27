# Loop 子系统 spec 差距与修复计划

> 来源：2026-07-26 对照 `E:/projects/loop/docs/spec`（00–06）对 `packages/server/src/loop/` 全量审计。
> 判定口径：**壳子** = 定义/写入存在但运行时无消费者、硬编码假数据、或绕过 spec 机制；**偏差** = 实现了但与 spec 语义不符；**未实现** = spec 要求但代码缺失（注明是否计划内）。

## P0 安全/正确性缺口

### 1. Codex 链路上策略引擎被整体架空【壳子·安全】✅ 已修（守卫方向）
- 证据：`sdk/providers/codex.ts:1120-1125` 把 `bypassPermissions` 映射为 `approvalPolicy: "never"` + `sandbox: "danger-full-access"`；app-server 不发 requestApproval，`loop/policy/` 的硬闸门七项、bypass 审计一行不执行。无守卫阻止 policy run 走 codex，06 偏差记录未登记。Claude 链路（`claude.ts:513-520` canUseTool）是真的。
- 修复（2026-07-26，fail-closed 守卫）：装配层拒绝——card 声明非 manual policy 且 provider 非 claude/claude-ollama 时抛 `AssemblyError`（`loop/assembly/runtime-input.ts`），run 以 setup 失败落 failed + 原因可审计，不静默产出无策略的 RuntimeInput。已登记 06 偏差 #24。测试：`runtime-input.test.ts` "policy × non-Claude bridge is fail-closed"。
- 遗留（另立任务）：Codex 桥的策略投影真正实现（approvalPolicy 改造让审批反向请求流经策略钩子 + 沙盒语义对齐），落地前不得解除守卫。

### 2. 运行账本 runtime 块硬编码假数据【壳子】✅ 已修
- 证据：`run-service.ts:1100-1112`：`runtime.adapter` 恒 `"claude"`、capability 恒 `interrupt=graceful`（与 06 偏差 #17 规定的 codex 应记 `kill-only` 矛盾）、`mode` 写的是 permissionMode 而非 runtime 原生模式。Codex run 的账本是编造值，污染阶段 3 学习输入。
- 修复（2026-07-26）：新增 `describeAdapter`（`run-service.ts`），从 card 的 provider 投影真实值——adapter=provider 名、bridge 按 00 映射（claude*=agent_sdk / codex*=app_server / gemini*=acp）、mode 为 runtime 原生模式（print/exec/acp，02 §8.1）、interrupt 如实记录（claude=graceful，其余=kill-only，06 #17）；permissionMode 移入能力快照字符串。未知 provider 按最保守口径（bridge/mode=unknown、kill-only）。测试：`run-service-verification.test.ts` codex 投影用例 + `run-service-policy.test.ts` 断言更新。
- 顺带修复：`run-service-policy.test.ts` 对 `isRunActive` 的瞬时断言是既有竞态（状态转移先于 finally 释放注册），改为轮询 `waitForInactive`。

### 3. 验证层崩溃 = 静默判过【偏差·verifier theater】✅ 已修
- 证据：`run-service.ts:993-998` verifyRun 抛错仅 console.error；`decide.ts:73-78` 随之判 `complete`，reason 误写 "card requires no verification phases"。
- 修复（2026-07-26）：catch 分支合成 `inconclusive + requires_human + escalate` 的 judgment → needs_human，错误落 `verification-error[-turnN].json` artifact 并进 judgment.evidence。测试：`run-service-verification.test.ts` "verification layer crash escalates to needs_human"。

### 4. 学习闭环不闭合【壳子】✅ 已修（最小闭环）
- 证据：worker 提案从不带 `payload`（`learning/worker.ts:447-467`）；`resolveProposalEffects` 跳过无 payload 提案（`assembly/proposal-effects.ts:72-74`）；全库无 `created_by=human` 提案创建入口。自动路径提案走完 publish 对装配零影响，阶段 3 验收 5 生产不可达。
- 修复（2026-07-26）：
  - Part A：worker 为有真实消费者的槽位生成 payload——`memory_packet_template_proposal` 携带由失败模式生成的 `memory_packet_template`（装配层注入 prompt 是真消费者）；`runtime_adapter_proposal` 明确不带（adapterPolicy 无消费者，见 #13）；`policy_profile_proposal` 不带（档名不能杜撰，走人工入口补）。
  - Part B：新增 `POST /api/proposals` 人工创建端点（`routes/proposals.ts`）：zod 校验、created_by 恒 human、status 恒 draft 由服务端钉死，创建后进既有管线（draft→shadow→canary 自动、approve/publish 人工闸门）。已登记 06 偏差 #25。
  - 附带修复"元规则保护只有一半"：人工发起的元规则提案现在有真实创建入口，可经管线推进 + 人工批准。
- 测试：`worker.test.ts` payload 生成用例（context_error → 模板携带 pattern id；runtime_adapter 不带 payload）、`routes/proposals.test.ts` 创建 201/400 用例。

### 5. 发布管线评估与提案脱钩 + eval 用例空转【壳子·verifier theater 变种】✅ 已修
- 证据：shadow/regression 复跑同一固定全局 eval 集，eval runner 从不应用提案（`learning/eval-runner.ts:197-226`）；内置用例全是 `node -e "process.exit(0/1)"`（`:124-140`）。任何提案分数相同，闸门无牙。
- 修复（2026-07-26，完整实现非最小）：
  - **behavior case 形态**：`eval-runner.ts` 整体重写，cases.json 增加 `kind: "behavior"` + 行为注册表，8 个内置 case 覆盖全部失败归因类别，每个直接调用被测子系统的真实函数——合约预算守卫（buildIntentContract 拒绝非法预算）、装配不变量（READ-ONLY/executor summary 契约）、memory packet 注入实效（提案模板真进 prompt 且硬规则不丢）、adapter 归因映射、子进程 verifier 失败/通过识别（真实子进程）、硬闸门裁决（3 项闸门 + bypass 自批准）、聚合 requires_human 透传、评估路径确定性。`command` 形态保留为用户扩展入口（历史失败样本回收入库）。
  - **提案真实应用**：`EvalRunner.run` 接收提案本体，behavior case 在评估时应用其 payload（memory_packet_template 注入装配、policy_profile 覆盖进裁决）；scorecard 新增 `applied` 块记录真实参与评估的槽位与跳过原因（adapter_policy 因 #13 无消费者记入 skipped 而非假装评估过）。
  - **管线接线**：pipeline 把提案本体传入 shadow/regression 复跑，history reason 带 `applied: ...` 摘要，"评估了什么"全程可审计。
  - 未知行为名 fail-closed per-case（尺子坏了闸门不放行，不崩溃整场）。
- 测试：eval-runner.test.ts 8 例（behavior 形态、未知行为 fail-closed、applied 槽位/跳过、policy_profile 覆盖真实进裁决）；pipeline.test.ts 新增带 payload 提案的 history applied 断言。全套件 exit=0。
- 顺带发现（记录在案）：`policy_profile` 覆盖目前只换档名标签不换规则——`profiles.ts:42-57` 无命名档注册表，`resolvePolicyProfile` 恒返回默认规则。behavior case 的闸门检查对"未来按档名分化规则"有牙，但档名注册表本身是独立任务。

## maker → checker 链路缺口（spec 02 §5 VerificationInputBundle）

当前只有 `card/contract/exitStatus/stdoutRef` 四样流到 verifier（`run-service.ts:969-979`），且 `exitStatus` 是 `ok?0:1` 伪码、`stdout.log` 只写 `finalText`（`run-service.ts:924`）。

### 6. `permission_event_refs` 恒 `[]`【壳子】✅ 已修
- 证据：`verify-run.ts:153`。02 §5 要求高风险任务必须包含；bypass 审计决策账本条目（`approval-hook.ts:58-77`）与 `policy-projection.json` 已存在，未接线。
- 修复（2026-07-26）：策略钩子每次裁决记录 `PermissionEvent`（`approval-hook.ts`），turn 结束落 `permission-events[-turnN].json` artifact 并引用进验证输入。

### 7. `policy_intent_ref` 写死 `"not_applicable"`【壳子】✅ 已修
- 证据：`verify-run.ts:160`，注释理由停留在阶段 1；turn 1 已落 `policy-projection.json`（`run-service.ts:913-919`）可引用。
- 修复（2026-07-26）：策略投影 run 传 `artifact://<runId>/policy-projection.json`；无投影时仍落显式哨兵。

### 8. `evidence_refs.diff` 恒 `null`【未实现】✅ 已修
- 证据：`verify-run.ts:145` 注释自认 "no diff capture yet"；04 要求 `diff.patch` 永久保留。
- 修复（2026-07-26）：turn 结束后 `git diff HEAD` 捕获（`captureGitDiff`，非 git 工作区/无变更 → null 不伪造），落 `diff[-turnN].patch` 并引用。

### 9. `runtime_event_refs` / `structured_output` / `stderr` / `executor_summary` 恒空【已修，stderr 除外】
- 证据：`verify-run.ts:148-152`。00 映射称 ProcessEvent `message` 为统一 trace 源，但 run 级 trace 未落 artifact。
- 修复（2026-07-26）：`watchProcess` 逐条收集轮内归一消息，落 `runtime-events[-turnN].jsonl`，同时填 `runtime_event_refs` 与 `evidence_refs.structured_output`；`executor_summary` 走 prompt 契约方案——装配层要求 executor 收尾产出 `<<<EXECUTOR-SUMMARY>>>` 标记块（`runtime-input.ts`），run-service 提取落 `executor-summary[-turnN].md` 并引用，未产出标记块时为 null 不伪造。
- 遗留：`stderr` 仍为空——`ProcessEvent` 联合类型（`supervisor/types.ts:223-234`）没有 stderr 通道，各 provider 读到 stderr 只写日志（`codex.ts:482-485`、`remote-spawn.ts:437-444`），需 adapter 底座改造（与"Codex 无优雅 interrupt"同类），应登记 06 偏差。

### 10. `known_failure_patterns` 恒 `[]`【壳子】✅ 已修
- 证据：`verify-run.ts:161`；`failure-pattern-store.ts` 存在且 worker 在写，验证层从不读。
- 修复（2026-07-26）：`LoopRunService` 注入 `FailurePatternStore`（app.ts 同一单例，只读），open 模式 id 投影进验证输入。

### 11. 多轮验证产物 latest-wins 覆盖【偏差】✅ 已修
- 证据：`run-service.ts:949-954` 注释自认；历史轮账本条目的 `artifact://` 引用悬空。
- 修复（2026-07-26）：验证产物经 `verificationArtifactName` 按轮命名（turn 1 保持规范名，turn N>1 带 `-turnN` 后缀）；stdout/runtime-events/diff/permission-events 同步按轮命名。

### 12. collector 冒名 review 段、升级信号被丢弃【壳子/偏差】✅ 已修
- 证据：`run-service.ts:1332-1436`：CollectorReport 不进 `aggregateVerifierReports`，`requires_human` 落地即丢（`:1423`）；`CollectorReportSchema`（`verification.ts:105-115`）是 spec 外私造 schema，冒用 "review" 段名，未登记 06。
- 修复（2026-07-26）：card 的 verifier_chain 声明 `review` 时，collector 报告转成 review 段 verifier_report 经 `verifyRun` 的 `reviewReport` 入聚合（落 per-turn `verifier-report-review.json`，requires_human 按 02 §6 透传生效）；未声明 review 的卡维持证据级 merge（collector 仅采集不判定）。已登记 06 偏差 #33（CollectorReport 为 review 报告内部超集）。测试：`verify-run.test.ts`（真报告参与聚合 + requires_human 透传 + 落盘非占位）。

## 后续加深（2026-07-26 第二批，超出本清单的"最小实现"项）

- **memory packet 真机制**（原"二档最小"）：run-service 从失败模式账本取本 loop 相关 open 模式（occurrence 前 5）构建确定性摘要注入装配 prompt，落 `memory-packet.json` artifact，`input_refs.memory_packet` 如实引用（不再恒 null）；重启续跑轮引用 turn 1 原件。已登记 06 #34。测试：`run-service-verification.test.ts`（prompt 含账本摘要 + artifact + 账本引用）。
- **eval golden tasks**（原"二档最小"）：learning worker 每 tick 把 open 失败模式衍生为 `golden-<pattern_id>` command case 同步进 eval 集（钉死验证命令复跑，expect=fail 如实记录，修复转绿后人工翻转 expect=pass 完成基线更替；只增不改）。已登记 06 #34。测试：`worker.test.ts`（衍生入集 + 二次 tick 不重复）。
- **RuntimeInputBundle 结构化（02 §3）**：`execution_contract` 五字段结构化（goal/scope/success_criteria/constraints/required_output——constraints 与 required_output 随之进 prompt，修复"constraints 从不读"），`native_invocation`（describeAdapter 移至 `loop/assembly/adapter-info.ts` 共用投影，timeout_seconds 仅 adapter_policy 提供）、`observability` 如实声明（stderr/transcript 记 false）、`budget_remaining`（首轮全量，续跑轮从 run_state 快照算剩余）；turn 1 落 `runtime-input-bundle.json` + `prompt.md`（context_injection.prompt_ref 引用）。已登记 06 #35。测试：`runtime-input.test.ts`（五字段/投影/超时）、`run-service-verification.test.ts`（bundle + prompt 落盘）。
- **policy 命名档注册表**：`profiles.ts` 新增 `NAMED_PROFILES`——`resolvePolicyProfile(card, nameOverride?)` 按档名解析真实规则差异（risk_rules/hard_gates/bypass_scope），`policy_profile_proposal` 覆盖从"只换标签"变成真换行为；首批 `loop_strict_review`（medium 升级 review_or_policy、本地命令不自批准），未注册档名回落默认值。eval `hard_gate_enforced` 与装配层共用注册表，strict 档 regression 真实拦截。已登记 06 #36。测试：`runtime-input.test.ts`（strict 规则差异 + 未注册回落）、`eval-runner.test.ts`（strict → 闸门 fail + write verdict=hard_gate；默认档 → 放行）。

## P1 接口/字段级壳子

### 13. `RuntimeInput.adapterPolicy` 全链路无消费者【壳子】✅ 已修
- 证据：`runtime-input.ts:72,217-218,252` 写入后 run-service / adapter / Supervisor 均不读。`runtime_adapter_proposal` 发布后纯记账。
- 修复（2026-07-26，完整消费链）：
  - 新增 `loop/assembly/adapter-policy.ts` `resolveAdapterPolicy`：自由键值解析成两个真实旋钮——`model`（模型覆盖）与 `timeout_seconds`（轮次超时，02 §3"adapter 调用必须带超时"）；未知键/类型不符进 `ignoredKeys`，不静默吞掉。
  - run-service 消费：`executeTurn` 把 model 覆盖进 session settings、timeoutMs 进 `watchProcess` 新增的轮次超时（超时按 adapter 硬错误 timeout 归因 runtime_blackbox_error，杀进程不无限等待）；collector 同为 adapter 调用，同等应用（挂死的 collector 不得挂死 run）；账本能力快照记录 `adapterPolicy[model=…,timeout_seconds=…]` 及 `ignored=` 未消费键。
  - worker：`runtime_blackbox_error` 提案现在携带 `adapter_policy.timeout_seconds=600`（保守起点，经管线+人工闸门生效）。
  - eval-runner：新增 `adapter_policy_application` behavior 与第 9 个内置 case，`adapter_policy` 槽位从 applied.skipped 转为真实参与评估。
- 测试：`run-service-verification.test.ts` 两例（model 覆盖到达 session settings + 快照记录；timeout_seconds=0.05 杀掉永不发声的轮 → failed + runtime_blackbox_error）；worker/eval-runner 套件同步更新。全套件 exit=0。

### 14. `budget_limited → active` 恢复路径生产不可达【壳子】✅ 已修
- 证据：`supplementBudget`（`control-plane.ts:763-818`）有实现有测试，无任何 HTTP 路由调用；03 也未定义端点。budget_limited 实际等于终态。
- 修复（2026-07-26）：新增 `POST /api/runs/:id/budget`（`routes/runs.ts`）：zod 校验（至少一项 max_* 字段），经 runService.getRun 解析 loop_id 后调 `supplementBudget`；错误语义 400 invalid_decision / 404 run_not_found / 409 invalid_state。已登记 06 偏差 #26。测试：`routes/runs.test.ts` 两例（200 active + resumed 落账 + 重复补充 409；404/400）。

### 15. WS 事件 `loop-budget-warning` 整体缺失【未实现】✅ 已修
- 证据：`EventBus.ts:289-310` 联合类型无此项，全库零引用；03 已定义 80% 阈值告警。
- 修复（2026-07-26）：`EventBus.ts` 新增 `LoopBudgetWarningEvent`（字段按 03：turns/max_turns、retries/max_retries、near_limit）；control-plane 在 applyJudgment 预算累计（含 retry 扣减）后按 ≥80% 阈值发射，内存 Set 去重一次/run/字段。测试：`control-plane.test.ts`（阈值下不发、max_turns/max_retries 两字段各自发射、载荷字段）。

### 16. `GET /api/loops/:id` 详情硬编码 null【壳子】✅ 已修
- 证据：`routes/loops.ts:121-125` `current_run_state: null, last_run_summary: null`；controlPlane 已注入同工厂，注释借口（"control-plane 后续阶段"）已过时。
- 修复（2026-07-26）：`current_run_state` 接 `controlPlane.getRunState`（run_state 持久化记录），`last_run_summary` 取 `runService.listRuns` 最新一条；deps 缺席时退化为 null（phase-0 挂载兼容）。测试：`routes/proposals.test.ts`（接线值 + 无 run 时如实 null）。

### 17. 触发排队机制纯壳子【壳子】✅ 已修
- 证据：`schedule.queue`（urgent/normal/background，`loop-card.ts:107`）零消费者；scheduler 忙时直接丢弃点火（`cron-scheduler.ts:112-114`）。05 阶段 0 列了"去重队列"但后续阶段对 trigger 再无排期。
- 修复（2026-07-26）：`cron-scheduler.ts` 实现真队列——到期 loop 按 `schedule.queue` 优先级排序点火（urgent > normal > background，缺省 normal）；run 活跃时不再丢弃，进待触发队列（每 loop 至多一条去重、纯内存与"重启不补跑"取舍一致），后续 tick 按优先级补点（cron 不再匹配也补）；同一 tick 内补点与新到期不重复点火。测试：`cron-scheduler.test.ts` 三例（优先级顺序、忙时入队空闲补点且去重、pending 按优先级 drain）。

### 18. 停止规则双壳子【壳子】✅ 已修（repetition 段）
- 证据：`contract.stop_rules`（`intent-contract.ts:42-60`）构造侧从不写入（`:111-134`）、control-plane 从不读取；`stop_on_repeated_failure`（`loop-card.ts:39`）同样无消费者。"同一失败重复 N 次即停"运行时不存在。
- 修复（2026-07-26）：
  - 投影：`buildIntentContract` 把 card 的 `stop_on_repeated_failure` 投影为 `contract.stop_rules.repetition.max_same_failure`（safety/ambiguity 段机制未建，不投影）。
  - 消费：control-plane `applyJudgment` 新增停止规则判定——同一阻断指纹的 needs_human 计数（既有 blocker_fingerprint / repeated_blocker_count 机制）超过 `max_same_failure` 时打断循环，needs_human → 终态 failed，reason 注明命中规则（预算与停止规则.md："同一 verifier 同一错误重复 → 停止或人工"）。
  - run-service 把 `contract.stop_rules` 传入 applyJudgment。
- 测试：`intent-contract.test.ts`（投影/未声明不投影）；`control-plane.test.ts`（同一阻断 3 轮：前 2 轮 needs_human、第 3 轮 failed + 无 stopRules 对照组第 3 轮仍 needs_human；人工恢复用 request_changes——submitDecision 对重复阻断拒绝空 approve，两个机制互补：决策侧防空批准，停止规则侧打断无限循环）。
- 遗留：`stop_rules.safety.stop_on_policy_block`（硬闸门已一律升级 needs_human，语义已覆盖）与 `ambiguity.max_clarification_turns`（澄清机制未建）仍不消费，属机制未建而非壳子。

### 19. 其余无消费者字段【壳子】✅ 已修（真消费 + 钉状态挂账）
- 修复（2026-07-26）：
  - `failure_pattern.status = resolved` 真消费：worker 每轮 tick 把 published 提案的 source_patterns 标记 resolved（幂等；回滚不重开，复发按签名重新入账）。
  - `appliedProposals` 真消费：进账本能力快照 `;proposals=a|b`（哪个 run 吃了哪份提案可审计）。
  - 钉状态挂账（06 偏差 #27，不删除与 spec 文本一致的字段，注释钉死待回填）：`PolicyProfile.permission_bridge`、`LoopCard.eval` 块、`persistence.state_file` + `.loop/STATE.md` 投影、`schedule.resume_rule`、Trigger 枚举 `webhook`/`resume`。
  - `confidence=1` / `requires_clarification=false` / verifier confidence 三档 / verifier `requires_human=false`：确定性构造器与确定性 verifier 的诚实常量，非壳子，06 #27 一并钉注。

### 20. 恒值假数据【壳子】✅ 已修（实质项）
- 修复（2026-07-26）：
  - run `source` 谎报 cron → `RunLedgerEntrySchema` 新增可选 `source`（06 偏差 #28），写入实记（`ctx.active.source`），listRuns/rebuildContext 读取（旧条目回退 "cron"）。
  - `policy_projection.sandbox` 写死 `"workspace-write"` → 如实记 `"none"`（06 #24 守卫后策略 run 只在 Claude 桥，无 OS 沙盒，写边界由策略钩子强制）；allowed/disallowed_tools 空数组注释说明设计（钩子即规则来源）。
  - 其余恒值项见 #19 钉注（诚实常量不修）。

### 21. 失败归因来源过窄【偏差】✅ 已修
- 证据：failure_tags 只来自 adapter 硬错误（`control-plane.ts:428-430`、`adapter-error.ts:99-110`）；8 值权威词汇中 5 值（intent_error、context_error、memory_packet_error、verification_error、eval_regression）生产不可达。
- 修复（2026-07-26）：control-plane 新增 `attributeFailureTags` 统一挂载——adapter 硬错误（既有映射）、硬闸门/高风险策略拦截 → `policy_error`、judgment overall failed/inconclusive（含验证层自身崩溃的合成 judgment）→ `verification_error`，Set 去重。`intent_error`/`context_error`/`memory_packet_error` 需要 verifier 侧归因分类能力、`eval_regression` 由 eval 体系自产，均无生产信号不伪造（记录在案）。
- 行为变化（语义正确）：retry/needs_human 决策现在带 failure_tags，按"终态或带 failure_tags 的决策"条件发射 learning_event——重复验证失败成为 worker 的真实学习输入（worker 按 run 去重，同一 run 的重试失败只计一次）；verification_error 模式生成 verification_rule_proposal，按元规则保护停 draft 待人工（尺子不自改，设计使然）。
- 测试：`control-plane-learning.test.ts` 两例语义更新（retry/needs_human 带 verification_error 发射）+ 两例新增（三类信号组合去重、passed 无标签）。全套件 exit=0。

## P2 契约/存储偏差

### 22. API 形状偏差【已修主项】
- 修复（2026-07-26，06 偏差 #30 裁决）：
  - `GET /api/runs/:id` → `{ run, run_state, ledger_summary }`：补 run_state（02 §7 快照），撤掉全量账本暴露（03 决策三为准；05 验收 3"读回完整账本"由 readUri 文件解析满足）；前端本就不用 ledger 字段，无破坏。
  - `GET /api/loops`：保留全 StoredLoop（前端渲染依赖，06 #30 登记），补 `status?`（paused/active/idle）与 `limit?`/`offset?`。
  - `GET /api/loops/:id/runs`：补 `state?` 7 枚举过滤（非法值 400 invalid_state）。
  - `POST /api/loops/:id/runs`：`intent_overrides` 接上（zod strict 校验，handoff 本轮覆盖 task/default_task_type/max_items_per_run，不写回注册表）。
- 遗留：`loop-state-changed` 用 `timestamp` vs 03 的 `updated_at`（06 #32 同批登记，以实现为准）；409 错误码 invalid_state vs not_waiting（06 #8 已登记）。

### 23. 存储约定偏差【已修主项】
- 修复（2026-07-26）：
  - **统一 `resolveUri`**：新增 `loop/state/uri.ts`（04 URI 解析表全部 scheme，白名单防 `..` 逃逸）；`RunLedgerStore.readUri` 让 artifact:// 与 ledger://（含 decision- 变体）真实可读——引用不再只写不读。测试 `uri.test.ts`（路径映射、逃逸拒绝、真实读取）。
  - **清理/保留策略落地**：新增 `loop/state/cleanup.ts`——每 loop 最近 20 轮完整账本、过期压缩为仅 run_ledger_entry 行；artifacts 随账本裁剪（终态 run 永久保留 judgment-report/diff 最小证据，per-turn 命名兼容）；events.jsonl 消费位点前 30 天截断（cursor 前移）；非终态 run 全程保护（先扫 state/*.json）。learning worker 顺带驱动（04 指定），`cleanupIntervalMs` 默认 1h 节流；`RunLedgerStore.compressLedgerToRunEntries`/`artifactsDirFor`、`LearningEventStore.truncateConsumedBefore` 支撑。测试 `cleanup.test.ts` 三例（压缩+裁剪+证据保留、活跃保护、events 截断 cursor 前移）。
  - **state/<loop_id>.json 容错加固**（`run-state-store.ts`）：坏文件备份 `.corrupt-<ts>`（不再静默当不存在）、per-file 串行写链（applyJudgment 与 pause/resume 并发不再读-改-写交错）。
  - **loops.json 加载逐条 `LoopCardSchema` 校验**（与 failure-patterns store 同口径，坏文件备份从空开始）。
  - **proposals 目录位置**（`loops/learning/proposals/` vs 04 的 `loops/proposals/`）：不改名，已连同 artifact per-turn 命名、账本压缩口径一并登记 06 偏差 #29。

### 24. spec 未回写的实现偏差【已修主项】
- 修复（2026-07-26，06 偏差 #31）：删除三处私加的 `max_retries < max_turns` refine（shared BudgetSchema、IntentContractSchema.budget、LoopCardSchema.stop_rules）——spec 只有"同时生效、先触者停"，相等合法；supplementBudget 校验同步放宽，eval behavior `contract_budget_guard` 改为断言预算投影正确性。
- 其余 schema 扩展（decision_entry/run_state/learning 三件套/LoopCard 扩展块/canary-only approve/publish by:human/proposal_type/canUseTool 挂载点）此前已逐批登记 06（#8/#9/#13/#14/#15/#20/#23/#28/#32）。

### 25. 其他偏差【已修两项，余者留档】
- 修复（2026-07-26）：
  - **验证短路规则**（四段验证模型.md）：verify-run 在某段硬失败后跳过后续段（后续结果不改变聚合结论），跳过段写 not_applicable 并注明 short-circuited 原因；测试覆盖（static 失败 → runtime 不执行且无输出日志；static 通过 → runtime 正常执行）。
  - **run 级 trace correlation 载体**：run_state 新增 `session_ref`（06 偏差 #32），control-plane 每轮写入，GET /api/runs/:id 的 run_state 携带——前端可按 03 设计订阅对应 session 消息流。
- 留档（独立任务，非壳子）：~~workspace 边界对 Bash 的写目标检查~~（已修，06 #37，见下）；02 §3 native_invocation 整段（已由 06 #35 落地）；cron 幂等键持久化（已修，06 #38，见下）；模型清单外置（评估后不另做：loop 侧已有 `card.loop.runtime.model` 与 adapter_policy.model 两条真实通道，provider 回退清单属交互式选择器内部细节，06 #38 登记）；full_auto 与 assisted 语义分化（风险模型.md 层问题）；legacy 分支丢失 github env（github_prompt 卡无 policy 时拿不到 GH_TOKEN，实际路径都带 policy）；execution contract 结构化五字段（已由 06 #35 落地）。
- 追加（2026-07-26 第三批）：**Bash 命令通道 workspace 边界**——`classify.ts` 启发式提取写目标（重定向/tee/cp/mv/rsync/install/dd of=/sed -i/node -e 内联绝对路径），越界按 write+high 分类，`node -e "fs.writeFileSync('/etc/...')"` 类逃逸不再被 bypass 自批准（06 #37）。测试：`classify.test.ts` 三例（越界各形态、workspace 内不误报、无上下文不启用）。
- 追加（2026-07-26 第四批）：**cron 点火键持久化**——`<loop_id>:<分钟戳>` 幂等键落 `loops/trigger/cron-fired.json`（原子写、容错加载、只保留本分钟键），重启后同一分钟内不重复点火；tick 改 async（06 #38）。测试：`cron-scheduler.test.ts`（跨实例幂等 + 次分钟正常点火）。

## 计划内未做（不算壳，记录备查）

webhook/issue/resume 触发源；interaction/review 两段验证（05 阶段 1/2 明确不做）；YAML 权威格式加载；工作区隔离 worktree（05 阶段 2 明确不做）；eval 版本对比面板（05 阶段 3 从简）。

## spec 自身矛盾（需回 spec 仓库处理）

- 03"全量账本不经 API 暴露" vs 05 阶段 0 验收 3"能读回完整账本"
- 01/00 要求 webhook/issue/resume 触发，05 从未排期
- trigger 排队列在阶段 0 清单但后续阶段再无排期（壳子按现计划永远不会被填）

## 真实冒烟验证（2026-07-26，dev server + 真实 codex runtime）

**Codex 桥策略投影（06 #39，本轮新增）**：`policyHookWired`（钩子经 ModelSettings.toolApprovalHook → Supervisor → StartSessionOptions 透传）时 codex thread policy 映射为 `on-request + read-only`，一切变更经审批反向请求到 loop 策略钩子；装配守卫放开 codex/codex-oss，legacy（无 policy）github_prompt 分支补 GH_TOKEN/gh PATH 注入。单测/集成全绿。决定性端到端（真实 fileChange 审批请求被钩子裁决）**被本机 codex 账号余额阻断**（app-server 报 403 INSUFFICIENT_BALANCE）——接线各段已验，真实裁决待有余额环境复验。

**冒烟二次发现（已记录，未修）**：executor 因 403/空产出结束时，run 仍被判 complete（finalText 空 + static lint 通过 → judgment passed）——验证层缺"executor 无产出"信号，空 stdout 应让结论倾向 inconclusive 而非看命令退出码判过。留待后续（与 verification_error 归因分类一起设计）。

在真实 server（dist 直跑）上以 codex provider 完成端到端 run 验证：
memory packet 注入 prompt 并落 artifact、native_invocation 真实投影（adapter=codex/bridge=app_server/mode=exec，快照 `interrupt=kill-only` 与 06 #17 一致）、budget_remaining、verification-input 的 known_failure_patterns 与 runtime_event_refs 真实填充、账本 source 如实、learning events 落盘、eval 内置 9 个 behavior case 在生产数据目录播种成功。

**冒烟抓到的真 bug（已修）**：
1. **同 loop 第二个 run 必崩**：run_state 按 loop 存储，上个 run 的终态记录被当作新 run 的 from-state → `IllegalTransitionError: complete -> complete` 且 run 静默失败（表面还显示上个 run 的 complete，极具迷惑性）。修复：applyJudgment 只在 `existing.run_id === input.runId` 时沿用 from-state 与预算快照，否则从 active/合约预算重起（`control-plane.ts`，测试 `control-plane.test.ts` "stale terminal record"）。
2. **GET /api/runs/:id 显示串台**：活跃 run 首个判定落账前，run_state 展示的是上个 run 的记录。修复：run_state 的 run_id 与请求不符时返回 null（`routes/runs.ts`，测试 `routes/runs.test.ts`）。

环境备忘（非代码问题）：本机 claude SDK 的 cli.js 路径解析与 codex 经 cmd.exe 的 spawn 在该 shell 环境下失败（00 短板表"Claude CLI 检测是假实现"的实证）；workspace.path 必须是 Windows 路径（MSYS `/tmp` 形式会导致 spawn cwd ENOENT）；codex runtime 路径下全链路验证通过。

## 问题与解决方案总结（全过程）

### 审计方法
8 个并行审计代理对照 spec（00–06）逐模块核对，判定分四档：已实现 / 壳子（有定义无消费者、硬编码假数据、绕过 spec 机制）/ 偏差 / 未实现（注明是否计划内）。每条判定带文件:行号证据。最恶劣的三类壳子：机制全真但首尾不接（学习闭环）、假数据（账本 runtime 块）、兜底方向反了（验证崩溃判过）。

### 修复过程中遇到的真实问题与解法

| 问题 | 解法 |
|---|---|
| Codex 桥 `approvalPolicy:"never"` + `danger-full-access` 让策略引擎整段失效（最严重安全缺口） | 不做半吊子 codex 适配，装配层 fail-closed：policy × 非 Claude 桥直接拒绝（06 #24），真适配另立任务 |
| 验证层自身崩溃 = 静默判过（verifier theater） | catch 分支合成 `inconclusive + requires_human` judgment 升级人工，错误落 artifact——判不清给机器不如给人 |
| 学习闭环"机制全真、效果空转"（提案无 payload、eval 不应用提案、用例空转） | worker 按类型生成 payload + 人工创建端点；eval 重写为 behavior case（调用真实子系统函数）+ scorecard.applied 记录"评估了什么" |
| `policy_profile` 覆盖只换标签不换规则（profiles 无注册表） | NAMED_PROFILES 注册表，档名解析出真实规则差异；eval 的 strict 档 regression 真拦截成为有牙证据 |
| `node -e fs.writeFileSync('/etc/...')` 借 medium 档被 bypass 自批准 | classify 启发式提取写目标（重定向/tee/cp/mv/dd/sed -i/内联绝对路径），越界按 write+high（宁漏不误） |
| 冒烟：同 loop 第二个 run 必崩且伪装成成功 | applyJudgment 只在 run_id 匹配时继承 from-state/预算快照（run_state 按 loop 存储的设计陷阱） |
| 冒烟：GET /api/runs/:id 展示上个 run 的 run_state | run_id 不符返回 null |
| `isRunActive` 瞬时断言全套件负载下 50% 抖动（既有竞态） | 状态转移先于 finally 释放注册是设计时序，测试改轮询 `waitForInactive` |
| spec 内部张力（03"账本不开放"vs 05"读回完整账本"；私加 max_retries<max_turns） | 不回代码猜口径，回 spec 裁决登记（06 #30/#31），再按裁决改代码 |

### 环境类问题（非代码，但影响本机运行）

| 问题 | 解法/备忘 |
|---|---|
| claude SDK 的 cli.js 解析与 codex 经 cmd.exe 的 spawn 在本机 shell 失败（00 短板"Claude CLI 检测是假实现"的实证） | claude 链路暂不可用（无 token 也无需再试）；codex 链路可用 |
| workspace.path 用 MSYS `/tmp` 形式 → spawn cwd ENOENT | **workspace.path 必须写 Windows 路径**（`C:/...`） |
| 后台任务 kill 只杀父进程，tsx 子进程残留占端口导致 EADDRINUSE | 重启前先 `taskkill //PID <pid> //T //F`，确认端口空了再起 |
| `YEP_ANYWHERE_DATA_DIR=/tmp/...` 在 Windows 被映射到 Temp 目录 | 数据目录直接用 Windows 路径，避免 MSYS 路径歧义 |

### 方法论沉淀
- **"壳子"的四个信号**（审计时按此查）：配置/枚举定义了但运行时无消费者；类型在但运行时写编造值；接口在但数据没接线；兜底方向反了（故障路径比正常路径更宽松）。
- **修壳子优先接线而不是新建**：本过程 80% 的修复是把已有的真机制接到真实消费者上（payload、permission events、失败模式回流、注册表解析），而不是写新代码。
- **eval 的牙 = 能检出被测对象的真实行为差异**：空转用例（exit 0/1）让管线形式上 fail-closed、实质上无牙——behavior case + applied 记录是解法模板。
- **冒烟 > 单测**：两个最高危 bug（complete→complete、状态串台）单测全绿也漏，真实环境第二轮必现。

## 代办（backlog）

### 轮次挂起治理：空转检测与死循环检测（替代硬超时）

背景：2026-07-27 用户决策——**轮次不设默认硬超时**（曾设 5min/15min 默认值，太绝对：真实只读扫描常需 5-10min，一刀切会误杀健康轮次、丢弃已完成报告、白烧一轮重试；实证见 run-20260727T142618Z-8d6db6de turn 1）。当前行为：仅 `adapter_policy.timeout_seconds` 显式配置时才计时，否则轮次可以无限运行。挂起风险用下面两项治理，不做固定计时。

- [ ] **空转检测（idle watchdog）**：watchProcess 已逐条收集 runtime events——以"最后一条消息的时间"为活性信号，N 分钟（建议 10min，可配）无任何消息才判挂起 → 杀轮 + failed（归因 timeout/idle）。与硬超时的本质区别：只要在持续产出（思考、读文件、写报告）就永远不误杀，杀的是真正卡死的进程。
- [ ] **死循环检测（loop stagnation）**：轮次级——连续 N 轮 stdout/报告内容高度相似（哈希或相似度）或同一 blocker fingerprint 重复（`repeated_blocker_count` 已有雏形），提前转 needs_human 而不是烧完 max_turns；轮内级——executor 在同一文件/命令上反复空转（事件流模式识别）可作为后续增强。
- [ ] **配套**：`adapter_policy.timeout_seconds` 保留为显式兜底（02 §3 adapter 调用必须带超时的合规出口）；前端 Stream Output 已有实时事件流，可在 UI 上直接显示"最后活动于 X 分钟前"，让人一眼识别空转。

### 验证工作区隔离：worktree 策略落地 ✅ 已实现（2026-07-27）

背景：2026-07-27 实证（run-20260727T150455Z-a40e562e turn 1）——loop 的 verifier 在 `direct` 策略下直接对工作区跑 `pnpm typecheck`，撞上开发者正在编辑的中间状态（TS2554: 参数数量不一致），误判 failed 并白烧一次 retry。executor 报告本身没问题，是"验证读的是活目录"这个架构弱点。

实现（本提交）：
- `loop/worktree/worktree.ts`：`ensureRunWorktree`（run 级 worktree 集中在 `<dataDir>/worktrees/<loop_id>/<run_id>`，从主仓库 HEAD 拉 `loop/<run_id>` 分支；同 run 全 turn 复用、重启后目录仍在天然恢复；非 git 仓库 AssemblyError fail-closed）+ `pruneStaleWorktrees`（开机清理超期 7 天的目录与分支）。
- `run-service.resolveExecutableCard(card, runId)`：worktree 策略在此把 `workspace.path` 改写为 worktree 目录——assembly / executor / verifier / diff 取证零改动获得隔离；证据落 `workspace.json` artifact 并引用进 turn 1 artifact_refs。
- 创建期校验：POST /api/loops 带 worktree 策略但 path 缺失/非 git 仓库 → 400。
- UI：创建表单加工作区策略下拉（direct / worktree），详情页 worktree 徽章。
- 06 偏差登记：worktree 实体目录集中在 dataDir（spec 未定位置，Yep 扩展决策）。
- 测试：worktree.test.ts 3 例（创建/复用/清理）、run-service-worktree.test.ts（cwd 隔离 + 证据落账、创建期 400）、loopCardBuilder 策略映射。

### 合并闸门（merge gate）✅ 已实现（2026-07-27，接续 worktree）

闭环：隔离执行 → 验证 → 报告 → **人工确认 → 才进主目录**。

- 判过拦截：worktree + policy(modify) 的 run 验证通过且 worktree 有改动时，judgment 改写为 `needs_human`（requires_human 透传，02 §6 人工优先），证据落 `merge-gate.json`（origin/worktree 路径、分支、基线 SHA、turn）；无改动则直接 complete，不空转人工。
- 批准合并：POST /runs/:id/decision approve → `continueRun` 识别 merge-gate（gate.turn 与 run_state 对齐才触发，防旧 gate 误伤）→ `mergeRunWorktree`（worktree 未提交改动先落 loop 分支 → 原仓库 `merge --no-ff`；冲突 abort 并判 failed，worktree 保留人工处理）→ `controlPlane.settleMerge` 终局（active → complete/failed，证据 merge-result.json）。
- 拒绝合并：reject → failed（改动不进原仓库）；request_changes → 正常开下一轮继续改。
- 测试：approve 合并入 origin / reject 不进 / 无改动直 complete（run-service-worktree.test.ts 3 例）。

遗留（仍在 backlog）：
- [ ] 过渡方案（更便宜）：verifier 运行前记录工作区 `git status`/HEAD，验证失败且工作区在验证期间发生过变动时，在 judgment evidence 里标注"工作区非稳定状态，结果可能失真"，供人工分辨真失败与环境噪音。（direct 策略仍有价值）
- [ ] UI 提示：loop 详情页对 `direct` 策略的 loop 显示"验证直接作用于工作区"的提示，让使用者知道跑 loop 期间别在同一目录大改代码。

### active run 的重启恢复（开机接管在飞 run）

背景：2026-07-27 实证（run-20260727T150455Z-a40e562e）——paused run 的重启恢复已修（b8b51b3），但 **active 态的 run 在服务器重启后无人接管**：runTurns 随进程死亡，run_state 停在 active/retry，开机没有任何扫描把它捞起来；界面回退显示账本里最后一轮的 final_status（如 "retry"），看起来永远卡住；首轮在飞时甚至连账本/run_state 都没有，run 直接消失（run-20260727T153203Z-cffdae0e）。当天两次实证均为开发模式下用户按 UI 的 Reload / Ctrl+Shift+R（该快捷键是重启后端而非刷新页面）触发。

- [ ] 开机恢复扫描：服务启动时遍历 run_state，对 state=active/retry 且有 run_id 的记录，按 rebuildContext 重建上下文并续跑（等价于 resume）；首轮在飞（无 run_state）的 run 无从恢复，应在操作侧避免（见下）。
- [ ] 重启防护：POST /server/restart 在有 active run 时返回 409 + 提示先暂停（或先自动暂停所有 active run 再重启，重启后自动 resume——已有 pause/resume 原语可组合）。
- [ ] UI 警示强化：ReloadBanner 的 "N active sessions will be interrupted" 对 loop run 场景写明"正在运行的 loop 会被杀死且无法恢复"；考虑把 Ctrl+Shift+R 从"重启后端"改为仅刷新前端（用户肌肉记忆 = 浏览器硬刷新，误杀率高）。
