# Loop Restart 防護設計

> 狀態：已實作（2026-08-09）
> 日期：2026-08-09
> 優先順序：P1

## 一、背景與現狀

`POST /api/server/restart` 目前直接 `process.exit(0)`。Loop 已有 restart recovery，但 active/retry run 在重啟過程仍會中斷執行程序；若首輪 context 尚未可恢復，使用者會以為 run 憑空消失。

## 二、設計決策

### 2.1 Restart 端點保護

- 有 active/retry loop run 時，`POST /api/server/restart` 回傳 409。
- 回應 shape：

```json
{
  "error": "active_loop_runs",
  "active_loop_runs": [
    { "loop_id": "loop-a", "run_id": "run-123", "state": "active" }
  ]
}
```

- 支援 `?force=true`；force 時允許重啟，並明確依賴 restart recovery。
- 不自動 pause/resume；先由使用者決定是否暫停，避免隱式行為造成預算或檔案狀態意外。

### 2.2 UI 行為

- ReloadBanner 取得 409 後顯示 active loop run 清單。
- 提供「先暫停 active loop 再重啟」與「強制重啟」兩個動作。
- 文字明確寫出 loop run 會被中斷，不再只說 active sessions。

### 2.3 快捷鍵

- `Ctrl+Shift+R` 在沒有 backend dirty 時只重新載入前端。
- 需要重啟 backend 時走 ReloadBanner 的明確按鈕與確認流程。

## 三、介面與資料流

```text
POST /api/server/restart
  -> serverAdmin.checkActiveLoopRuns()
  -> active/retry present && !force => 409
  -> force or no active runs => flush + exit
```

## 四、邊界與失敗模式

- active/retry run 存在且未 force：409。
- run 在檢查與 exit 之間開始：以 `force=true` 或短暫 pause-all 為兜底。
- needs_human / paused / budget_limited：不阻擋 restart，狀態已持久化。
- restart recovery 本身失敗：既有 `failRun` 安全網保留。

## 五、驗收標準

- active run 時 restart 回傳 409。
- `force=true` 可重啟並在重啟後觸發 restart recovery。
- paused / needs_human 不阻擋 restart。
- UI 對 loop run 顯示專屬中斷警告。
