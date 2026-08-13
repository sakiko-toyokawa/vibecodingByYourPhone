# 多輪 Agentic Loop 重構計劃（github_prompt loop 死鎖根治）

> **交接說明**：本文件是可直接執行的重構任務書。讀者是執行改造的 coding agent。
> 所有行號以 2026-08-13 的工作區為準（最近相關提交 `5088375`，2026-08-11），
> 若行號漂移，按符號名搜索定位。開始前請先閱讀倉庫根目錄 `AGENTS.md` 與 `CLAUDE.md`。
>
> **執行紀律**：
> - 最小改動，不順手重構無關代碼；註釋風格跟隨所在文件（該子系統大量使用中文註釋）。
> - 每完成一個 Phase 跑該 Phase 列出的驗證命令，全綠再進下一 Phase。
> - 不準留下 `// ... rest unchanged` 之類的半成品；每個修改寫完整。
> - schema 變更必須向後兼容（zod `.default()` / `.nullable()`），舊 artifact 可解析。

---

## 0. 問題一句話診斷

系統的 **run 層**（turn-loop、續跑、checkpoint、planner 多輪拆分）已進化到多輪 agentic 架構，
但**驗證層、狀態層、人工閘門、預算模型、UI 預設**五處仍停留在「單輪、workspace 根即項目根、
驗證即跑測試」的舊假設。兩個時代的設計疊加，導致 **UI 預設建立的 GitHub prompt loop 在數學上
不可能自主完成**：每一輪都以 `needs_human` 收場，且人工批准後原路再撞，直到 watchdog 強殺。

設計方向（已確認，不可推翻）：**task 由 agent 自己拆分（planner），多輪執行是目標架構**。
`max_items_per_run: 1` 的單輪一次性設計已被否定。本計劃的一切修改以「讓 agent 自主拆分 +
多輪執行成立」為綱。

---

## 1. 完整因果鏈（代碼證據）

以下每一步都給出文件與行號。這是 bug 的完整機制，重構方案逐條對應。

### 1.1 UI 預設把 static/runtime 塞進 github_prompt 卡

- `packages/client/src/lib/loopCardBuilder.ts:39-40` — `DEFAULT_LOOP_CREATE_FORM`：
  `verifyStatic: true, verifyRuntime: true`。
- `packages/client/src/pages/LoopsPage.tsx:685-705` — 兩個勾選框對所有 loop kind 渲染，
  沒有 `kind === "workspace"` 門檻。
- `packages/client/src/lib/loopCardBuilder.ts:87-90` — `required` 數組在 kind 分支**之前**構建，
  `github_prompt` 分支（`:134-156`）原樣繼承 → UI 建立的 GitHub loop 恒帶
  `verification.required: ["static", "runtime"]`。

### 1.2 GitHub loop 的 workspace 是空殼，project type 永遠 unknown

- `packages/server/src/loop/run/workspace.ts:75-76` — GitHub loop 的 workspace 只是
  `mkdir` 出來的空目錄 `<dataDir>/github-workspaces/prompt-loops/<loopId>`。
- `packages/server/src/loop/assembly/runtime-input.ts:248` — prompt 明確指示 agent
  「把选中的仓库克隆到它的**子目录**中」。
- `packages/server/src/loop/verification/project-type.ts:31-46` — `detectProjectType` 只查
  **根目錄**的 `package.json` / `Cargo.toml` / `go.mod` / `pom.xml` / `requirements.txt`。
- 後果：**這不是只有 turn 1 的問題**。即使後續輪 clone 了倉庫，標記文件也在
  `<root>/<repo>/` 下，根級探測**永遠**回 `unknown`。
- 連帶：`packages/server/src/loop/run/turn-loop.ts:633-643` 的 `captureGitDiff(workspacePath)`
  對非 git 的 managed 根目錄恒回 `null` → diff 證據也永遠缺失。

### 1.3 Fail-closed：unknown → UnverifiedLanguageStrategy

- `packages/server/src/loop/verification/strategy-selector.ts:72-88` — 無 card 釘死命令、
  project type 為 unknown → 直接回 `UnverifiedLanguageStrategy`。
