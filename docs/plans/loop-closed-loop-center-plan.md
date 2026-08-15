# Loop 閉環中心化與事件契約改造計劃

> 2026-08-14 架構審計後立項。前置閱讀：`trigger-layer-correctness-plan.md`（已落地）、
> `verifier-judgment-quality-plan.md`（已落地）。本計劃是它們的上游：觸發層和判決層
> 修的是點，本計劃修的是「點與點之間沒有中心」。

## 診斷（審計結論，均有 file:line 證據）

核心域 run **已經有中心**：`loop/run/turn-loop.ts` 編排 + ControlPlane 唯一寫者
（`loop/control-plane/control-plane.ts:42`）+ 事件溯源存儲 + 純函數決策（`decide.ts`）。
**缺的是「外部世界 ↔ run」這一圈邊界層**，三個症狀：

1. **事件契約缺失**：`watcher/EventBus.ts:341-365` 的 `BusEvent` 聯合類型沒有
   run/turn/verification 生命週期事件。`session_ref` 只能靠前端 10s 輪詢發現
   （`LoopDetailPage.tsx:141-146`）；verifier agent 全程黑洞（`run-verifier-agent.ts:184`
   的 sessionId 不暴露）；github/webhooks/maintenance/trigger 全目錄 grep
   `eventBus|.emit(` 零命中。
2. **relation 狀態機 4 寫者 0 所有者**：`relation-poller.ts`（6 處遷移）、
   `routes/github.ts`（723 行路由文件裝半個狀態機）、`turn-loop.ts:1584`（run 完成
   手工回寫）、`trigger-dispatcher.ts:65`（繞過 facade 直寫底層 store）。
   `repair_count` 超限邏輯在 poller（:220-232）與 webhook（`github.ts:650-665`）各一份。
3. **觸發多頭、事件無契約**：起 run 入口 5 個（cron `app.ts:313`、HTTP
   `routes/loops.ts:566`、dispatcher、poller、webhook）；`wake_policy.trigger_types`
   硬編碼 `["github_comment","github_review"]`，與實際事件詞表
   （`issue_comment`/`ci_failure`/`head_moved`）不匹配且無人消費
   （`relation-store.ts:155-158`）。

前端是後端事實的鏡像：`/loops` 與 `/github` 被 `isGithubLoop()`（`LoopsPage.tsx:31-33`）
硬拆成互不可見的兩個入口；run 無獨立路由；relation 卡片 `loop_id` 不是鏈接
（`GitHubRelationCard.tsx:100`）；無共享 loop store，三頁面各自裸 `useState`，
`LoopsPage` mount 拉一次不刷新。

## 總原則

**收編而非重寫**：把 ControlPlane 已驗證的模式（唯一寫者 + 事件溯源 + 純函數遷移 +
對外 emit）複製到邊界層。不引入新框架、不做大而全調度器。

---

## P0-1 事件契約補齊（一切其他項的依賴，先做）

**改動**：
- `watcher/EventBus.ts`：`BusEvent` 聯合增加
  `run-started` / `turn-started`（帶 `session_ref`、`turn_no`）/ `turn-completed` /
  `verification-started` / `verification-completed`（帶各層 verdict 摘要）/
  `relation-state-changed` / `feedback-received`。
- emit 點：
  - `loop/run/run-service.ts` `startRun` → `run-started`；
  - `loop/run/turn-execution.ts` `executeTurn` 起飛（:644-647 已有 sessionRef 賦值點）
    → `turn-started`，turn 收尾 → `turn-completed`；
  - `loop/verification/run-verifier-agent.ts` verifier session 起停 →
    `verification-started/completed`，**sessionId 進事件負載**（讓前端可訂閱 judge 過程）；
  - relation 類事件由 P0-2 的服務統一 emit。

**驗收**：前端僅訂閱 activity channel 即可全程跟隨一個 run（含 turn 邊界換 session、
verifier 階段），不再依賴 10s 輪詢發現 `session_ref`；`LoopDetailPage` 輪詢降級為
純事件驅動刷新。

## P0-2 RelationLifecycleService（收編 4 寫者）

**改動**：
- 新建 `loop/relation/lifecycle-service.ts`：relation 狀態的唯一寫者，內部走
  「命令 → 純函數遷移 → 落賬 → emit `relation-state-changed`」，類比 ControlPlane。
- 收編寫點：`relation-poller.ts` 全部 `updateState`、`routes/github.ts` webhook/approve-pr/
  mark-ready 的遷移、`turn-loop.ts:1584` 回寫、`trigger-dispatcher.ts:65` 直寫，
  全部改為向服務發命令；routes 層只做協議解析，不做狀態遷移。
