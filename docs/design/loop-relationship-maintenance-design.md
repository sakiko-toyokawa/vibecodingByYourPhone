# Loop Relationship Maintenance Design

> 狀態：v1 foundation、cron poller、relation-scoped policy 已實作

## Goal

讓 loop 不只是「找 issue、修 bug、發 PR」的一次性 run，而是能長期維護已建立的
外部關係。PR 建立後 loop 進入等待；收到 GitHub review / comment / CI 事件後，
以持久化 relation state 冷啟動新 run，讀取 feedback 並修復。

## Data Model

新增 `RelationStore`，持久化在 `loops/relations/relations.json`：

```json
{
  "relation_id": "rel-oma-488",
  "loop_id": "github-agent-maintainer",
  "subject": {
    "type": "github_pr",
    "repository": "open-multi-agent/open-multi-agent",
    "issue_number": 488,
    "pr_number": 490,
    "branch": "fix/488-isolate-oma-model-in-runtime-tests"
  },
  "state": "awaiting_feedback",
  "last_processed": {},
  "feedback_count": 0,
  "repair_count": 0
}
```

Relation state 獨立於 run state；每次 run 完成仍可為 `complete`，relation 是否繼續
等待由 `RelationStore` 決定。

## Event Flow

```text
GitHub webhook
  -> POST /api/github/webhook
  -> verify signature
  -> repo + pr_number -> RelationStore
  -> TriggerQueueStore
  -> drainPendingTriggers
  -> startRun(loopId, webhook, { relationId })
  -> executeRun
  -> runtimeContext.relation -> prompt
  -> agent reads feedback and fixes
```

## Implemented APIs

- `POST /api/github/webhook`: GitHub event entry.
- `RelationPoller`: 每 5 分鐘掃描 `awaiting_feedback` relation，發現新
  comments / reviews 時 enqueue trigger；PR merged/closed 時轉終態。
- relation-scoped policy：只允許 push 同 relation branch、回覆同 PR comment。
- `POST /api/github/relations`: create or update a relation.
- `POST /api/github/publish/draft-pr`: accepts `relation_id` / `loop_id` and creates
  relation after PR creation.
- `POST /api/loops/:id/runs`: accepts optional `relation_id`.
- `POST /api/loops/:id/triggers`: accepts optional `relation_id`.

## Remaining Work

- Feedback cursor 目前由 poller 在 enqueue 時更新；更嚴謹的做法是等 relation
  run 成功後再更新，避免 run 失敗時丟失 feedback。
- 完整 restart recovery 仍需把 persistent trigger queue 與 relation state 一起
  做統一恢復檢查。