- `packages/server/src/loop/verification/strategies/unverified-language.ts:14-27` — 回
  `status: "unverified", recommendation: "escalate", requires_human: false`。
- 注意：`strategy-selector.ts:84-87` 的註釋表明 fail-closed 是**刻意**設計
  （「A contract/file heuristic could pass here, but that would green-light an unverified
  language without evidence」）——修改時不要簡單翻轉這個語意，見 §4 衝突 A 的處理方式。

### 1.4 聚合與控制面：unverified → needs_human，且不推進子任務

- `packages/server/src/loop/verification/aggregate.ts:32-37` — 嚴重度
  `failed(3) > unverified(2) > inconclusive(1) > passed(0)` → overall = `unverified`；
  有 escalate 建議 → next_action = `escalate`。
- `aggregate.ts:72-73` — `retryable` **明確排除** unverified：
  `overall !== "passed" && overall !== "unverified" && retryAllowed`。
- `packages/server/src/loop/control-plane/decide.ts:172-176` — 不是 passed、不是
  failed+retryable → 兜底 `needs_human`。
- `packages/server/src/loop/run/turn-loop.ts:1124-1130` — `shouldAdvanceSubtask` 要求
  `judgment.overall === "passed"` → 不推進。`currentSubtaskIndex` 停在 0，
  且不落 `subtask_advance` 決策條目。

### 1.5 人工批准後重注「Current subtask: subtask-1」

- `turn-loop.ts:1427-1433` — `needs_human` → ctx 泊入 `state.suspended`。
- `turn-loop.ts:1737-1745`（`continueRun`）— `ctx.turn += 1`，
  `pendingContext = buildHumanResumeContext(...) + buildNextSubtaskContext(ctx.currentSubtaskIndex /* =0 */)`
  → prompt 再次出現「Current subtask (subtask-1)」+「this turn must only complete the
  current subtask」（`packages/server/src/loop/run/turn-execution.ts:151-169`）。
- 重啟重建路徑同病：`packages/server/src/loop/run/context.ts:240-251` 按
  `subtask_advance` 決策計數重建 `currentSubtaskIndex`，也是 0。

### 1.6 跨輪無結構化狀態，fresh session 必然重新 discovery

- `turn-execution.ts:434-437` — 每輪開**全新 provider session**（註釋明說）。
- `turn-execution.ts:385-430`（`buildLoopTurnStartPrompt`）— 跨輪交接載體：
  human-report（散文）、machine state projection（只有 run_id/turn/state/budget/
  workspace_snapshot，`turn-execution.ts:315-337`）、上一輪 executor summary（散文原文）。
- `packages/server/src/loop/state/handoff.ts:244-254` — `machine-state.json` payload：
  `run_id / loop_id / turn / record / checkpoint_event_id / artifact_manifest_ref /
  workspace_snapshot / created_at`。**沒有任何領域狀態字段**——選中的
  repo / issue / branch / clone 路徑哪裡都不存。
- schema 本體：`packages/shared/src/loop-schema/run-state.ts:121-132`（`MachineStateSchema`）。

### 1.7 閉環死鎖

新 session +「只做 subtask-1（discovery）」→ 重新搜 GitHub → 隨機選中不同項目 →
驗證依然 unknown → 又 `needs_human`。唯一出口是 repeated-blocker watchdog 計數到閾值後
強制 `failed`（`turn-loop.ts:1222-1238`）。

### 1.8 下游管線斷聯

PR-PUBLISH 提取與 relation 創建只在 run **terminal complete** 時發生
（`turn-loop.ts:1437-1497`）。多輪 github run 帶著預設驗證永遠到不了 complete →
relation 永不創建 → PR 發布、回饋維護整條管線失聯。而 relation 正是鎖定已選 issue 的
結構化機制（`runtime-input.ts:268`「只處理這個 relation 的目標與回饋，不要重新搜尋新 issue」），
但它只服務 cross-run，run 內多輪夠不著。

---

## 2. 歷史架構衝突（為什麼會變成這樣）

### 衝突 A：這個 bug 修過一次，後來被新架構親手改回去

