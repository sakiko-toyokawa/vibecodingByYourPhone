# 觸發層正確性修復任務書（GitHub PR 反饋通道盲區根治）

> **交接說明**：本文件是可直接執行的修復任務書。讀者是執行改造的 coding agent（DeepSeek）。
> 所有行號以 2026-08-14 的工作區為準（觸發層主體在提交 `a98b384`，2026-08-13；
> 注意工作區尚有大量未提交改動，動工前先 `git status` 確認基線，不要覆蓋他人未提交工作）。
> 若行號漂移，按符號名搜索定位。開始前請先閱讀倉庫根目錄 `AGENTS.md` 與 `CLAUDE.md`。
>
> **執行紀律**：
> - 最小改動，不順手重構無關代碼；註釋風格跟隨所在文件（該子系統大量使用中文註釋）。
> - 每完成一個項目跑該項列出的驗證命令，全綠再進下一項。
> - 不準留下 `// ... rest unchanged` 之類的半成品；每個修改寫完整。
> - schema 變更必須向後兼容（zod `.default()` / `.optional()` / `.nullable()`），
>   既有 `targets.json` 必須可解析。
> - 測試模式：`packages/server` 的測試是「`tsc` 編譯後跑 `node dist/**/x.test.js`」，
>   新測試文件要加進 `packages/server/package.json` 的 `test` 腳本鏈。

---

## 0. 問題一句話診斷

觸發層兩條通道（輪詢 `RelationPoller` + webhook 接收端）都已建成，但**事件覆蓋面與
語義路由是錯的**：該叫醒的醒不來（PR 對話區評論、CI 變紅、head 分支被推新 commit、
cross-reference mention），不該當反饋的被誤扣修復額度（PR closed、review dismissed、
synchronize、label 變化）。`wake_policy.trigger_types` 是名義上的，無人按它過濾事件。

**生產實例（本次任務的導火索）**：2026-08-13T12:43Z，`surajksharma07` 在 issue
google/adk-python#6708 中提及 PR #6713（cross-reference timeline 事件），維護 loop
`github-adk-pr-maintenance` 完全無感知。生產數據自洽證明通道斷裂：relation
`rel-google-adk-6713-maintenance-20260813194706` 狀態正常（`awaiting_feedback`、
`repair_count: 0`、cursor 為空），但 `updated_at` 停在創建時刻 2026-08-13T11:47:06，
`trigger/queue.jsonl` 從未出現過它的 poll 條目。

---

## 1. 現狀架構與完整證據鏈

### 1.1 兩條通道

**輪詢通道（主力）** `packages/server/src/loop/relation/relation-poller.ts`：
- `app.ts:391-402` 無條件接線，5 分鐘間隔 + 啟動即 poll 一次。
- 每輪對 `awaiting_feedback` 的 relation 拉三個端點：
  - `getPullRequest`（`packages/server/src/github/client.ts:348-364`，jq 取
    `{state, merged, head_sha}`）→ 只用 `state`/`merged` 推終態（poller:54-63），
    **`head_sha` 拉了就丟**（poller:54-57）。
  - `listPullRequestComments`（`client.ts:296-301`）→ 打的是 `pulls/{n}/comments`，
    即**行內代碼評論**，不是對話區評論。
  - `listPullRequestReviews`（`client.ts:324`）→ 不區分 state，APPROVED 也算反饋。
- watermark：`last_processed.comment_id` / `review_id` 取最大數字 id 比對（poller:73-87），
  **只能靠 id 增長感知，編輯/刪除不可見**。
- 新反饋 → `repair_count+1`，>3 轉 `needs_human`（poller:89-100），否則轉 `fixing` +
  enqueue（poller:101-127）。
- **跳過邏輯**：`needs_human` / `pr_pending_approval` / `awaiting_review` / 終態的
  relation 整輪跳過（poller:42-52）——連 PR merged/closed 都不再檢查。
- 小 bug：poller:122 把行內評論事件的 `event_type` 錯標成 `"issue_comment"`。

**webhook 通道** `packages/server/src/routes/github.ts:436-563`：
- 路由已掛載（`packages/server/src/routes/index.ts:429-440`）。
- 簽名僅當設了 `GITHUB_WEBHOOK_SECRET` 才校驗 HMAC-SHA256（443-457）。
- **無 event type 白名單**（440 對 `x-github-event` 不做任何檢查）、**不看
  `payload.action`**：任何事件一律 → `repair_count+1` → 轉 `fixing` → enqueue
  （524-560）。`pull_request.closed`、`pull_request_review.dismissed`、`synchronize`、
  label/assignee 變化全部走這條錯路，來 3 次就誤判 `needs_human`。
