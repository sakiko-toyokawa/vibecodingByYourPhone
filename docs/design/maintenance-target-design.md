# Generic External-Drive Maintenance Target Design

> 狀態：設計定稿，v1 foundation 實作中
> 日期：2026-08-12

## Goal

讓 loop 不只是 GitHub PR 專用，而是能由 agent 判斷「這個用戶目標需要長期維護」後，
自動註冊一個外部驅動的 maintenance target。Loop 進入等待狀態；外部事件到達時，
由通用 event gateway 解析 target、寫入既有 trigger queue、喚醒同一個 loop，
並以 target context 執行維護。

## Data Model

新增通用 `MaintenanceTarget`，持久化在 `loops/maintenance/targets.json`：

```ts
interface MaintenanceTarget {
  target_id: string;
  loop_id: string;
  target_type: string;           // github_pr | generic_webhook | ...
  external_ref: Record<string, unknown>;
  state: "waiting" | "waking" | "fixing" | "needs_human" | "done";
  feedback_cursor: Record<string, unknown>;
  feedback_count: number;
  repair_count: number;
  wake_policy: {
    trigger_types: string[];
    max_repairs: number;
  };
  context_payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
```

`RelationStore` 已改為 GitHub 專用 adapter facade；既有 `relations.json`
會遷移到 `MaintenanceTargetStore`，`/api/github/relations*` 不中斷。
GitHub PR 以 `target_type: "github_pr"` 的 `MaintenanceTarget` 為單一事實來源。

## Agent Registration

Executor 在 run 完成時可輸出：

```text
<<<MAINTENANCE-REQUEST>>>
{
  "target_type": "generic_webhook",
  "external_ref": { "source": "ops", "subject_id": "deploy-42" },
  "wake_policy": { "trigger_types": ["deploy_ready"], "max_repairs": 3 },
  "context_payload": { "expected_endpoint": "https://ops.internal/status/42" }
}
<<<END-MAINTENANCE-REQUEST>>>
```

Controller 驗證 schema 後自動註冊，狀態為 `waiting`。註冊本身不需要人工核准；
外部副作用仍由 target-scoped policy 與 hard gate 管制。無合法 block 不註冊。

## Event Gateway

通用外部事件入口：

```http
POST /api/maintenance/events
Content-Type: application/json
```

```json
{
  "source": "generic_webhook",
  "target_id": "target-1",
  "event_id": "event-1",
  "payload": { "status": "ready" }
}
```

解析規則：

- `target_id` 優先；缺省時以 `external_ref.source + subject_id` 查詢。
- 找不到 target 回 404 / `target_not_found`。
- `event_id` 重複時不建立第二個 trigger。
- 找到 target 後寫入 `TriggerQueueStore`，payload 帶 `maintenance_id`，
  然後呼叫 `drainPendingTriggers`。

## Wake Semantics

```text
external event
  -> MaintenanceTargetStore resolve
  -> TriggerQueueStore.enqueue
  -> drainPendingTriggers
  -> LoopRunService.startRun(loopId, source, { maintenanceId })
  -> RunExecutionContext.maintenanceTarget
  -> assembly prompt 切換維護模式
  -> run 完成後 target 回到 waiting / needs_human / done
```

同 loop 仍串行；run 忙碌時事件保留在 queue。`event_id` 是冪等鍵。target 與
queue 都持久化，服務重啟後可恢復。

## Policy Scope

policy 從 relation-scoped 泛化為 target-scoped：

- `github_pr`：沿用 relation 的 branch / PR comment scope。
- `generic_webhook`：只允許 `context_payload.allowed_commands` 中列出的命令。
- 硬 gate 不變：未核准的 push / PR create / comment / close 仍升級人工。

## GitHub Adapter Migration

- 第一階段保留 `RelationStore` 與既有 GitHub API。
- 通用事件 gateway 可解析 `github_pr` target 後，再映射回 relation 的
  `relation_id`，由現有 GitHub flow 執行。
- 後續若需要單一 source of truth，再把 `RelationStore` 改為
  `MaintenanceTargetStore` 的 GitHub adapter facade；此步不阻塞 v1。