- `docs/loop-engineering-java-interview-guide.md:1212-1225`「坑 12」記錄了**完全相同的 bug
  的早期形態**：verifier 假設 Node.js → `inconclusive` → `needs_human`。當時的修復方向：
  「空 workspace 不是失敗，應該 vacuous pass」。
- 後來 `docs/design/layered-verifier-design.md` §6.5（`:317-331`）刻意引入 `unverified` +
  fail-closed，理由是「避免小眾語言因『未知專案型別 + 空命令』靜默 vacuous pass」。
  `packages/server/src/loop/verification/subprocess-verifier.ts:110-125` 就此把空命令從
  `passed` 改成 `unverified`。
- **兩個互相矛盾的設計決策共存於代碼庫**，新的 fail-closed 在這條路徑上勝出，
  坑 12 換了個 status 名字復活。
- 更關鍵：設計文檔 §6.1 第 3 條（`layered-verifier-design.md:236`）明明寫了
  「當沒有命令時，退到 `ContractCriteriaStrategy` / `FileExistenceStrategy`」——
  但 `strategy-selector.ts` **從未實現這個 fallback**，直接掉到 UnverifiedLanguageStrategy。
  實現偏離了自己的設計文檔。

### 衝突 B：workspace 抽象對象錯位

所有 server 側 workspace 消費者（`detectProjectType`、`captureGitDiff`、workspace snapshot、
subprocess verifier 的 cwd）都假設「workspace 根 == 項目根」。對 workspace loop / worktree
loop 成立；對 github_prompt loop **結構性不成立**——真正的項目在運行時才由 agent 選址
物化到子目錄，server 從不知道 clone 在哪。

### 衝突 C：單輪遺留假設 vs 多輪 subtask 機制

planner（`9c49ded`，2026-08-07 引入）是通用分解器，內建不變式「一輪一個子任務、
驗證通過才推進」。這個不變式預設每個子任務的產出都能被 workspace 驗證——對
「產出是一份報告」的 discovery 子任務不成立。**subtask 推進門檻看的是 workspace 狀態，
不是子任務實際交付物。**

### 衝突 D：狀態鎖定機制存在，但接不到這條路徑

relation store 是跨 run 的 subject 鎖定機制，但只在 run 完成或 webhook 管線
（`5088375`）創建。**run 內跨輪沒有任何東西把已選 issue 寫進結構化存儲。**
Phase 6 雙軌交接（machine-state.json）只捕捉 run/turn/budget/snapshot，不含領域狀態。

---

## 3. 七個結構性缺點（按「agent 自主拆分 + 多輪」方向衡量）

1. **子任務沒有一等地位**：`SubTask` schema（`packages/shared/src/loop-schema/task-plan.ts:12-21`）
   只有 `{id, description, success_criteria, target_artifacts}`，無 status、無 outputs。
   `success_criteria` 無任何 verifier 消費（只在 prompt 展示，`runtime-input.ts:478-486`）；
   `target_artifacts` 無人校驗（`checkRequiredArtifacts` 只看 card 級
   `observability.required_artifacts`，`turn-loop.ts:903-926`）；推進判據是全局
   `judgment.overall === "passed"`，與子任務宣稱的成功標準零關係。
2. **推進語義死板 + prompt 自相矛盾**：只能單向單步、passed 才前進；無重做/跳過/重規劃；
   plan 開局生成一次終身不變。且裝配層用**輪次號當子任務索引**
   （`runtime-input.ts:415-418`），與 `buildNextSubtaskContext` 的索引推導並存，
   turn ≥ 2 的 prompt 同時含兩個互相矛盾的 current-subtask 聲明——違反
   `turn-loop.ts:480` 自己立下的「子任务索引不从轮次号推导」。重啟重建路徑
   （`context.ts:218-224`）傳 `runState.turn` 進 `assembleRuntimeInput` 再犯一次。
3. **驗證體系停在單輪世界**：card 級 `required` 對每一輪一刀切；「workspace 根 == 項目根」
   假設貫穿探測/diff/verifier cwd；`unverified` 不可 retry 且人工閘門沒有豁免選項。
