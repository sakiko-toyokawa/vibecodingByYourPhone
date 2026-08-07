# Loop 驗證與狀態系統實施計畫

> 基於 `verifier_system_design.md`、`loop_state_system_improvement_plan.md` 與 `docs/design/layered-verifier-design.md` 的落地路線圖。
> 版本：v1.6 | 日期：2026-08-05
>
> **進度：Phase 0–5 已完成（2026-08-05）。**

---

## Phase 0 完成紀錄

以下任務已落地（程式碼 + 測試均通過 `pnpm typecheck`、`pnpm --filter shared test`、
server verification / run-service 相關測試、`biome check`）：

- [x] `VerificationPhaseSchema` 擴展 `rule` / `structural`
  （`packages/shared/src/loop-schema/loop-card.ts:9`）。
- [x] `VerifierReportSchema` 增加可選欄位 `score` / `issues[]` /
  `auto_fixable` / `suggested_fix`；新增 `VerifierIssueSchema`
  （`packages/shared/src/loop-schema/verification.ts`）。
- [x] `IntentContractSchema` 增加可選 `intent_understanding` 區塊
  （`packages/shared/src/loop-schema/intent-contract.ts`）。
- [x] `verify-run.ts` phase 迴圈：`rule` / `structural` 與
  `static` / `runtime` 走同一條策略短路管線；`deps` 增加
  `selectStrategy` 測試注入點（`verify-run.ts:111`）。
- [x] 新增 `PhaseNotImplementedStrategy` 兜底
  （`strategies/not-implemented.ts`）：宣告了 rule/structural 但策略未實作
  時給出誠實的 `inconclusive + escalate`，不靜默通過。
- [x] 測試 scaffold：`loop-schema.test.ts`（phase/report/contract 擴展）、
  `strategy-selector.test.ts`（兜底掛載）、`verify-run.test.ts`
  （not-implemented 兜底參與聚合 + rule 硬失敗短路 structural/review）。

**實作偏差（與原計畫表格的差異）：**

1. 原計畫說「新增 empty strategy」；落地改為 `PhaseNotImplementedStrategy`
   回傳 `inconclusive`（而非 vacuous pass），理由：empty pass 會讓宣告了
   rule/structural 的 card 在策略未實作期間靜默通過，違反誠實口徑。
2. `verifyRun` 的 `deps` 多了 `selectStrategy` 可選注入點（預設不變），
   用於測試短路邏輯；這是 Phase 0 未列出的最小擴展。

---

## Phase 1 完成紀錄

以下任務已落地（`pnpm test` 全量通過、`pnpm typecheck`、`biome check` 乾淨）：

- [x] **selector 消費 `file_exists` / `file_contains`**
  （`strategy-selector.ts`）：顯式釘死順序為 static/runtime 命令 >
  file_contains > file_exists > 專案類型自動探測 > success criteria >
  fallback。顯式配置優先於自動探測（card 明確配置即為驗證意圖）。
- [x] **`FileContentStrategy` 修正**：讀取順序改為 workspace 優先、
  artifacts 回落（與 `ContractCriteriaStrategy` 同口徑）；
  `verifier_phase` 跟隨輸入 phase，不再硬編碼 `"static"`。
- [x] **`ContractCriteriaStrategy` 解析增強**：引號內期望內容做精確子串
  比對；支援否定訴求（must not contain / 不得包含）；支援
  `at least N` / `至少 N` 次數訴求。無引號時回落既有 candidate 啟發式，
  舊測試行為不變。
- [x] 新增測試：`strategies/file-content.test.ts`（4 例）、
  `contract-criteria.test.ts` 新增 4 例、`strategy-selector.test.ts`
  新增 3 例；`packages/server/package.json` 測試腳本加入新測試檔。

**實作偏差（與原計畫表格的差異）：**

1. **預設輪次 timeout：不實作。** 程式碼內已有 2026-07-27 的使用者決策
   （`turn-execution.ts:357`）：硬超時太絕對，真實只讀掃描常需 5–10 分鐘；
   掛起治理由既有 idle watchdog（`loopWatchdog.turnIdleTimeoutMs`，預設
   10 分鐘無活動即殺）承擔。強加預設硬 timeout 會違背既定決策，故本項
   改為「確認既有 watchdog 生效」，無程式碼變更。