- relation 匹配：`payload.repository.full_name` + `pull_request.number`（fallback
  `issue.number`）→ `relationStore.findByGitHubPr`（464-493）。
- 去重：`event_id = x-github-delivery`（trigger-queue-store.ts:59-62）。
- **watermark 串號**：issue_comment 事件的 comment id 被寫進
  `last_processed.comment_id`（475-484），但 GitHub 上 issue comment 與 review
  comment 是**兩套獨立 id 序列**——會污染 poller 的行內評論游標，可能讓 poller
  永久漏掉 id 更小的真行內評論。
- `check_run` / `check_suite` / `status` 事件 payload 無頂層 `pull_request`/`issue`
  字段，會在 485-490 被 202 拒掉。

### 1.2 狀態機與終態責任

`packages/server/src/loop/relation/relation-store.ts:9-17`：
`pr_pending_approval → awaiting_review → awaiting_feedback → fixing →
(awaiting_feedback | needs_human | merged | closed)`。

- `fixing → awaiting_feedback`：run 完成時由 `turn-loop.ts:1584-1597` 寫回。
- `→ merged / closed`：**只有 poller** 會主動發現（poller:54-63）；webhook 無終態處理；
  被跳過狀態（needs_human 等）的 relation 永遠進不了終態——「成功率以主體終態計」
  對它們不可行。
- `awaiting_review → awaiting_feedback`：只有手動調 `/relations/:id/mark-ready`
  （github.ts:388-434）；maintainer 在 GitHub 網頁點 ready，relation 永久卡死。
- schema 裡 `last_processed.commit_sha` 是**死字段**（relation-store.ts:39），
  全倉庫無人寫入或比較。
- `wake_policy.trigger_types`（`packages/shared/src/loop-schema/maintenance/types.ts:14-17`）
  只是 `string[]`，relation 適配器硬編碼 `["github_comment","github_review"]`
  （relation-store.ts:136），唯一消費者是拼進 prompt（runtime-input.ts:330）。
  dispatcher 與 poller/webhook 都不按它過濾。

### 1.3 完全無人消費的數據源

CI / check runs / commit status、`mergeable_state`、`issues/{n}/comments`（對話區評論）、
`issues/{n}/timeline`（cross-reference）、關聯 issue 狀態。

---

## 2. P0 修復項（4 項，按依賴排序）

### P0-1　webhook event 白名單 + action 路由

**問題**：`github.ts:436-563` 對所有事件一律當新反饋，`closed`/`dismissed`/
`synchronize` 等誤扣 repair 額度並誤轉 `fixing`。

**修改點**：
- `packages/server/src/routes/github.ts` webhook handler：
  - 白名單：`issue_comment`、`pull_request_review`、`pull_request_review_comment`、
    `pull_request`。其餘 event 回 202 `{"ignored": "event"}`。
  - `pull_request` event 按 `payload.action` 路由：
    - `closed` → 按 `payload.pull_request.merged` 置 relation 終態 `merged`/`closed`，
      **不計 repair、不 enqueue**；
    - `synchronize` / `edited` / `reopened` / label/assignee 類 → 記 state log 或忽略，
      不計 repair（`reopened` 見 P1-3 範圍外，本項只需不誤判）；
    - `ready_for_review` → 若 relation 在 `awaiting_review`，推進到 `awaiting_feedback`。
  - `pull_request_review` event：`payload.action === "dismissed"` → 不計 repair；
    `payload.review.state === "approved"` → 不計 repair、不轉 fixing（語義：approve 是
    接近終態信號，不是修復請求）。
- 行為變更注意：既有測試 `packages/server/src/routes/github.test.ts` 可能依賴
  「任何事件都 enqueue」的舊行為，按新語義更新斷言。

**測試**：`packages/server/src/routes/github.test.ts` 增加用例：
`pull_request.closed(merged=true)` → relation 進 `merged` 且 repair_count 不變；
`dismissed` → 不 enqueue；`approved` → 不 enqueue；`synchronize` → 不 enqueue；
非白名單 event → 202 ignored。

**驗證**：`pnpm --filter @yep-anywhere/server test`（至少 routes/github.test.js 全綠）。

### P0-2　poller 補拉對話區評論 + watermark 拆分

**問題**：①poller 只拉行內評論，PR 對話區評論（`issues/{n}/comments`，主要反饋渠道）
不可見；②webhook 把 issue comment id 寫進 review comment 的游標，兩套 id 序列串號。