4. **跨輪記憶只有散文**：無 run 級結構化工作記憶；已選 subject、clone 路徑、分支名、
   子任務產出全無處可存；約束力只能靠 LLM 讀散文自覺。
5. **planner 是盲的且一次定終身**：`packages/server/src/loop/contract/planner.ts:40`
   明寫「Do NOT call any tools. You do not need to inspect the workspace」——不知道
   loop 類型/workspace 狀態就拆任務，產出注定無法被驗證的「subtask-1 = discovery」；
   無重規劃入口。
6. **預設值與預算跟多輪互斥**：UI 預設 `maxTurns=1`、`maxRetries=0`
   （`loopCardBuilder.ts:44-45`）——3 子任務的 plan 第二輪就撞 `budget_limited`；
   預算模型沒有「plan 需要 N 輪 + 每輪可能 retry」的概念。
7. **下游管線接不上多輪**：見 §1.8。

---

## 4. 重構方案

分 4 個 Phase，每個 Phase 獨立可驗收、獨立可提交。依賴關係：
**Phase 0 無依賴可先行；Phase 1 是 Phase 2/3 的地基；Phase 4 可與 2/3 並行。**

每個修復項給出：目標 / 修改點 / 改法 / 測試。修復項 ID 供提交信息引用。

### Phase 0 — 止血（先解鎖 GitHub loop）

#### F0.1 github_prompt 卡不再預設 static/runtime

- **目標**：UI 預設建立的 GitHub loop 不再因 `unverified` 每輪泊 `needs_human`。
- **修改點**：
  - `packages/client/src/lib/loopCardBuilder.ts:87-90` — `required` 數組的構建移入
    kind 分支：workspace 分支維持現狀；`github_prompt` 分支只保留 interaction
    （若勾選），**不放 static/runtime**。
  - `packages/client/src/pages/LoopsPage.tsx:685-705` — verification 勾選區塊在
    `createForm.kind === "github_prompt"` 時隱藏 static/runtime 兩項（interaction 保留）。
  - `packages/client/src/lib/loopCardBuilder.ts:18-19, 39-40` — 表單 state 字段保留
    （切回 workspace kind 時恢復），僅建卡邏輯分流。
- **理由**：GitHub loop 的驗證目標錯位（§1.2）在 Phase 2 才根治；在此之前讓預設卡
  帶上永遠無法通過的 phase 是製造死鎖。用戶顯式要 static/runtime 的 github loop
  屬於 Phase 2 之後的事，UI 暫不提供入口。
- **測試**：client 若有 loopCardBuilder 測試則補「github_prompt 卡 required 不含
  static/runtime」用例；無測試則手動建卡檢查產出的 JSON。

#### F0.2 消除雙重 current-subtask 矛盾

- **目標**：任何一輪的 prompt 裡只有**一個** current-subtask 聲明，且來源唯一。
- **背景**：`assembleRuntimeInput` 用 `turn` 當索引選 `currentSubtask` 並寫進站立 prompt
  （`runtime-input.ts:414-418, 470-490`）；`buildLoopTurnStartPrompt` 又追加
  `buildNextSubtaskContext`（`turn-execution.ts:422-428`）。turn ≥ 2 時 base prompt
  裡還寫著「当前子任务（第 1 轮）：subtask-1」。
- **改法**：
  - `runtime-input.ts:470-490` — prompt 中保留「任务分解（多轮执行）」總計劃列表，
    **刪除**「当前子任务（第 N 轮）…重要：本轮只应完成当前子任务」整段。
    `bundleExtras.currentSubtask`（結構化字段）可保留供機器消費，不進 prompt。
  - `turn-execution.ts:356-431`（`buildLoopTurnStartPrompt`）— `ctx.taskPlan` 存在時
    **恆**追加 `buildNextSubtaskContext(ctx.currentSubtaskIndex, ctx.taskPlan)`，
    包括 turn 1（目前 turn ≤ 1 直接 return base，`:364-366`）。
  - `context.ts:218-224` — 重建路徑仍傳 `runState.turn` 給 `assembleRuntimeInput`；
    由於 prompt 不再按 turn 聲明子任務，索引錯位自然消除。確認
    `bundleExtras.currentSubtask` 不被任何恢復邏輯誤用即可。