2. **stderr / transcript 採集：延後。** 評估結論已寫進
   `runtime-input.ts` 註釋：`ProcessEvent`（supervisor/types.ts）只有
   message/state-change 等歸一事件，沒有原始 stderr/transcript 通道；
   打通需在各 provider bridge 層截獲子進程 stderr，屬 supervisor 改造，
   不在 verifier P1 範圍，待獨立任務排期。

---

## Phase 2 完成紀錄

以下任務已落地（`pnpm test` 全量通過、`pnpm typecheck`、`biome check` 乾淨）：

- [x] **規則格式定義**：新增 `packages/shared/src/loop-schema/verification-rules.ts`
  （`VerificationRuleSchema` / `VerificationRuleSetSchema`）；LoopCard
  `verification.rules` 內嵌規則（`loop-card.ts`）。規則即資料（正則
  source），不承載函數 —— 複雜檢查應走 L3 structural。
- [x] **`RuleBasedStrategy`**（`strategies/rule-based.ts`）：
  card 內嵌規則 + workspace `.verifier/rules.json` 合併執行。
  - scope 三檔：`changed`（diff.patch 觸及檔案，無 diff 回落 targets）/
    `targets`（合約 target.files）/ `workspace`（全倉，排除
    node_modules/.git/dist 等，上限 500 檔 / 1MB）。
  - severity：`error` → failed + retry；`warning` → 只進 `issues[]`
    不阻塞（用上 P0 加的 `issues[]` 欄位，含檔案/行號/建議）。
  - 誠實口徑：無規則可跑 → inconclusive + escalate；規則檔非法 →
    inconclusive + escalate；規則無候選檔案 → info issue 不阻塞。
- [x] **selector 整合**：`rule` phase 掛 `RuleBasedStrategy`；
  `structural` 仍由 `PhaseNotImplementedStrategy` 兜底。
- [x] **預設規則包**：`templates/default-verifier-rules.json`
  （no-hardcoded-secrets、no-private-key-block、no-debugger、
  no-console-log、no-todo-fixme），複製進 workspace 即啟用，不自動套用。
- [x] 測試：`strategies/rule-based.test.ts`（8 例）+
  `loop-schema.test.ts` 規則 schema 正反例（3 例）+ selector 更新。

**實作偏差：**

1. 預設規則包做成 template 檔案而非自動套用 —— 自動對存量倉庫跑
   no-console-log / 命名規範會產生大量誤報；啟用權交給使用者（複製
   template 或 card 內嵌）。
2. `severity` 映射到 `VerifierIssue.severity` 時 error→major、
   warning→minor（issue 詞彙表無 error/warning），不另造同義詞。

---

## Phase 3 完成紀錄

以下任務已落地（`pnpm test` 全量通過、`pnpm typecheck`、`biome check` 乾淨）：

- [x] **Import graph**（`strategies/structural/import-graph.ts`）：
  regex-based import/export/require 提取，僅解析相對路徑；DFS 循環偵測 +
  旋轉副本去重；上限 2000 檔。誠實限制寫在檔頭（無 path alias、動態
  import 可能漏判）——不新增 ts-morph / dependency-cruiser 依賴。
- [x] **TypeScript checker**（`structural/typescript.ts`）：
  - `tsc --noEmit --pretty false` diagnostics 解析為帶檔案/行/列的 issues
    （命令可注入，測試不需真 tsc）；
  - 循環依賴偵測；
  - tsc 不存在 / 逾時 → inconclusive，不假裝通過；
  - tsc log 落盤為 evidence（`structural-tsc-turn<N>.log`）。
- [x] **Schema checker**（`structural/schema.ts`）：約定
  `<name>.schema.json` ↔ `<name>.json` 配對；最小 JSON Schema 子集
  （type/properties/required/items/enum/additionalProperties:false）；
  遠端 $ref/$schema 記 info 不阻塞——不引入 ajv，完整語義待有意的
  依賴決策。
- [x] **StructuralStrategy**（`structural/index.ts`）：聚合 checker，
  error 級 issue → failed + retry；無適用 checker → inconclusive +
  escalate（與 rule phase 同口徑）。selector 已切到 StructuralStrategy，
  `PhaseNotImplementedStrategy` 目前無消費者，保留為未來 phase 模板。
- [x] 測試：`structural/structural.test.ts` 11 例（import graph 3、
  TS checker 3、schema 2、策略聚合 3）。

**實作偏差：**