**修改點**：
- `packages/server/src/github/client.ts`：新增 `listIssueComments(repo, number)`，打
  `repos/{repo}/issues/{n}/comments`，jq 取 `{id, body, user, created_at, updated_at}`，
  風格跟隨 `listPullRequestComments`（client.ts:296-301）。
- schema `last_processed`（relation-store.ts:39 附近）：新增可選字段
  `issue_comment_id`（向後兼容，`.optional()`），與既有 `comment_id`（行內評論專用）
  並列。
- `relation-poller.ts:65-87`：每輪同時拉對話區評論，用 `issue_comment_id` 游標比對，
  合入行內評論的反饋判定（同一輪多類新反饋只 enqueue 一次，repair_count 只 +1）。
- `github.ts:475-484`：webhook 的 issue_comment 分支改寫 `issue_comment_id`，
  不再碰 `comment_id`。
- 順手修 poller:122 的 `event_type` 誤標：行內評論標 `"pull_request_review_comment"`，
  對話區評論標 `"issue_comment"`。

**測試**：`relation-poller.test.ts` 增加：對話區有新評論 → enqueue 且
`issue_comment_id` 游標推進；同輪行內+對話區都有新評論 → 只 enqueue 一次、
repair_count 只 +1。`github.test.ts`：webhook issue_comment 只寫 `issue_comment_id`。

**驗證**：server 測試全綠。**生產驗收**：在 google/adk-python#6713 對話區留一條
測試評論，等一個 poll 週期（5 分鐘），確認 `trigger/queue.jsonl` 出現
`github-poll-rel-google-adk-6713-*` 條目且 relation 轉 `fixing`。

### P0-3　CI 狀態感知（修復成敗的最關鍵反饋源）

**問題**：loop 推了修復後 CI 紅了永遠不會醒；CI 全綠也無人記錄「修復成功」信號。

**修改點**：
- `client.ts`：新增 `getCombinedStatus(repo, sha)`（`repos/{repo}/commits/{sha}/status`）
  或 `getCheckRuns(repo, sha)`（`check-runs`，jq 取 `conclusion` 列表）——二選一，
  優先 check runs（覆蓋 GitHub Actions），注意 `Accept: application/vnd.github+json`
  與既有調用保持一致。
- `relation-poller.ts`：對 `awaiting_feedback` 的 relation，拉 PR 時已拿到
  `head_sha`（poller:54-57），順手查其 check 結果：
  - 任一 check `failure` / `timed_out` / `action_required` → 視為新反饋
    （event_type `"ci_failure"`），走同一條 repair_count+1 → fixing → enqueue 路徑；
  - 需要在 relation 上記「上次已就哪個 sha 的哪次失敗叫醒過」，避免同一失敗
    每 5 分鐘重複叫醒——可在 `last_processed` 加 `ci_failure_sha`（可選字段），
    僅當 sha 變化或 check 從非失敗轉失敗時觸發。
  - checks 全綠只記 state log，不動狀態機（留給後續「成功率口徑」使用）。

**測試**：`relation-poller.test.ts`：mock check runs 返回 failure → enqueue 一次；
同一 sha 連續兩輪 failure → 只 enqueue 一次；全 success → 不 enqueue。

**驗證**：server 測試全綠；生產上觀察一輪 poll 的 state log 出現 check 結果記錄。

### P0-4　head_sha 變化喚醒（啟用死字段 `commit_sha`）

**問題**：maintainer 或別的 bot 向 PR 分支推了新 commit，loop 無感知——自己的
修復可能已被覆蓋/衝突，卻還在舊 head 上規劃下一輪。

**修改點**：
- `relation-poller.ts:54-57`：把 `getPullRequest` 返回的 `head_sha` 與
  `last_processed.commit_sha`（relation-store.ts:39，目前是死字段）比對：
  - 首次（cursor 為空）→ 只寫入，不喚醒；
  - 有舊值且不同 → 視為反饋事件（event_type `"head_moved"`）喚醒一輪，讓 executor
    重新基於新 head 評估；寫入新 sha。
- 與 P0-3 的去重配合：head 移動觸發的喚醒覆蓋同 sha 的 CI 觸發（同輪只 enqueue
  一次）。

**測試**：`relation-poller.test.ts`：sha 變化 → enqueue + cursor 更新；首次輪詢
只寫 cursor 不 enqueue。

**驗證**：server 測試全綠。

---

## 3. P1 修復項（3 項）

### P1-1　非終態 relation 也要追蹤 PR merged/closed

