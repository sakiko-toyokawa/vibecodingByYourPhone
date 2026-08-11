# Loop Executor 空產出偵測設計

> 狀態：已實作（2026-08-09）
> 日期：2026-08-09
> 優先順序：P0

## 一、背景與現狀

`watchProcess` 已收集 `finalText`、runtime events、usage 與 `ok`。但 verification 目前可能因 static lint 通過而把 executor 403 / 空產出判成 `complete`。問題在於驗證層缺少「executor 到底產出了什麼證據」的訊號。

## 二、設計決策

### 2.1 ExecutionOutcome 增加證據摘要

設計 `ExecutionOutcome` 增加：

```ts
evidence: {
  has_final_text: boolean;
  has_runtime_events: boolean;
  has_diff: boolean;
  has_required_artifacts: boolean;
}
producedEvidence: boolean;
```

`producedEvidence` 為 true 的條件：

- `has_final_text` 且 finalText 去除空白後非空；
- 或 `has_runtime_events`；
- 或 `has_diff`；
- 或 `has_required_artifacts`。

### 2.2 判定規則

- adapter error 或 process crash：維持 `runtime_blackbox_error`。
- executor 正常結束但 `producedEvidence === false`：驗證結果不得為 `passed`。
- 空產出且無錯誤：合成 `inconclusive + requires_human`，failure tag 為 `verification_error`。
- 若 card 的 `observability.required_artifacts` 有值，且任一必要 artifact 存在，即使 finalText 空也算有證據。

### 2.3 Read-only 掃描例外

read-only 掃描不一定產生 diff。只要 finalText 或 required artifact 存在，就不觸發空產出。不要用「沒有 diff」直接判空。

## 三、介面與資料流

```text
watchProcess()
  -> ExecutionOutcome.evidence
  -> verifyRun input bundle
  -> aggregateVerifierReports()
  -> producedEvidence false => inconclusive + requires_human
```

## 四、邊界與失敗模式

- exit 0 + 空 stdout + 無 artifact：不 complete。
- 403 + 空 stdout：failure tag 為 `runtime_blackbox_error`。
- read-only report 只有 finalText：仍可 complete。
- 只有 runtime events 但沒有最終文字：視為有證據，但由 verifier 判斷內容品質。
- 舊 ledger / 舊 outcome 缺 evidence 欄位：視為 `has_final_text` legacy 相容，不回填。

## 五、驗收標準

- 新增行為 case：空產出 run 不進入 complete。
- 新增行為 case：403 空產出 run 帶 `runtime_blackbox_error`。
- 新增行為 case：read-only finalText 掃描仍可 complete。
- `verify-run` 與 `control-plane` 的 decision 可讀到空產出原因。