- **測試**：更新 `runtime-input.test.ts`、`turn-execution.test.ts`；新增斷言
  「帶 plan 的 turn 2 prompt 只含一個 current subtask 聲明且為 subtask-2」。

**Phase 0 驗證**：`pnpm typecheck && pnpm lint && pnpm test`；手動建一張 UI 預設
github 卡跑一輪，確認不再出現 `unverified → needs_human`。

### Phase 1 — run 級結構化工作記憶（核心地基）

#### F1.1 新增 RunWorkingState schema

- **修改點**：新建 `packages/shared/src/loop-schema/working-state.ts`，並在
  `packages/shared/src/index.ts` 導出。
- **內容**（zod，全部向後兼容可選）：

```ts
export const SelectedSubjectSchema = z.object({
  repository: z.string(),          // "owner/repo"
  issue_url: z.string().optional(),
  issue_number: z.number().int().optional(),
  clone_path: z.string(),          // 絕對路徑，實際 clone 出來的 repo 根
  branch: z.string().optional(),
  base_sha: z.string().optional(),
});

export const SubtaskStatusSchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "in_progress", "done", "failed"]),
  outputs: z.string().optional(),  // 一句話產出摘要
});

export const RunWorkingStateSchema = z.object({
  schema_version: z.number().int().positive().default(1),
  run_id: z.string(),
  updated_at: z.string().datetime(),
  turn: z.number().int().nonnegative(),
  selected_subject: SelectedSubjectSchema.nullable().default(null),
  subtask_status: z.array(SubtaskStatusSchema).default([]),
});
export type RunWorkingState = z.infer<typeof RunWorkingStateSchema>;
```

#### F1.2 executor 輸出契約：LOOP-STATE 標記塊

- **修改點**：`packages/server/src/loop/assembly/runtime-input.ts`。
  仿 `EXECUTOR_SUMMARY_BEGIN/END`（`:73-91`）與 PR-PUBLISH 的既有模式：
  - 新增 `LOOP_STATE_BEGIN = "<<<LOOP-STATE>>>"` / `LOOP_STATE_END = "<<<END-LOOP-STATE>>>"`
    常量與 `extractLoopState(finalText): RunWorkingState | null`（zod parse，失敗回 null，
    **不 fabricate**）。
  - `githubPromptLines`（`:235-260`）與通用報告要求段（`:513-526` 附近）各加一行：
    每輪結尾輸出 LOOP-STATE JSON 塊；github loop 額外說明
    「選定 issue 後 selected_subject 必填；clone_path 必須是實際 clone 的 repo 根絕對路徑」。

#### F1.3 每輪落盤 working-state.json

- **修改點**：`packages/server/src/loop/run/turn-loop.ts` 每輪 artifacts 段
  （`:620-630` executor summary 處理附近）：
  - `extractLoopState(outcome.finalText)` 命中 → 以 ctx 的 run_id/turn 補齊後
    `store.writeArtifact(runId, "working-state.json", ...)`（**覆蓋式**，run 級唯一，
    不加 turn 後綴——最新即權威）；未命中保留上一輪版本（fail-open，不阻斷、
    不影響 judgment）。
  - ctx 增加 `workingState: RunWorkingState | null` 字段（`packages/server/src/loop/run/types.ts`
    的 `RunExecutionContext`），首輪從 null 起。

#### F1.4 下一輪 prompt 注入權威狀態

- **修改點**：`turn-execution.ts:385-430`（`buildLoopTurnStartPrompt`）：
  - `store.readArtifact(runId, "working-state.json")` 命中 → 追加
    「### Authoritative working state (machine)」段落，內容為 JSON 原文；
    github loop 再加一行硬指令：「working state 已有 selected_subject 時，**禁止**重新搜尋
    新 issue；從 clone_path 繼續，或報告為什麼無法繼續」。
  - turn 1 無 artifact 時不注入（正常）。

#### F1.5 machine-state 掛引用

