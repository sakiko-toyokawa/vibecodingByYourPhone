# 分層 Verifier 設計文檔

> 基於現有 Loop 驗證鏈路的漸進式改造方案：確定性檢查 → LSP/結構/Schema 檢查 → Verifier Agent 語義評判。
> 版本：v1.1 | 日期：2026-08-09
> 實作狀態：Phase 0-7 已落地；本文件保留設計演進脈絡，現況以 `loop-production-readiness-index.md` 為索引。

---

## 一、背景與現狀

目前 `packages/server/src/loop/verification/` 已經實作了兩段確定性驗證：

- `static`：lint、typecheck 等靜態命令（`subprocess-verifier.ts`）。
- `runtime`：test 等運行時命令（`subprocess-verifier.ts`）。
- `interaction`：`InteractionAgentStrategy` 產生 Playwright 驗證腳本並由子程序執行。
- `review`：Verifier Agent 以 read-only plan session 輸出結構化 verdict；collector 僅保留證據採集角色。

現有瓶頸：

1. 沒有 **結構層**（L3）：無法檢查循環依賴、跨層引用、介面契約、API Schema 一致性。
2. 沒有 **語義層**（L4）：無法判斷「產出是否符合需求描述、邊界是否覆蓋、風格是否一致」。
3. `review` 段已由 Verifier Agent 產生結構化 verdict；collector 與 judge 的兩次 LLM 調用仍是成本優化空間。

本設計目標是在不改動控制面狀態機與 retry 鏈路的前提下，把驗證層擴展為 **L1 確定性 → L2 規則 → L3 結構 → L4 語義** 的四層模型。

---

## 二、設計目標

1. **確定性優先**：L1 失敗直接短路，不浪費 LSP / Agent 成本。
2. **結構可檢查**：利用 LSP、AST、依賴圖、Schema 驗證，把「架構合規」變成可執行檢查。
3. **語義可評判**：引入 read-only Verifier Agent，按固定 Rubric 輸出結構化 VerifierReport。
4. **無縫接入現有鏈路**：新增 phase/strategy 後，`verify-run.ts` → `aggregate.ts` → `control-plane` → `run-service` 的 retry 流程不變。

---

## 三、整體架構

```
Maker（Executor Session）
    ↓ 產出 workspace diff / stdout / runtime events
┌─────────────────────────────────────────┐
│ L1 確定性檢查（Deterministic）            │  ← static / runtime 子程序
│ • npm run lint / pnpm typecheck          │
│ • pytest / npm test                      │
│ • exit 0 = passed, 非 0 = failed          │
└─────────────────────────────────────────┘
    ↓ 全部通過
┌─────────────────────────────────────────┐
│ L2 規則檢查（Rule-Based）                 │  ← 可選，輕量正則/函數規則
│ • 無硬編碼密鑰                           │
│ • API 路徑符合約定                       │
│ • 命名規範                               │
└─────────────────────────────────────────┘
    ↓ 全部通過
┌─────────────────────────────────────────┐
│ L3 結構檢查（Structural）                 │  ← 新增 structural phase
│ • LSP diagnostics（型別錯誤、未定義引用） │
│ • 專案依賴圖（禁止循環依賴、跨層引用）    │
│ • Schema 驗證（API / JSON Schema）        │
└─────────────────────────────────────────┘
    ↓ 全部通過
┌─────────────────────────────────────────┐
│ L4 語義檢查（Semantic / Verifier Agent）  │  ← review phase 改造
│ • 需求對齊                               │
│ • 邊界覆蓋                               │
│ • 風格一致性                             │
│ • 邏輯漏洞（對抗性審查）                  │
└─────────────────────────────────────────┘
    ↓
aggregateVerifierReports() → judgment_report
    ↓
control-plane → retry / needs_human / complete
    ↓
run-service buildRetryContext() → 下一輪 turn prompt
```

---

## 四、與現有系統的對接