- `repair_count` 超限邏輯收進服務，刪除 poller/webhook 雙份。
- 事件詞表單源：以實際事件（`issue_comment`/`ci_failure`/`head_moved`/...）為準，
  修 `relation-store.ts:155-158` 的名義詞表。

**驗收**：`grep -rn "updateState" packages/server/src` 的直寫點只剩服務內部；
repair 限額邏輯單份；relation 每次遷移都有對應 bus 事件。

## P0-3 觸發入口歸一

**改動**：cron / HTTP / poller / webhook 一律只 `enqueue` 到 trigger queue；
`drainPendingTriggers`（`trigger-dispatcher.ts`）是唯一起 run 出口（HTTP 管理口
保留但走隊列）；隊列 payload 用 zod schema 化，廢掉手塞字符串。

**驗收**：`LoopRunService.startRun` 的直接調用點只剩 dispatcher；新 trigger 類型
只需擴 schema，不需改調用方。

---

## P1-1 前端 run 中心路由

- 新增 `/runs/:runId` 獨立路由（現 run 詳情是 `LoopDetailPage.tsx:629-961` 的內嵌
  `<section>`，不可直達）；relation 給詳情頁；`GitHubRelationCard.tsx:100` 的
  `loop_id` 改 `<Link>`；`/loops` 與 `/github` 合併為帶 filter 的單一列表，
  刪除 `isGithubLoop()` 硬拆。
- 順手修：`/human-queue` 在 `AppRoutes.tsx` 缺失（僅 `remote-main.tsx:108` 有）。

## P1-2 前端共享 loop 數據層

- 新建 `useLoops` / `useRun` hook（SWR 式：REST 拉取 + activity 事件驅動失效重拉），
  替代三頁面的裸 `useState`；`LoopsPage` 廢除 mount-only 拉取。
- `LoopApprovalCards` 改讀 `loopsApi.listPendingHuman()` 做初始態，WS 事件只做增量
  （現刷新即丟失）。

## P1-3 turn 內部結構化渲染

- `RunStreamOutput.buildDisplayEntries`（`:62-147`）增加 `tool_use` / `tool_result`
  分支：顯示工具名、參數摘要、結果摺疊塊（參考 SessionPage 的消息渲染器，不用 `<pre>`）；
  放寬末尾 1000 行 / 50 條限制。
- turn 邊界自動跟隨：靠 P0-1 的 `turn-started` 事件拿到新 `session_ref` 自動換訂閱。

---

## P2 Loop 控制中心（統一控制界面，純前端）

> 背景：P0/P1 落地後（commit `87527a7`）後端閉環與前端數據層已打通
> （`useLoops`/`useRun` 事件驅動失效、activityBus 已接 7 種生命週期事件），
> 但信息架構仍是「實體列表的集合」：relations 卡片、run 列表、人審隊列、
> maintenance 散在四個入口（`Sidebar.tsx:412/420/428/436`），
> 「需要人處理的事」分置三處（LoopApprovalCards 內存彈窗、`/human-queue`、
> relation 卡片）。P2 的目標是一句話：**第一眼看到東西卡在哪一站、
> 哪一站需要我**——從「實體列表」升級為「管道視圖」。

### P2-1 統一收件箱 ActionInbox

- 新組件 `components/loop-center/ActionInbox.tsx`，聚合三類待處理，按緊急度排序：
  1. SLA 超時項（現 HumanSlaQueuePage 數據源）；
  2. needs_human runs（`loopsApi.listPendingHuman()`）→ approve / discard / advance；
  3. `pr_pending_approval` relations（relations API 過濾）→ approve-pr / discard。
- 每條帶一鍵操作 + 跳轉（→ `/runs/:runId` 或 relation 卡）。
- 順手收編 `LoopApprovalCards`：初始態改讀 `listPendingHuman()`，WS 事件只做增量——
  消掉「頁面刷新即丟失」的內存態缺陷。
- **驗收**：三類待辦同屏可見；操作完成後卡片即時消失（事件驅動，不靠手動刷新）。

### P2-2 管道視圖 PipelineBoard

- 新頁面主體 `pages/LoopCenterPage.tsx`：按 relation 狀態分列
  `pr_pending_approval → awaiting_review → awaiting_feedback → fixing → done`；
  無 relation 的普通 loop 歸入末尾「Standalone」列。
- 卡片內容：PR#、repo、`repair_count`、關聯 run 狀態徽標、最後事件時間；
  點擊跳 `/runs/:runId`。
- 數據：relations API + `useLoops` entries 按 `loop_id` 關聯；
  訂閱 `relation-state-changed` / `feedback-received` 讓卡片實時挪列。