1. 原計畫的「ProjectGraph 抽象給 TS/Python/Rust 共用」落地為單一
   `import-graph.ts`（TS 專用）+ checker 介面（`CheckerOutcome` 形狀）——
   Python/Rust checker 未實作，非 TS 專案目前回 inconclusive（誠實），
   不在 MVP 裡假裝支援。
2. 原計畫的「LSP 啟動快取」落地為「tsc 每輪至多一次 + 輸出落盤」——
   未引入常駐 language server（狀態管理成本 > 收益，見設計文檔風險節）。
3. 順手修了一個既有 flaky：
   `run-service-workspace-stability.test.ts` 的「非 git 目錄」用例
   `rm` 無 `maxRetries`，Windows 上 git 子進程短暫佔用目錄會撞 EBUSY；
   補上 `maxRetries: 5`（與同檔案其他用例同口徑）。

---

## Phase 4 完成紀錄

以下任務已落地（`pnpm test` 全量通過、`pnpm typecheck`、`biome check` 乾淨）：

- [x] **Agent prompt**（`verification/agent/prompt.ts`）：Rubric 四維
  （需求對齊 0.4 / 邊界覆蓋 0.3 / 風格一致 0.2 / 無邏輯漏洞 0.1）+
  攻擊者視角步驟（最多 3 個欺騙手法）+ 強制 JSON 輸出格式。
