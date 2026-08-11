# Loop Token / Provider 成本熔斷設計

> 狀態：已實作（2026-08-09）
> 日期：2026-08-09
> 優先順序：P1

## 一、背景與現狀

`BudgetSchema.max_tokens` 已記錄 `used_tokens` 並在 turn 間檢查。但沒有在 turn 開始前預檢、執行中用量突破時中止、或向使用者發出接近上限的警告，可能造成 provider 成本超出預期。

## 二、設計決策

### 2.1 兩道閘門

- Turn 前預檢：`max_tokens > 0` 且 `used_tokens >= max_tokens` 時不啟動下一 turn，轉 `budget_limited`。
- 執行中監控：runtime event 的 token usage 累計後若超過 `max_tokens`，終止 process 並轉 `budget_limited`。

### 2.2 告警比例

- 新增 config `LOOP_TOKEN_ALERT_RATIO`，預設 `0.9`。
- `used_tokens / max_tokens >= ratio` 時觸發既有 `loop-budget-warning`。
- 告警只發一次，避免同一 turn 重複刷事件。

### 2.3 Provider 限制

- provider 不保證提供硬式中斷 API；執行中熔斷以 `process.abort()` / kill 為兜底。
- 不新增 per-provider token 計費猜測；usage 以 runtime result 的 `input_tokens + output_tokens` 為準，缺省 `null` 不編造。
- 未來若要 provider 層配額，先由 adapter capability snapshot 決定是否支援。

## 三、介面與資料流

```text
before next turn
  -> used_tokens >= max_tokens => budget_limited
  -> ratio reached => loop-budget-warning
during turn
  -> usage event
  -> cumulative usage > max_tokens => terminate process
  -> decision ledger budget_limited
```

## 四、邊界與失敗模式

- `max_tokens: 0`：維持「不追蹤」語意，不套用熔斷。
- usage event 缺欄位：維持 null，不假設已用 token。
- 執行中超過上限與 executor 同時完成：以先到的 `budget_limited` 為準。
- 告警寫入失敗：不阻擋 run，但記錄 warning。

## 五、驗收標準

- 超過 `max_tokens` 的 run 不會啟動下一 turn。
- 執行中超過 `max_tokens` 時 process 被終止並落 `budget_limited`。
- 比例到達 0.9 時只發一次 warning。
- 既有 token budget 帳本 shape 不變。
