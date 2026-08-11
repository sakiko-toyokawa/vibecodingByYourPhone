# Loop Relationship Maintenance Design

> 狀態：v1 foundation 已實作；cron poller 與 relation-scoped policy 尚未落地

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
- `POST /api/github/relations`: create or update a relation.
- `POST /api/github/publish/draft-pr`: accepts `relation_id` / `loop_id` and creates
  relation after PR creation.
- `POST /api/loops/:id/runs`: accepts optional `relation_id`.
- `POST /api/loops/:id/triggers`: accepts optional `relation_id`.

## Remaining Work

- Cron subscriber: scan `awaiting_feedback` relations and poll GitHub API for new
  comments / reviews / commits / CI status.
- Relation-scoped policy: allow push/comment only for the active relation branch
  and PR.
- Restart recovery for relations: on startup, re-queue pending relation events.
- Feedback cursor updates after a successful maintenance run.
- Dead-loop guard: repeated identical feedback should transition to
  `needs_human`.
