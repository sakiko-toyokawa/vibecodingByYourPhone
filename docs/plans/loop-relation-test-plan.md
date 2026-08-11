# Loop Relation Maintenance Test Plan

> 狀態：前 4 項測試計劃已定案；第 5 項留待單獨討論

## 1. Unit Tests

範圍：

- `RelationStore`：upsert、findById、findByGitHubPr、updateState、持久化重載。
- `TriggerDispatcher`：webhook event 帶 `relation_id` 時傳給 `startRun`。
- `GitHubRoutes`：
  - webhook 對已知 relation enqueue
  - publish draft PR 成功後建立 relation
  - 缺少 approval 拒絕 publish
- `RelationPoller`：
  - 新 comment/review enqueue
  - merged/closed 轉終態
  - 重複 feedback 超過上限轉 `needs_human`
- `PolicyArbiter`：relation-scoped push/comment 放行，其他 branch/repo 仍 hard gate。
- `RuntimeAssembly`：有 relation context 時 prompt 進入維護模式。

命令：

```powershell
pnpm exec tsx --test `
  packages/server/src/loop/relation/relation-store.test.ts `
  packages/server/src/loop/relation/relation-poller.test.ts `
  packages/server/src/loop/trigger/trigger-dispatcher.test.ts `
  packages/server/src/routes/github.test.ts `
  packages/server/src/loop/policy/arbiter.test.ts `
  packages/server/src/loop/assembly/runtime-input.test.ts
```

## 2. Static Checks

範圍：

- server typecheck
- biome lint/format

命令：

```powershell
pnpm exec tsc --noEmit -p packages/server/tsconfig.json
pnpm exec biome check packages/server/src
```

## 3. Integration Tests

範圍：

- relation event -> trigger queue -> dispatcher -> startRun(relationId)
- relation context 進入 run execution
- run 完成後 relation state 更新
- publish draft PR 建立 relation 的 route integration

現有測試：

- `routes/github.test.ts`
- `trigger-dispatcher.test.ts`
- `relation-poller.test.ts`

需補：

- 一個 fake Supervisor + fake GitHubClient + real RelationStore/TriggerQueueStore 的
  relation maintenance integration test，驗證「event -> run -> state update」。

## 4. Real End-to-End Verification

使用自己的測試 repo 或現有 fork PR 驗證：

1. 建立 relation
2. 對 PR 留言
3. 觸發 `POST /api/github/webhook` 或等 `RelationPoller`
4. 確認 loop run 啟動
5. 確認 agent 讀到 feedback
6. 確認 branch 更新
7. 確認 PR 被 comment
8. 確認 relation state 回到 `awaiting_feedback`

此項需要 server 已重啟並載入最新 code，且使用真實 PAT。

## 5. Deferred: Full Relation Maintenance Integration

留待單獨討論：

- 完整 multi-turn relation run 測試
- cursor 應在 run 成功後更新，而不是 enqueue 時更新
- restart 後的 pending relation events 統一恢復
- relation-scoped policy 與 hard gate 的完整行為矩陣