### 4.1 Phase 擴展

現有 `VerificationPhaseSchema`（`packages/shared/src/loop-schema/loop-card.ts:9`）：

```typescript
export const VerificationPhaseSchema = z.enum([
  "static",
  "runtime",
  "interaction",
  "review",
]);
```

擴展為：

```typescript
export const VerificationPhaseSchema = z.enum([
  "static",      // L1 確定性靜態檢查
  "runtime",     // L1 確定性運行時檢查
  "rule",        // L2 規則檢查（可選）
  "structural",  // L3 結構/語義關係檢查（新增）
  "interaction", // InteractionAgentStrategy：Playwright 腳本生成 + 執行
  "review",      // L4 Verifier Agent（改造）
]);
```

一張 card 可以宣告：

```yaml
verification:
  required: [static, runtime, structural, review]
```

`verify-run.ts:133` 會按順序執行，並在任一 phase hard-fail 時短路後續 phase（現有邏輯已支援）。

### 4.2 Strategy 擴展

現有 strategy 介面（`packages/server/src/loop/verification/strategy.ts:37`）不變：

```typescript
export interface VerificationStrategy {
  readonly name: string;
  verify(input: VerificationInput): Promise<VerifierReport>;
}
```

新增 strategies：

| Strategy | Phase | 職責 |
|---|---|---|
| `SubprocessStrategy` | static / runtime | 現有，執行命令 |
| `RuleBasedStrategy` | rule | 執行 `.verifier/rules.json` 或 card 內嵌規則 |
| `StructuralStrategy` | structural | LSP / AST / 依賴圖 / Schema |
| `VerifierAgentStrategy` | review | read-only LLM judge |

`strategy-selector.ts:18` 根據 card 配置與 workspace 內容選擇合適 strategy。例如：

- TypeScript 專案 → `SubprocessStrategy` + `StructuralStrategy`。
- 沒有測試命令的 workspace → 退到 `ContractCriteriaStrategy` / `FileExistenceStrategy`。
- card 的 `verification.required` 包含 `review` → 啟動 `VerifierAgentStrategy`。

### 4.3 Verifier Agent 設計

Verifier Agent 是 **read-only agent**：

- **工具權限**：僅 Read / Grep / Glob，mode 為 `plan`。
- **上下文**：只給判斷所需的最小資訊：
  - `IntentContract.task` + `success_criteria`
  - 本輪 diff / stdout / runtime events / L1-L3 reports
  - 上一輪 `judgment_report`（避免重複錯誤）
  - `AGENTS.md` / `CLAUDE.md` 規則
- **輸出**：嚴格 JSON，對應 `VerifierReport` schema（`packages/shared/src/loop-schema/verification.ts:61`）。
- **Rubric**：

```json
[
  { "criterion": "需求對齊", "weight": 0.4 },
  { "criterion": "邊界覆蓋", "weight": 0.3 },
  { "criterion": "風格一致性", "weight": 0.2 },
  { "criterion": "無邏輯漏洞", "weight": 0.1 }
]
```

實作上可參考現有 `runCollector`（`run-service.ts:2496`），但 prompt 與輸出解析要嚴格：

```typescript
const report = VerifierReportSchema.parse(agentOutput);
```

無效輸出視為 `inconclusive` + `escalate`，不可直接相信自然語言結論。

### 4.4 聚合與下一輪

現有 `aggregateVerifierReports`（`packages/server/src/loop/verification/aggregate.ts:38`）已支援多份 report 聚合：

- overall = worst status
- requires_human 優先
- next_action 決定 retry / complete / needs_human

Verifier Agent 的 report 與 L1-L3 report 一起進入聚合。若最終 `next_action === "retry"`，`run-service.ts:386` 的 `buildRetryContext` 會把 `judgment_report` 全文注入下一輪 prompt。

---

## 五、輸入輸出合約

### 5.1 Verifier Agent 輸入