- **修改點**：
  - `packages/shared/src/loop-schema/run-state.ts:121-132` — `MachineStateSchema` 加
    `working_state_ref: z.string().nullable().default(null)`（向後兼容）。
  - `packages/server/src/loop/state/handoff.ts:244-254` — payload 加
    `working_state_ref: \`artifact://${runId}/working-state.json\``（僅當該 artifact 存在）。
  - checksum 計算順序注意：先組 payload（含新字段）再算 checksum，維持現有模式。
- **測試**：`packages/shared` 的 schema 測試；`handoff.test.ts` 更新；
  新增 run-service 級測試「模擬兩輪：turn 1 輸出 LOOP-STATE → turn 2 prompt 含
  selected_subject 與禁止重搜指令」。參考既有測試的注入方式
  （`run-service-retry.test.ts` / `turn-execution.test.ts` 的 fake supervisor 模式）。

**Phase 1 驗證**：`pnpm --filter @yep-anywhere/shared test && pnpm test && pnpm typecheck`。
手動 E2E：github loop 兩輪，第二輪 stdout 可見 agent 從 clone_path 繼續而非重新搜尋。

### Phase 2 — 驗證按工作區實態分流

#### F2.1 驗證與 diff 的目標指向真實 clone

- **修改點**：`turn-loop.ts:633-643`（diff 採集）與 `:721-742`（verify 調用）：
  - 目標路徑改為 `ctx.workingState?.selected_subject?.clone_path ?? ctx.card.loop.workspace.path`。
  - `preVerifySnapshot` / workspace 穩定性標注（`:729-732, 874-900`）同步改用同一路徑。
- **效果**：clone 存在後 `detectProjectType` 命中真實項目 → `SubprocessStrategy` 跑真實
  lint/test → static/runtime 對 github loop 終於有了語意。UI 重新開放 github 卡的
  static/runtime 勾選是**本項完成後**的事（更新 F0.1 的 UI 隱藏邏輯，可留到 Phase 4）。

#### F2.2 無代碼子任務跳過 static/runtime

- **目標**：discovery / 報告類子任務不再被 UnverifiedLanguageStrategy 卡住。
- **改法**：`turn-loop.ts:721` 附近，調 verify 前計算本輪可執行 phase：
  - 條件：本輪目標路徑（F2.1 解析後）`detectProjectType` 為 `unknown` **且**
    當前子任務 `target_artifacts` 為空 **且** 工作區無 git 變更 → 該輪的
    static/runtime 以 `not_applicable` 落盤（verifier-report-<phase>.json 注明
    「non-code subtask, no clone materialized」），不進策略管線、不參與聚合
    （沿用 `verify-run.ts` 既有的 not_applicable 占位模式，`:327-340`）。
  - 實現位置建議：`verifyRun` 加可選參數 `skipExecutablePhases?: { phase, reason }[]`，
    turn-loop 負責判斷——保持 verify-run 純编排。
- **誠實性**：落盤內容必須明寫跳過原因；ledger 的 `verifier_runtime` ref 如實反映
  執行了哪些 phase。
- **測試**：`verify-run.test.ts` 加跳過用例；run-service 級「discovery 輪不產生
  unverified」用例。

#### F2.3（可選，對齊設計文檔欠賬）

`strategy-selector.ts:72-88` 在無命令時回退 `FileExistenceStrategy`（以當前子任務的
`target_artifacts` 為文件清單）——實現 `layered-verifier-design.md:236` 承諾的
fallback。**僅當 F2.2 落地後仍有需求才做**；做之前先確認 FileExistenceStrategy 的
輸入形態（`strategies/file-existence.ts`）。

**Phase 2 驗證**：`pnpm test && pnpm typecheck`。E2E：github loop 全流程——
discovery 輪不泊 needs_human；clone 後輪真跑 lint/test 並落 verifier-output 日誌。

### Phase 3 — 推進與人工閘門的多輪語義

#### F3.1 推進判據改為「子任務就緒」

- **修改點**：`turn-loop.ts:1124-1130`：
  - `subtaskPassed` 從 `outcome.ok && judgment?.overall === "passed"` 改為
    `outcome.ok && (judgment?.overall === "passed" || subtaskHadNoExecutableVerification)`，
    其中 `subtaskHadNoExecutableVerification` 由 F2.2 的判斷結果帶出
    （本輪 static/runtime 被記 not_applicable 且其餘 phase 未 failed）。
  - 推進時把子任務狀態寫入 `ctx.workingState.subtask_status`（F1.3 落盤）。
