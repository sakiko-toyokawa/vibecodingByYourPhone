# Loop Runtime Evaluation — 示例追蹤報告

任務 prompt：

> Fix the lint error

參數：`--lint-fails --max-turns 2 --max-retries 1`

## 執行摘要

| 項目 | 值 |
|---|---|
| run_id | `run-20260728T105029Z-cba9aec6` |
| loop_id | `eval-...` |
| final_state | `budget_limited` |
| terminal | true |
| elapsed_ms | ~1248 |
| stage_score | **6.5 / 8** |

## 狀態流轉（stateTrace）

```text
active → retry → active → retry → budget_limited
```

- turn 1：static 驗證失敗 → judgment `failed/retryable` → control plane 決定 `retry`
- turn 2：同樣失敗 → 已無剩餘 retry 預算 → control plane 決定 `budget_limited`

## 各環節評分

| Stage | Passed | Score | Reason |
|---|---|---|---|
| trigger | ✅ | 1.0 | Run 成功創建 |
| contract | ✅ | 1.0 | Intent contract artifact 已落盤 |
| assembly | ✅ | 1.0 | Runtime input bundle 已裝配 |
| execution | ✅ | 1.0 | Execution turn 完成 |
| verification | ❌ | 0.5 | Verifier reports 有產出，但 static phase failed |
| judgment | ❌ | 0.5 | Judgment overall=failed, next_action=retry |
| control_decision | ❌ | 0.5 | 最終狀態為 budget_limited，未達成任務 |
| state_persistence | ✅ | 1.0 | loop-state-changed 事件已發射並持久化 |

## 關鍵證據

- `verifier-output-static-0.log`：

```text
$ pnpm run lint
cwd: ...\yep-loop-runtime-HOpb9R
outcome: exit (exit 1) in 366ms
```

- `judgment-report.json`：

```json
{
  "overall": "failed",
  "next_action": "retry",
  "retryable": true
}
```

- `verifier-report-static.json`：

```json
{
  "verifier_phase": "static",
  "status": "failed",
  "recommendation": "retry"
}
```

## 結論

Loop 管線本身沒有崩潰，所有環節都「正常運轉」，但任務沒有完成：

- **根因**：workspace 的 lint 腳本持續失敗，loop 雖然正確觸發了 retry，但預算（max_retries=1）耗盡後進入 `budget_limited`。
- **不過關的標準**：verification / judgment / control_decision 雖然都產出了結果，但結果是失敗/預算耗盡，因此評分分別為 0.5。
- **下一步**：要讓該 prompt 真正過關，需要讓 runtime 在 retry 時修復 lint 錯誤，或放寬預算並確保 retry 證據能引導模型正確修改。