```typescript
interface VerifierAgentInput {
  requirement: {
    text: string;              // 原始需求
    success_criteria: string[];
    constraints: string[];
  };
  output: {
    workspacePath: string;     // 執行器產出所在目錄
    diffRef: string | null;
    stdoutRef: string | null;
    runtimeEventsRef: string | null;
  };
  context: {
    projectRules: string;      // CLAUDE.md / AGENTS.md
    previousJudgment: JudgmentReport | null;
    l1l3Reports: VerifierReport[]; // 下層已通過的證據
  };
}
```

### 5.2 Verifier Agent 輸出

必須符合現有 `VerifierReport` schema：

```typescript
interface VerifierReport {
  verifier_phase: "review";
  status: "passed" | "failed" | "inconclusive";
  evidence_refs: string[];
  unresolved_risks: string[];
  recommendation: "retry" | "stop" | "escalate";
  confidence: number;          // 0.0 ~ 1.0
  requires_human: boolean;
}
```

---

## 六、各層詳細設計

### 6.1 L1 確定性層

沿用現有 `SubprocessStrategy`，命令來源：

1. card 明確配置：`card.loop.verification.commands.static / runtime`。
2. 自動探測：`detectProjectType` + `detectCommandsForProjectType`（`strategy-selector.ts:18`）。
3. 合約成功標準：當沒有命令時，退到 `ContractCriteriaStrategy` / `FileExistenceStrategy`。

短路規則已存在（`verify-run.ts:131`）：L1 hard-fail 不執行後續 phase。

### 6.2 L2 規則層（可選）

輕量規則引擎，不啟動語言服務：

```typescript
interface RuleCheck {
  name: string;
  pattern: RegExp | ((content: string) => boolean);
  severity: "error" | "warning";
  message: string;
}
```

規則來源：

- 專案級：`.verifier/rules.json`（可選）。
- Card 級：`card.loop.verification.rules`（可選）。

`error` 視為 failed，`warning` 記錄但不阻塞。

### 6.3 L3 結構層

`StructuralStrategy` 內部可拆多個 checker：

#### 6.3.1 LSP Diagnostics

針對 TypeScript / Python / Rust 等語言啟動對應 language server：

- TypeScript：`tsc --noEmit`（cheap）或 `tsserver`（完整）。
- Python：`pyright --outputjson`。
- Rust：`cargo check`。

輸出歸一化為：

```typescript
interface Diagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning";
}
```

#### 6.3.2 專案圖分析

使用 `ts-morph` / `madge` / `dependency-cruiser` 分析：

- 循環依賴。
- 跨層引用（如 `controller` 直接引用 `mapper`）。
- 介面實現是否與契約一致。

```typescript
interface ProjectGraphCheck {
  name: string;
  status: "pass" | "fail";
  detail: unknown;
}
```

#### 6.3.3 Schema 驗證

- JSON Schema：驗證 config / response 檔案。
- OpenAPI：驗證路由與 handler 參數一致性（可選）。

### 6.4 L4 語義層

`VerifierAgentStrategy` 實作要點：

1. **Fresh Context**：不帶完整對話歷史，只帶輪次相關證據。
2. **不同模型家族**：建議 Verifier Agent 與 Maker 使用不同 provider/model，減少共享失敗。
3. **Rubric 評分**：不要簡單 yes/no，按維度評分並給出 confidence。
4. **對抗性審查**：prompt 中可加入「請找出能欺騙本 verifier 的漏洞」步驟。
5. **輸出約束**：強制 JSON，無效輸出視為 `inconclusive`。

---

## 6.5 Fail-closed 語意

`VerifierReport.status` 增加 `unverified`，與 `passed` / `failed` /
`inconclusive` 明確區分：

- `passed`：已用支援的檢查實際驗證過。
- `failed`：檢查執行成功並發現錯誤。
- `inconclusive`：檢查執行過但無法得出確定結論。
- `unverified`：沒有可用的語言/toolchain/checker，或沒有可執行驗證
  命令；系統沒有能力驗證這個 phase。