- **驗收**：從中心頁能看全每個 GitHub 閉環卡在哪一站；webhook 觸發後卡片
  自動從 awaiting_feedback 挪到 fixing（webhook 通道秒級；poller 補盲通道
  放寬到其 5 分鐘粒度）。

### P2-3 活躍 run 實時條 ActiveRunsBar

- 內存態列表，靠 `run-started` / `turn-started`（帶 `turn_no`）/ `turn-completed` /
  `verification-started|completed` 事件維護：顯示 run id、當前 turn、
  當前階段（executing / verifying）、已運行時長；點擊進 `/runs/:runId`。
- 這一項同時治「verifier 黑洞」的前端半邊：judge 運行期間階段顯示 verifying。

### P2-4 導航收斂（最後做，依賴 P2-1/2/3 就緒）

- Sidebar 收為單入口「Loop」→ `/loop-center`；頁內 tabs：
  管道（默認）/ 所有 Loops（現 LoopsPage）/ 人工隊列（現 HumanSlaQueuePage）/
  Maintenance（現 MaintenanceTargetsPage）。
- 舊路由保留為重定向：`/loops` → `/loop-center?tab=loops`，
  `/human-queue` → `?tab=human`，`/maintenance` → `?tab=maintenance`，
  `/github` → `?tab=pipeline`（github filter 已是查詢參數，語義不變）。
- `/runs/:runId`、`/loops/:loopId` 詳情路由不動。
- 同步 `remote-main.tsx`（`AppRoutes.tsx:27` 的既有約定）。
- 手機端是主場景：管道列在窄屏降為單列堆疊，收件箱永遠在最頂。

### P2 依賴與邊界

- 純前端，無後端改動；唯一可選後端小改：relations 列表 API 若不支持
  按狀態/server-side 過濾，加 query param（現量級前端過濾也夠，不阻塞）。
- P2-1/2/3 同屬一個新頁面，建議同一執行者一次做完；P2-4 最後。
- **總驗收**（真實流量，可複用 aiHub/測試 repo）：開著 `/loop-center` 不刷新，
  打一條 PR 評論 webhook → 卡片挪列 + ActiveRunsBar 出現新 run +
  階段實時切換（executing→verifying）→ 完成後收件箱與管道同時更新。

## 執行順序與風險

1. P0-1 先行（前後端都依賴事件契約）——已完成（commit `87527a7`）；
2. P0-2、P0-3 可並行——已完成（同上）；
3. P1 三項任意序，P1-3 依賴 P0-1——P1-1/P1-2 已完成（同上），
   P1-3（turn 結構化渲染）只出了基礎版，剩 tool_use/tool_result 分支
   與 turn 邊界自動跟隨，可併入 P2 一起做；
4. P2-1/2/3 → P2-4 —— 已完成。

風險點：P0-2 收編涉及 4 處寫點切換——寫點少且已知，建議直接切不搞雙寫過渡；
切完跑一次 aiHub E2E（issue→PR→comment→repair 全鏈路）驗證 relation 狀態一致。
（已驗證：`benchmarks/loop-runtime-eval/results/pr-maintenance-2026-08-15T01-52-10-725Z.json` = pass。）
P2 的風險在範圍蠕變：控制中心是展示層聚合，**不要**趁機在頁面裡長新的
狀態邏輯——所有狀態仍以後端單寫者為準，前端只做事件驅動的讀模型。

---

## 驗收結果（2026-08-15）

- P0-1 / P0-2 / P0-3 與 P1-1 / P1-2 / P1-3 均已實作。
- P2-1 / P2-2 / P2-3 / P2-4 均已實作：
  - `ActionInbox` 聚合 SLA、needs_human、PR approval；
  - `PipelineBoard` 按 relation 狀態分列並自動挪列；
  - `ActiveRunsBar` 由 run/turn/verification 事件實時維護；
  - Sidebar 收為單一 Loop 入口，舊路由重定向到 `/loop-center`。
- `pnpm lint`、`pnpm typecheck`、server tests、client tests、
  `pnpm test:loop-modules`（31 cases）全綠。
- 真實 aiHub E2E 通過：
  `sakiko-toyokawa/aiHub#12 → PR #13 → webhook issue_comment → repair run complete`。
- relation 狀態流轉完整：
  `pr_pending_approval → awaiting_review → awaiting_feedback → fixing → awaiting_feedback → closed`；
  maintenance target 最後同步為 `done`。
- E2E 結果存於
  `benchmarks/loop-runtime-eval/results/pr-maintenance-2026-08-15T01-52-10-725Z.json`。