**問題**：poller:42-52 對 `needs_human` / `pr_pending_approval` / `awaiting_review`
整輪跳過，這些 PR 被合併/關閉後 relation 永遠進不了終態——hardening 計劃問題 #2
要求的「成功率以主體終態計」對它們不可行。

**修改點**：`relation-poller.ts:42-52` 把「整輪跳過」改為「跳過反饋拉取與喚醒，
但仍執行 `getPullRequest` 的 merged/closed 檢查並推進終態」。這是本任務書中
最小的一項改動（調整跳過的位置，不新增數據源）。

**測試**：`relation-poller.test.ts`：`needs_human` 狀態 relation 的 PR 已 merged →
relation 轉 `merged`、不 enqueue。

**驗證**：server 測試全綠。

### P1-2　`awaiting_review` 自動感知 GitHub 側 ready

**問題**：relation 卡在 `awaiting_review` 等人工 `/mark-ready`（github.ts:388-434），
但 maintainer 或 PR 作者在 GitHub 網頁點 "Ready for review" 時，relation 永久僵死
（poller 跳過該狀態）。

**修改點**：
- `client.ts:348-364` 的 `getPullRequest` jq 增加 `draft` 字段。
- poller 對 `awaiting_review` 的 relation（配合 P1-1 已不再整輪跳過）：
  `draft === false` → 自動推進 `awaiting_feedback`（等同 mark-ready 的狀態轉移，
  不 enqueue——喚醒由後續反饋事件驅動）。

**測試**：`relation-poller.test.ts`：`awaiting_review` + `draft:false` → 轉
`awaiting_feedback`；`draft:true` → 不動。

**驗證**：server 測試全綠。

### P1-3　PR reopen 復活

**問題**：`closed` 是終態，PR 被 reopen 後 relation 不會復活（poller:46-47 跳過終態）。

**修改點**：poller 對 `closed` 狀態的 relation 仍查 PR state（代價同 P1-1 的一次
`getPullRequest`），`state === "open"` → 回到 `awaiting_feedback` 並記 state log。
`merged` 不復活（不可能 reopen 成未合併）。webhook 側 `pull_request.reopened`
走同一路徑（P0-1 的白名單已放行 `pull_request` event）。

**測試**：`relation-poller.test.ts`：closed + PR open → 回 `awaiting_feedback`；
merged + 任何狀態 → 不動。

**驗證**：server 測試全綠。

---

## 4. 明確不做的（P2，另立任務，本任務書範圍外）

- **cross-reference / timeline 輪詢**（本次生產事故的確切事件類型）：需接入
  `issues/{n}/timeline` 過濾 `cross-referenced` 事件，事件 id 做 watermark；
  該端點需要認證。涉及新數據源與配額設計，另立任務書。
- **評論編輯/刪除感知**：watermark 從 max-id 改 `updated_at` 時間窗或 id+edited
  標記，影響面涉及所有游標消費者，單獨設計。
- **`mergeable_state` 衝突告警**：`getPullRequest` 加字段 + 新通知通道，單獨做。
- **`wake_policy.trigger_types` 實際生效**：讓 dispatcher/poller 按 trigger_types
  過濾事件——需要先定義事件類型詞表，屬設計變更，單獨立項。
- **關聯 issue 狀態跟蹤**：影響低。

---

## 5. 執行順序與總驗收

順序：P0-1 → P0-2 → P0-3 → P0-4 → P1-1 → P1-2 → P1-3。
（P0-2 的 schema 字段先落地，P0-3/P0-4 往同一個 `last_processed` 加字段時不會
互相踩踏；P1-1 改完跳過邏輯後 P1-2/P1-3 才有落點。）

每項完成後跑 `pnpm --filter @yep-anywhere/server test`；全部完成後再跑
`pnpm typecheck` 與 `pnpm lint`。

**總驗收（生產閉環，對應 hardening 計劃問題 #4 的「跑通才算完成」）**：
配好 `GITHUB_TOKEN/GITHUB_TEST_REPO/GITHUB_TEST_ISSUE` 跑
`pnpm test:loop:github:pr-maintenance`
（腳手架 `benchmarks/loop-runtime-eval/run-github-pr-maintenance-flow.ts`），
並額外手工驗證兩條：
1. 測試 PR 對話區留評論 → 一個 poll 週期內 relation 轉 `fixing`、queue 出現
   poll 條目；
2. 向測試 PR 分支推一個空 commit → relation 因 `head_moved` 被喚醒。
結果存檔到 `benchmarks/loop-runtime-eval/results/`，本任務書才算關閉。