- [x] **輸出解析與兜底**（`agent/parse.ts`）：fenced ```json 提取 →
  大括號回落 → Zod `AgentVerdictSchema` 閘門；任何解析失敗一律降級
  `inconclusive + escalate`（核心禁忌的執行面：模型輸出只是候選裁決，
  必須過確定性閘門才能進賬本）。對抗性發現映射進 `unresolved_risks`
  （`adversarial:` 前綴），issues 自動編號 `L4-NNN`。
- [x] **Verifier Agent runner**（`agent/run-verifier-agent.ts`）：
  plan-mode read-only session、fresh context（不帶 Maker 對話歷史）、
  輸入包/輸出落盤為 artifact；agent 崩潰/逾時/無輸出 → inconclusive。
- [x] **verify-run 接入**：`deps.runReviewAgent` 回調接管 review phase；
  下層硬失敗短路時**不呼叫** agent（省 L4 成本）；`input.reviewReport`
  （collector-as-review）路徑保留為向後兼容。
- [x] **turn-loop 接入**：review in chain 時掛 `runReviewAgent`；
  collector 報告恆作為證據合併進 judgment（不再充當 verdict）。
- [x] 測試：`agent/parse.test.ts`（6 例）、
  `agent/run-verifier-agent.test.ts`（2 例）、`verify-run.test.ts`
  新增 2 例（agent 接管聚合 + 短路不呼叫 agent）。

**實作偏差：**

1. 原計畫的 `VerifierAgentStrategy`（strategy 介面）落地為
   `deps.runReviewAgent` 回調 —— strategy 管線拿不到 supervisor，
   agent 需要啟動 session；回調注入保持 verification 層不依賴
   supervisor，職責更乾淨。
2. collector session 保留（純證據採集），未與 Verifier Agent 合併 ——
   review-in-chain 的 run 每輪會有兩次 LLM 調用（collector + judge）。
   後續優化項：讓 judge 兼做證據採集，退役 collector。
3. 「與 Maker 不同模型家族」不落程式碼 —— 由 card 的
   `loop.runtime.provider/model` 部署配置決定，不硬編碼。
4. 完整 Hacker-Fixer 對抗訓練迴圈未實作 —— 單次裁決內含攻擊者視角
   步驟；持續訓練機制屬後續階段（對抗樣本累積進 failure-pattern 賬本）。

---

## Phase 5 完成紀錄

以下任務已落地（`pnpm test` 全量通過、`pnpm typecheck`、`biome check` 乾淨）：

- [x] **Card 配置**：`loop.intent_understanding.use_agent`（預設關閉，
  不影響既有確定性裝配）。
- [x] **意圖理解 Agent**（`contract/intent-understanding-agent.ts`）：
  plan-mode session 產生合約草案；Zod 閘門，解析失敗回退確定性裝配；
  **agent 只能提議語義欄位**（outcome / success_criteria / constraints /
  task_type / target.files），budget / security_level / stop_rules 永遠由
  確定性裝配從 card 投影 —— 不讓模型給自己放權或加預算。
- [x] **範本庫**：`contract/intent-templates.ts`（TS 常量為權威來源，
  server 不依賴相對路徑讀檔）+ `templates/intent-contracts/*.json`
  鏡像副本（read_only_report / dependency_update / maintenance）。
  範本命中免 agent、視為已確認。
- [x] **人工確認閘門**：agent 合約 `confirmed_by_human=false` 時，run 在
  首輪執行前經 `applyJudgment(turn: 0, requires_human)` 泊入
  needs_human（turn 0 = 閘門輪，不佔輪次預算）；approve 視為確認，
  `continueRun` 翻轉旗標並回寫合約快照，以 turn 1 起步續跑。
  `rebuildContext` 放寬 turn 0/1 的缺賬本容忍（重啟恢復相容）。
- [x] 測試：`intent-understanding-agent.test.ts`（6 例）+
  `run-service-intent-gate.test.ts` 集成（泊閘門 → approve → 翻轉旗標
  → turn 1 執行 → complete，含決策賬本斷言）。

**實作偏差：**

1. 閘門用 turn 0 泊入而非在路由層攔截 —— run 已創建即入賬，人工
   確認走既有 `POST /api/runs/:id/decision` 通道，不需新端點；
   turn 0 不消耗輪次預算（`used_turns = 0`）。
2. 範本權威來源是 TS 常量而非 JSON 檔 —— server runtime 不依賴倉庫
   相對路徑；`templates/intent-contracts/` 是使用者參考鏡像。
3. 意圖 Agent 失敗靜默回退確定性裝配（console.warn 留痕）—— 閘門
   只在 agent 成功產生草案時介入；agent 不可用不阻塞既有行為。

---

---

## 一、背景與目標

### 1.1 現狀

- **Verifier**：已有 `static` / `runtime` 子程序檢查（`packages/server/src/loop/verification/`），但 `interaction` / `review` 仍是 placeholder，沒有 L2 規則引擎、L3 結構檢查、L4 LLM-as-Judge。
- **Loop State**：已有 run ledger（append-only JSONL）、run state（`state/<loop_id>.json`）、artifacts、`.loop/STATE.md` 投影，但缺少生產級的 Checkpoint、雙軌 Handoff、外部狀態同步與敏感資料脫敏。
- **輸入裝配**：合約由確定性模板裝配，沒有獨立的「意圖理解 Agent」。

### 1.2 目標

1. 建立 **L1 → L2 → L3 → L4** 分層 Verifier。
2. 引入 **意圖理解 Agent**，把自然語言需求轉成結構化 `IntentContract`。
3. 把 Loop State 升級為 **可崩潰恢復、可審計、可交接** 的生產級狀態系統。
4. 全程對接現有 `control-plane` / `run-service` 狀態機，不改變外部 API 行為。

---

## 二、範圍

### 2.1 包含

- Verifier phase 擴展：`static / runtime / rule / structural / interaction / review`。
- `RuleBasedStrategy`、`StructuralStrategy`、`VerifierAgentStrategy`。
- 意圖理解 Agent（`IntentUnderstandingAgent`）。
- Loop State：append-only state log、Checkpoint、雙軌 Handoff、外部狀態同步、脫敏。

### 2.2 不包含

- 前端 LoopCard Builder UI 改造（只開必要 schema 欄位）。
- Relay / 客戶端大改。
- 完全替換現有 `RunLedgerStore` 儲存佈局（先補強，後遷移）。

---

## 三、實施階段

### Phase 0：基礎設施與 Schema 擴展（1 周）

**目標**：讓後續 layer 有掛載點，不改變既有行為。

| 任務 | 具體工作 | 涉及檔案 | 驗收標準 |
|---|---|---|---|
| 擴展 `VerificationPhaseSchema` | 新增 `rule`、`structural`；`review` 語義保留給 Verifier Agent | `packages/shared/src/loop-schema/loop-card.ts:9` | `review` / `rule` / `structural` 可進 `verification.required` 陣列且現有測試仍過 |
| 擴展 `VerifierReportSchema` | 增加可選 `score`、`issues[]`、`auto_fixable`、`suggested_fix` | `packages/shared/src/loop-schema/verification.ts:61` | 新舊 report 都能被 schema parse |
| 擴展 `IntentContract` | 增加 `intent_understanding` 區塊（原始需求、驗收標準、約束、摘要） | `packages/shared/src/loop-schema/intent-contract.ts` | 不影響現有合約產生與 parse |
| 重構 `verify-run.ts` phase 迴圈 | 讓 `rule` / `structural` 走與 `static/runtime` 同樣的短路邏輯 | `packages/server/src/loop/verification/verify-run.ts:133` | 新增 phase 失敗會短路後續 phase |
| 補測試 scaffold | 為新 phase 新增 empty strategy 與最小測試 | `packages/server/src/loop/verification/strategies/` | CI 通過 |

**交付物**：
- schema 變更 PR。
- `verify-run.ts` 可掛載新 phase。

---

### Phase 1：L1 確定性層補強（1 周）

**目標**：讓現有 L1 更穩定、可觀測。

| 任務 | 具體工作 | 涉及檔案 | 驗收標準 |
|---|---|---|---|
| 消費 `file_exists` / `file_contains` | 讓 `strategy-selector.ts` 在沒有命令時選擇 `FileExistenceStrategy` / `FileContentStrategy` | `strategy-selector.ts:23-50`、`strategies/file-existence.ts`、`strategies/file-content.ts` | card 配置 file_exists/file_contains 時能正確驗證 |
| 改善 `ContractCriteriaStrategy` | 用輕量 NLP/正則組合解析 success criteria，減少 false negative | `strategies/contract-criteria.ts:68-113` | benchmarks 中合約相關 case 通過率提升 |
| stderr / transcript 採集 | 在 `ProcessEvent` 層新增 `stderr` 與 `transcript` 通道，並在 bundle 中標記 | `runtime-input.ts:327-334`、adapter 相關 event 處理 | `capture_stderr` / `capture_transcript` 可設為 true |
| 預設輪次 timeout | 當 `adapter_policy.timeout_seconds` 不存在時，給一個合理預設值（如 10 min） | `runtime-input.ts:319`、`turn-execution.ts:356-362` | 未設定 policy timeout 的 run 仍有 timeout |

**交付物**：
- L1 更完整的 verifier chain。
- 測試覆蓋 file_exists/file_contains/contract criteria。

---

### Phase 2：L2 規則引擎（1 周）

**目標**：可配置、輕量、不啟動語言服務。

| 任務 | 具體工作 | 涉及檔案 | 驗收標準 |
|---|---|---|---|
| 定義規則格式 | `.verifier/rules.json` + card 內嵌 `verification.rules` | `packages/shared/src/loop-schema/loop-card.ts:82` | schema 可承載正則與函數規則 |
| 實作 `RuleBasedStrategy` | 讀取規則庫，對 workspace 檔案內容執行檢查 | `packages/server/src/loop/verification/strategies/rule-based.ts` | 硬編碼密鑰、API 路徑規範等規則可執行 |
| 整合進 selector | 當 `rule` phase 在 required 中時選擇 `RuleBasedStrategy` | `strategy-selector.ts:18` | card 配置 `rule` 時正確觸發 |
| 預設規則包 | 提供一組常用規則（no-hardcoded-secrets、api-path-convention） | `templates/default-verifier-rules.json` | 新專案可一鍵啟用 |

**交付物**：
- `RuleBasedStrategy` 可運行。
- 新增規則只需改 JSON。

---

### Phase 3：L3 結構層（2 周）

**目標**：用 LSP / AST / 依賴圖 / Schema 檢查語義關係。

| 任務 | 具體工作 | 涉及檔案 | 驗收標準 |
|---|---|---|---|
| 抽象 `ProjectGraph` | 定義可擴展的 project graph 介面 | `packages/server/src/loop/verification/project-graph.ts` | TypeScript/Python/Rust 可共用同一介面 |
| TypeScript LSP/AST checker | 使用 `tsc --noEmit` / `ts-morph` 取得 diagnostics 與 import graph | `strategies/structural/checkers/typescript.ts` | 型別錯誤、未定義引用、循環依賴可被檢出 |
| Python/Rust checker（可選） | 預留介面，先實作 pyright / cargo check 橋接 | `strategies/structural/checkers/python.ts`、`rust.ts` | 至少 TypeScript 穩定運行 |
| Schema 驗證 | JSON Schema / OpenAPI 基本驗證 | `strategies/structural/checkers/schema.ts` | 可驗證 workspace 中 schema 檔案 |
| 實作 `StructuralStrategy` | 聚合各 checker，輸出 `VerifierReport` | `strategies/structural.ts` | 整體 report 符合 schema |
| 快取 LSP 啟動 | 每輪只啟動一次 LSP，結果寫入 artifact | `strategies/structural/lsp-runner.ts` | 重複檢查不重新啟動 |

**交付物**：
- `StructuralStrategy` 可檢查 TS 專案的型別與依賴。
- 檢查結果寫入 artifact ref。

---

### Phase 4：L4 Verifier Agent（2 周）

**目標**：read-only LLM-as-Judge，輸出結構化 Verdict。

| 任務 | 具體工作 | 涉及檔案 | 驗收標準 |
|---|---|---|---|
| 定義 Agent prompt | Rubric + 輸入包格式 + 強制 JSON 輸出 | `packages/server/src/loop/verification/agent/prompt.ts` | Agent 輸出可被 Zod parse |
| 實作 `VerifierAgentStrategy` | 透過 `supervisor.startSession(..., "plan")` 啟動 read-only session | `strategies/verifier-agent.ts` | Agent 不持有 Write/Edit/Bash 權限 |
| 輸入包組裝 | 把 diff/stdout/L1-L3 reports/previous judgment/需求/規則餵給 Agent | `strategies/verifier-agent/input-bundle.ts` | 輸入包 < token 上限 |
| 輸出解析與兜底 | Zod 驗證失敗時視為 `inconclusive` + `escalate` | `strategies/verifier-agent/parse-report.ts` | 無效輸出不會 crash verifier |
| 整合 review phase | `verify-run.ts` 在 `review` phase 使用 `VerifierAgentStrategy` | `verify-run.ts:195-230` | review 不再只是 collector |
| 對抗性審查（可選） | prompt 加入「找出可能欺騙 verifier 的漏洞」步驟 | `prompt.ts` | 可產生對抗性風險項 |

**交付物**：
- `review` phase 成為真正的 LLM Judge。
- 與 Maker 可配置不同 model/provider。

---

### Phase 5：意圖理解 Agent（1.5 周）

**目標**：把自然語言需求轉成結構化 `IntentContract`。

| 任務 | 具體工作 | 涉及檔案 | 驗收標準 |
|---|---|---|---|
| 定義 Agent 輸入輸出 | 輸入：使用者原始 prompt + AGENTS.md；輸出：`IntentContract` 草案 | `packages/server/src/loop/contract/intent-understanding-agent.ts` | 輸出可被 `IntentContractSchema.parse` |
| 實作 `buildIntentContract` 的 Agent 分支 | 當 card 開啟 `intent_understanding: { use_agent: true }` 時啟用 | `packages/server/src/loop/contract/intent-contract.ts:83` | 不開啟時保持既有確定性行為 |
| 人工確認閘門 | Agent 產生的 contract 草稿先進 `needs_human` 或 UI 確認，避免幻覺直接落地 | `control-plane.ts` / routes | 未確認前不觸發自動 run |
| 累積範本 | 把常用任務類型的成功 contract 存為範本，減少 Agent 調用 | `templates/intent-contracts/` | 新 loop 可匹配現成範本 |

**交付物**：
- 可選的意圖理解 Agent。
- 產生的 contract 可被人類確認後執行。

---

### Phase 6：Loop State 生產級改造（3 周）

**目標**：解決並發、崩潰恢復、儲存膨脹、外部一致性、安全問題。

| 任務 | 具體工作 | 涉及檔案 | 驗收標準 |
|---|---|---|---|
| State append-only log | 把 `state/<loop_id>.json` 改為 `state/<loop_id>.jsonl`，每條 event append-only；寫入加檔案鎖 | `packages/server/src/loop/control-plane/run-state-store.ts:79` | `kill -9` 後最後一條 event 不截斷 |
| Checkpoint 機制 | 每輪結束寫 `checkpoint` event；重啟時掃描未完成 checkpoint 並詢問恢復 | `run-state-store.ts`、`run-service.ts` | 崩潰後重啟可問使用者「是否從第 N 輪恢復」 |
| 雙軌 Handoff | 每次 session 結束產生 `human_report.md`（AU2 八段式）+ `machine_state.json` | `packages/server/src/loop/state/handoff.ts` | 新 session 可從 `machine_state.json` 精確恢復 |
| 外部狀態同步 | `writeArtifact` / tool call 記錄 `idempotency_key` + `expected_hash`；恢復時比對實際檔案 | `run-ledger-store.ts:105`、`run-service.ts` | 外部檔案被改動時恢復流程能檢測並提示 |
| 儲存分層 | 近期輪次 artifact 保留本地，舊輪次壓縮歸檔到 `cold/` | `cleanup.ts:6-7`、新增 `cold-storage.ts` | 1000 輪後 state log 讀取 < 100ms |
| Schema 版本化 + checksum | state/ledger 加上 `schema_version` 與 `checksum`；損壞時自動遷移或回滾 | `run-state.ts:37`、`run-ledger.ts:40` | v2.0 state 可被 v2.1 自動讀取 |
| 敏感資料脫敏 | 絕對路徑改為 `{workspace}` 標記；API key 改為 `env:xxx`；大內容存 hash | `state-md-projection.ts`、`handoff.ts` | state 檔案中不出現 API key 與絕對路徑 |

**交付物**：
- 可崩潰恢復、可審計的 Loop State。
- 雙軌 Handoff 與外部狀態一致性檢查。

---

### Phase 7：整合、測試與基準（2 周）

**目標**：全鏈路穩定，benchmark 通過。

| 任務 | 具體工作 | 涉及檔案 | 驗收標準 |
|---|---|---|---|
| 全鏈路測試 | 從 loop 觸發 → intent agent → maker → L1-L4 verifier → judgment → retry | `benchmarks/loop-modules/` | 新增 behavior cases 通過 |
| 錯誤模式歸類 | 把 L3/L4 常見失敗歸入 `FailureTag` | `packages/shared/src/loop-schema/run-ledger.ts:23` | 新 tag 有對應 learning 處理 |
| 性能基準 | 測量 LSP 啟動時間、Agent token 消耗、state log 讀取時間 | `benchmarks/loop-runtime-eval/` | 平均驗證成本 < Maker 成本 30% |
| 文件更新 | 更新 `CLAUDE.md` / `AGENTS.md` 與 API 文件 | `CLAUDE.md`、相關 `README` | 文件與實作一致 |

---

## 四、時間線總覽

| 階段 | 時間 | 關鍵產出 |
|---|---|---|
| Phase 0 | 1 周 | Schema 擴展 + phase 掛載點 |
| Phase 1 | 1 周 | L1 補強 |
| Phase 2 | 1 周 | L2 規則引擎 |
| Phase 3 | 2 周 | L3 結構檢查 |
| Phase 4 | 2 周 | L4 Verifier Agent |
| Phase 5 | 1.5 周 | 意圖理解 Agent |
| Phase 6 | 3 周 | Loop State 生產級改造 |
| Phase 7 | 2 周 | 整合測試 + 基準 |

**總計：約 13.5 周（3 個多月）完成整體改造。**

若資源有限，建議 **MVP 範圍**：Phase 0 + Phase 1 + Phase 4 + Phase 6 的 Checkpoint，約 **6 周**可先上線。

---

## 五、依賴與風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| LSP 啟動慢 | L3 驗證時間長 | 先用 `tsc --noEmit` 等一次性命令；快取啟動結果 |
| Verifier Agent 誤殺 | 無效 retry | 初期只做 warning，累積樣本後再設為 hard fail |
| State log 遷移 | 舊 `state/<loop_id>.json` 需相容 | 啟動時自動把舊 json 轉為首條 event |
| 意圖 Agent 幻覺 | 產生錯誤 contract | 人工確認閘門；匹配範本優先 |
| Token 成本暴增 | L4 + intent agent 雙 LLM | 只在 L1-L3 全過後跑 L4；intent agent 可選 |

---

## 六、驗收標準

1. **Verifier**：L1 hard-fail 短路後續層；L3 能檢出型別錯誤與循環依賴；L4 輸出符合 schema。
2. **Intent Agent**：產生的 contract 可被人類確認，未確認前不自動執行。
3. **Loop State**：`kill -9` 後能從最後一輪 checkpoint 恢復；外部檔案被改動時恢復流程能檢測。
4. **成本**：平均 verifier 成本 < Maker 生成成本 30%。
5. **零副作用**：Verifier Agent 運行後 workspace MD5 不變。
6. **測試**：新增 behavior cases 全過；既有 CI 不破壞。

---

## 七、一句話總結

> 先擴展 schema 與 phase 掛載點，再依序補強 L1、實作 L2/L3/L4 Verifier、加入意圖理解 Agent，最後把 Loop State 升級為 append-only + Checkpoint + 雙軌 Handoff + 外部狀態同步。整體約 13.5 周；MVP 可壓到 6 周。
