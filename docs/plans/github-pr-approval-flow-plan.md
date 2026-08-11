# GitHub PR Approval Flow Plan

## Goal

讓 GitHub loop 從「PR-ready」到「真的提交 PR」進入明確的等待人工批准狀態，而不是只靠 API 外的 `approved: true`。

## Current Gap

- run 完成後只產出 PR-ready summary。
- 沒有自動把 PR payload 存入 relation。
- 沒有 `pr_pending_approval` 的自動轉換。
- 前端沒有「Approve PR」按鈕。
- 目前只能手動呼叫 `POST /api/github/publish/draft-pr` 並帶 `approved: true`。

## Target Flow

```text
run complete
-> 驗證 PR-ready payload
-> relation.state = pr_pending_approval
-> 前端顯示 Approve & Publish Draft PR
-> 人工批准
-> POST /api/github/publish/draft-pr
-> relation.state = awaiting_review
-> 前端顯示 Mark Ready for Review
-> 人工確認
-> relation.state = awaiting_feedback
```

## Key Changes

### 1. RelationStore
`RelationState` 新增：

```text
awaiting_review
```

`RelationRecord` 新增：

```ts
pending_publish?: {
  repository: string;
  branch: string;
  title: string;
  body: string;
  cwd: string;
  run_id: string;
  created_at: string;
}
```

### 2. PR Payload 產出
執行器在最終報告中寫入結構化 PR publish payload，例如：

```text
<<<PR-PUBLISH>>>
{"repository":"...","branch":"...","title":"...","body":"..."}
<<<END-PR-PUBLISH>>>
```

run-service 在 run complete 時：

- 解析 PR payload。
- 寫入 relation。
- 將 relation 設為 `pr_pending_approval`。
- 沒有 payload 時維持原有 PR-ready summary，不自動 publish。

### 3. API
新增：

```text
GET  /api/github/relations/:id
POST /api/github/relations/:id/approve-pr
```

`approve-pr` 行為：

- relation 必須是 `pr_pending_approval`。
- 有 `pending_publish`。
- 呼叫現有 GitHub publish 邏輯。
- 成功後 state 轉 `awaiting_feedback`。
- 失敗保留 `pr_pending_approval` 並回傳錯誤。

### 4. Frontend
兩個地方顯示 PR action：

- `/github` 的 GitHub Relations 卡片。
- `/loops/:loopId` 的 relation 卡片。

按鈕：

```text
relation.state === "pr_pending_approval"
  -> Approve & Publish Draft PR

relation.state === "awaiting_review"
  -> Mark Ready for Review
```

顯示：

- repository / branch
- PR title
- PR body preview
- Approve & Publish Draft PR
- Mark Ready for Review

## Test Plan

- 單元：PR payload parser。
- 單元：run complete 寫入 `pending_publish` 並轉 `pr_pending_approval`。
- API：`approve-pr` 非 pending 時 409。
- API：`approve-pr` 成功 publish 後 relation 轉 `awaiting_review`。
- API：`mark-ready` 非 awaiting_review 時 409。
- API：`mark-ready` 成功後 relation 轉 `awaiting_feedback`。
- UI：pending relation 顯示 Approve & Publish 按鈕。
- UI：awaiting_review 顯示 Mark Ready for Review 按鈕。
- UI：批准後按鈕更新，relation state 更新。
- 真實測試：用 `sakiko-toyokawa/aiHub` 跑一次完整流程。

## Assumptions

- 首次 PR 建立必須人工批准。
- 批准後建立 draft PR，進入 `awaiting_review`。
- `mark-ready` 由人工再次確認，不自動執行。
- 後續 feedback 修復維持自動 push，不需要再次批准。
- `approve-pr` 不允許直接 merge。
