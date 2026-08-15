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

## 執行順序與風險

1. P0-1 先行（前後端都依賴事件契約）；
2. P0-2、P0-3 可並行；
3. P1 三項任意序，P1-3 依賴 P0-1。

風險點：P0-2 收編涉及 4 處寫點切換——寫點少且已知，建議直接切不搞雙寫過渡；
切完跑一次 aiHub E2E（issue→PR→comment→repair 全鏈路）驗證 relation 狀態一致。

---

## 驗收結果（2026-08-15）

- P0-1 / P0-2 / P0-3 與 P1-1 / P1-2 / P1-3 均已實作。
- `pnpm lint`、`pnpm typecheck`、server tests、client tests、
  `pnpm test:loop-modules`（31 cases）全綠。
- 真實 aiHub E2E 通過：
  `sakiko-toyokawa/aiHub#12 → PR #13 → webhook issue_comment → repair run complete`。
- relation 狀態流轉完整：
  `pr_pending_approval → awaiting_review → awaiting_feedback → fixing → awaiting_feedback → closed`；
  maintenance target 最後同步為 `done`。
- E2E 結果存於
  `benchmarks/loop-runtime-eval/results/pr-maintenance-2026-08-15T01-52-10-725Z.json`。
