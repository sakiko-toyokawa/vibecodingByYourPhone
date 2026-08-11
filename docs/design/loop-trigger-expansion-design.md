# Loop Trigger 擴展設計

> 狀態：核心已實作（2026-08-09）
> 日期：2026-08-09
> 優先順序：P1

## 一、背景與現狀

目前 `manual` 與 `schedule` 有真實消費者；`webhook` / `resume` 仍只有 enum，`schedule.queue` 已有 memory-only 排隊。缺少外部事件入口、持久化 queue 與 resume 語義。

## 二、設計決策

### 2.1 Webhook 入口

新增 `POST /api/loops/:id/triggers`：

```json
{
  "source": "webhook",
  "event_id": "github-issue-123",
  "payload": {
    "issue": { "title": "...", "body": "..." }
  }
}
```

- `event_id` 是冪等鍵；相同 event_id 只觸發一次。
- `source` 支援 `webhook` / `issue` / `resume`。
- v1 沿用既有 API 認證；外部系統可另設 `LOOP_WEBHOOK_SECRET`。
- `issue` 是 webhook 事件的來源分類，不新增 `trigger.type` 的 `"issue"` 值。

### 2.2 持久化 Queue

- 新增 `loops/trigger/queue.jsonl`。
- 每筆 entry 含 `event_id`、`loop_id`、`source`、`priority`、`enqueued_at`、`state`。
- 同 loop 仍串行；忙碌時進 queue，空閒時依 `schedule.queue` 優先順序補點。
- queue 重啟後保留，不再 memory-only。

### 2.3 Resume Trigger

- `source: "resume"` 的 payload 必須帶 `run_id`。
- 只允許 resume `paused` / `budget_limited` run；其他狀態回 409。
- resume trigger 走既有 control-plane resume 路徑，不建立新 run。

### 2.4 Missed Trigger

- schedule 維持不補跑。
- webhook 事件若已成功入 queue 但 run 尚未啟動，重啟後仍補點。
- 事件處理成功後從 queue 移除；失敗保留並寫失敗次數。

## 三、介面與資料流

```text
POST /api/loops/:id/triggers
  -> validate event_id
  -> append queue.jsonl
  -> scheduler dispatch
  -> manual run or resume
```

## 四、邊界與失敗模式

- 重複 event_id：回傳 200 / accepted，不建立第二個 run。
- loop 已 paused / archived：409。
- resume 指向不存在或非阻塞 run：409。
- queue 寫入失敗：不觸發 run，避免丟失外部事件。
- 外部事件 payload 過大：上限 256KB，超過回傳 400。

## 五、驗收標準

- webhook event 可建立 run，且同 event_id 不重複觸發。
- 忙碌 loop 的 webhook event 會排隊並在空閒後執行。
- 重啟後未處理的 webhook event 仍存在。
- resume trigger 可恢復 paused run，但不能建立新 run。