聚合順序為 `failed > unverified > inconclusive > passed`。`unverified`
不 retry、不 complete，控制面走 escalate/needs_human；failure tag 映射為
`verification_error`。目的是避免小眾語言在 L1 因「未知專案型別 + 空命令」
靜默 vacuous pass。

---

## 七、實施路線圖

| 階段 | 時間 | 內容 | 產出 |
|---|---|---|---|
| **Phase 1** | 3 天 | 擴展 `VerificationPhaseSchema`，新增 `structural` 與 `rule`；`verify-run.ts` 支援新 phase | schema 與編排層就緒 |
| **Phase 2** | 5 天 | 實作 `RuleBasedStrategy` 與 `StructuralStrategy`（LSP + 依賴圖 + Schema）| 可運行的 L2/L3 檢查 |
| **Phase 3** | 5 天 | 實作 `VerifierAgentStrategy`，對接 Supervisor plan-mode session | L4 Judge 可輸出 VerifierReport |
| **Phase 4** | 3 天 | 調整 `strategy-selector.ts`，根據專案類型自動選擇策略 | 自動化策略選擇 |
| **Phase 5** | 3 天 | 接入 `aggregate.ts`，確保 retry context 正確傳遞；補測試 | 全鏈路驗收通過 |
| **Phase 6** | 持續 | Rubric 調優、對抗性樣本累積、錯誤模式歸類 | 準確率提升 |

**總計：約 3 周完成 MVP，6 周達到可上線。**

---

## 八、驗收標準

| 檢查項 | 通過標準 |
|---|---|
| L1 可靠性 | 合法程式碼不被誤判為 failed；誤報率 < 1% |
| L2 可配置 | 新增規則只需改 JSON/配置，不動程式碼 |
| L3 準確性 | 循環依賴 / 型別錯誤檢出率 > 95%，誤報 < 5% |
| L4 穩定性 | Agent 輸出不符合 schema 的比率 < 2% |
| 成本可控 | L4 只在 L1-L3 全過後執行；平均驗證成本 < Maker 生成成本 30% |
| 零副作用 | Verifier Agent 運行前後 workspace 檔案 MD5 不變 |
| Retry 有效 | Maker 從 judgment_report 理解問題並在下一輪修復的成功率 > 70% |

---

## 九、風險與緩解

| 風險 | 影響 | 緩解 |
|---|---|---|
| LSP 啟動慢 | 每輪驗證時間增加 | 使用 `tsc --noEmit` / `pyright` 等一次性命令優先；LSP 只做進階 reference 檢查 |
| Agent 誤殺合法程式碼 | 無效 retry、浪費預算 | 初期 Agent 只做 warning，不阻塞；累積足夠樣本後再轉 hard fail |
| Agent 輸出不穩定 | 無法解析 verdict | 強制 JSON + Zod 驗證；解析失敗視為 `inconclusive` + `escalate` |
| 不同語言支援成本 | StructuralStrategy 維護困難 | 按專案類型插件化；先支援 TypeScript，再擴展 Python / Rust |
| 與現有 collector 混淆 | review phase 語義不清 | collector 保留為「證據採集/摘要」；review verdict 由 VerifierAgentStrategy 專責 |

---

## 十、一句話總結

> 在現有 `static/runtime` 確定性驗證之上，新增 `rule` / `structural` phase 處理規則與 LSP/結構/Schema 檢查，再把 `review` phase 改造成 read-only Verifier Agent；所有層級都輸出標準 `VerifierReport`，經既有 `aggregate.ts` 與 `control-plane` 決策後，透過 `run-service` 的 retry context 傳給下一輪。核心原則：**確定性檢查做硬地板，LSP 做結構合規，Agent 只做語義評判，且 Agent 不允許修改任何檔案。**