- **測試**：更新 `turn-execution.test.ts` / run-service 多輪用例。

#### F3.2 人工閘門新增多輪選項

- **修改點**：`packages/server/src/loop/control-plane/control-plane.ts`
  `POST /api/runs/:id/decision` 處理（`:726` 附近）：
  - 新增 decision `advance_subtask`：人工確認當前子任務完成 →
    `currentSubtaskIndex += 1`、落 `subtask_advance` 決策條目、run 回 active 續跑
    （走 `continueRun`，復用其 pendingContext 構建）。
  - 新增 decision `waive_phases`（payload 帶 phase 列表）：本 run 後續輪跳過指定
    verification phases；記入 decision ledger 與 ctx（重啟重建時從 decision entries
    恢復，`context.ts` 對應增強）。
  - `decide.ts` 的決策表註釋同步更新。
- **理由**：目前 approve 只能「原路再撞一次」。給人「推進」與「豁免」兩個語意明確的
  出口後，即使驗證層再出判斷失誤，run 也不再死鎖。
- **測試**：`control-plane.test.ts` 新 decision 用例；`run-service-restart-recovery.test.ts`
  確認重啟後 waive 仍生效。

#### F3.3（後續，不在本次範圍）

executor 輸出 `RE-PLAN` 塊請求重規劃 → planner 帶 working state 重跑。本次只做
F1-F3.2；此項立項單獨評估。

**Phase 3 驗證**：`pnpm test`。E2E：製造一個 unverified 場景 → 人工 advance_subtask →
run 前進到下一子任務而非重做 discovery。

### Phase 4 — 預設值、預算與下游管線

#### F4.1 UI 多輪預設

- `loopCardBuilder.ts:44-45` — `maxTurns` 預設從 `"1"` 調為 `"5"`（planner 最多
  `MAX_SUBTASKS = 5`，見 `planner.ts:24`）；UI 在 task 輸入框附近加一行說明
  「多子任務計劃每輪推進一個子任務，max_turns 需 ≥ 子任務數」。
- F2.1 完成後：github kind 重新顯示 static/runtime 勾選（預設仍關，由用戶顯式開）。

#### F4.2 PR-PUBLISH 提取改為每輪

- **修改點**：`turn-loop.ts:1437-1497` 的 relation 註冊邏輯抽成 per-turn 函數，
  每輪結束都嘗試 `extractPrPublishPayload(outcome.finalText)`（而非僅
  `status === "complete"`）；命中即 upsert `pr_pending_approval`（既有去重邏輯保留）。
- **效果**：多輪 run 即使最終泊 needs_human / budget_limited，已完成的本地修復也能
  進入人工批准發布管線。

**Phase 4 驗證**：`pnpm test`；E2E：多輪 github run 中途輸出 PR-PUBLISH →
relation 出現在列表。

---

## 5. 總驗收標準

1. **回歸全綠**：`pnpm --filter @yep-anywhere/shared test && pnpm test && pnpm typecheck && pnpm lint`。
2. **場景 A（死鎖不再）**：UI 預設建 github_prompt 卡 → run 至少推進到 clone 之後，
   不出現「每輪 unverified → needs_human」循環。
3. **場景 B（狀態鎖定）**：turn 1 選定 issue 並輸出 LOOP-STATE → turn 2 的 prompt
   含 `selected_subject` 與禁止重搜指令 → stdout 可見 agent 從 clone_path 繼續。
4. **場景 C（驗證真跑）**：clone 完成後的輪，verifier-output-static-*.log 是真實
   lint/typecheck 輸出，cwd 是 clone_path。
5. **場景 D（人工出口）**：構造 unverified → 人工 `advance_subtask` → run 推進。
6. **場景 E（單一聲明）**：帶 plan 的任意 turn ≥ 2 prompt，「current subtask」語義
   聲明只出現一次且索引正確。
7.（可選）基準回歸：`pnpm test:loop-runtime:sample`（需本機 provider 憑證；
   口徑見 `docs/plans/phase7-integration-testing-and-benchmark-plan.md`）。

---

## 6. 風險與邊界

- **schema 兼容**：MachineState 新字段必須 `.default(null)`；舊 run 的
  machine-state.json 無該字段須可 parse。不升 `schema_version`（加可選字段不構成
  breaking change）。
- **fail-open 紀律**：LOOP-STATE 提取失敗只意味「本輪無結構化狀態」，**不得**影響
  judgment、不得觸發 retry——它是優化通道，不是閘門（與 executor summary 的
  「缺失即信號」哲學不同，注意區分）。
- **不推翻 fail-closed**：`UnverifiedLanguageStrategy` 對「workspace loop + 小眾語言」
  場景仍是正確語意，F2.2 只對「無代碼子任務」分流，不把 unverified 改回 vacuous pass
  （否則坑 12 與 §6.5 的搖擺再次上演）。
- **已存卡不遷移**：F0.1 只影響新建卡；存量卡維持原樣（它們會走 F3.2 的人工出口）。
- **不要做的事**：不重寫 planner；不引入新的存儲引擎/消息隊列；不改 relation store
  結構（F4.2 只改調用時機）；不動 checkpoint/integrity 機制。

---

## 7. 關鍵文件地圖

| 文件 | 角色 | 涉及修復項 |
|---|---|---|
| `packages/client/src/lib/loopCardBuilder.ts` | 建卡表單 → LoopCard | F0.1, F4.1 |
| `packages/client/src/pages/LoopsPage.tsx` | 建卡 UI | F0.1, F4.1 |
| `packages/shared/src/loop-schema/run-state.ts` | MachineState schema | F1.5 |
| `packages/shared/src/loop-schema/working-state.ts` | **新建** RunWorkingState | F1.1 |
| `packages/shared/src/loop-schema/task-plan.ts` | SubTask schema | （F3.3 後續） |
| `packages/server/src/loop/assembly/runtime-input.ts` | prompt 裝配、summary 提取 | F0.2, F1.2, F1.4 |
| `packages/server/src/loop/run/turn-loop.ts` | 多輪主循環 | F1.3, F2.1, F2.2, F3.1, F4.2 |
| `packages/server/src/loop/run/turn-execution.ts` | 單輪執行/prompt 構建 | F0.2, F1.4 |
| `packages/server/src/loop/run/context.ts` | 重啟重建 | F0.2, F3.2 |
| `packages/server/src/loop/run/types.ts` | RunExecutionContext | F1.3 |
| `packages/server/src/loop/run/workspace.ts` | workspace 解析 | （背景理解） |
| `packages/server/src/loop/verification/strategy-selector.ts` | 策略選擇 | F2.3（可選） |
| `packages/server/src/loop/verification/verify-run.ts` | 驗證编排 | F2.2 |
| `packages/server/src/loop/verification/aggregate.ts` | 聚合 | （理解，勿改 unverified 語意） |
| `packages/server/src/loop/control-plane/control-plane.ts` | 人工閘門 API | F3.2 |
| `packages/server/src/loop/control-plane/decide.ts` | 決策表 | F3.2（註釋） |
| `packages/server/src/loop/state/handoff.ts` | machine-state 落盤 | F1.5 |
| `packages/server/src/loop/contract/planner.ts` | planner | （F3.3 後續） |

## 8. 測試命令速查

```bash
pnpm --filter @yep-anywhere/shared test   # shared schema 測試（node --test + tsx）
pnpm test                                  # = pnpm --filter @yep-anywhere/server test（tsc 後逐個 node dist 測試文件）
pnpm typecheck                             # 先 build shared 再全倉 tsc --noEmit
pnpm lint                                  # biome check .
pnpm test:loop-runtime:sample              #（可選）真 provider 的 loop 基準冒煙
```

server 測試是「tsc 編譯後逐個執行 `dist/**/*.test.js`」的 node:test 風格；新增測試文件
後**必須**把它加進 `packages/server/package.json` 的 `test` script 鏈條，否則不會被跑到。
