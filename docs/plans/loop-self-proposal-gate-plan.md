# Loop 自我提案閘門計劃（自主 loop 工廠）

> 2026-08-15 立項。前置：觸發層正確性、verifier 判決質量、閉環中心化
> （`loop-closed-loop-center-plan.md`，P0/P1 已落地，P2 進行中）、
> ISSUE-PROPOSAL 閘門（`0b1cf57`）。本計劃是「閘門模式」的第三次複製：
> PR-PUBLISH → ISSUE-PROPOSAL → LOOP-PROPOSAL。
>
> **狀態（2026-08-16）：P1-1~P1-7 已全部落地**（解析器/鉗制層
> `loop/proposal/loop-proposal.ts`、store+單寫者 `loop/proposal/`、
> 路由 `routes/loop-proposals.ts`、前端 ActionInbox `loop_proposal` kind、
> LoopDetailPage 子 loop 列表、runtime-input 僅授權注入教學）。
> 驗收 review 追加三條加固：提案卡 id 強制 kebab-case（防路徑穿越）、
> managed:// 路徑一律由鉗制層重寫（不信 agent 自帶後綴）、
> workspace.ts 解析時拒絕越出 dataDir（縱深防禦）、registerLoopProposal
> 冪等（終態提案不复活，同 ff979e4 的 relation 教訓）。P2 未做。

## 目標

讓 agent 能提議創建新 loop（例：每日 cron 的 issue 巡檢 loop 發現值得專項跟進的
問題時，提議一個專項 loop），但**創建動作必須過人工批准**。從「人工建 loop」
走向「agent 提議、人類批准、系統執行」的自主 loop。

第一教條不變：模型提議、代碼執行、特權動作過閘。**不給 agent 真正的
create-loop 工具**，只給提案通道。

## 現狀盤點（已存在的零件）

- cron 觸發：`loop/trigger/cron-scheduler.ts`（每日 github_prompt loop 今天就能手建）
- 閘門範式：`loop/relation/pr-publish.ts`（標記塊解析）、
  `lifecycle-service.ts`（掛起+事件）、`routes/github.ts` approve-pr/approve-issue
  （人工批准→執行）、前端收件箱 `components/loop-center/ActionInbox.tsx`
- 策略閘門詞表：`runtime-input.ts` policyPromptLines 已把 publish 等列為硬閘門
- 配額/預算體系：control-plane budget + stop_rules

## P1 LOOP-PROPOSAL 閘門（本計劃主體）

### P1-1 解析：`extractLoopProposalPayload()`

- 新標記塊 `<<<LOOP-PROPOSAL>>> { loop card JSON + reason } <<<END-LOOP-PROPOSAL>>>`，
  放 `loop/relation/pr-publish.ts` 旁（或新文件 `loop/proposal/loop-proposal.ts`），
  照搬現有塊解析的容錯邏輯。
- card 必須過 `LoopCardSchema`（shared/loop-schema/loop-card.ts）校驗，不過即丟棄。

### P1-2 鉗制層：`clampProposedCard()`（純函數，確定性，不過即拒絕入閘）

- workspace.strategy 強制 `managed://` 前綴；trigger.type 白名單（cron/manual）；
- `approval_mode` 不許低於父 loop；`publish_mode` 白名單；
- stop_rules 封頂（max_turns ≤ 全局上限，max_time_minutes ≤ 上限）；
- 血緣：`parent_loop_id` 寫入提案；**depth>1 直接拒絕**（agent 建的 loop 不能再
  提議 loop，除非人類在卡上顯式開 `can_propose_loops`）。

### P1-3 存儲與生命週期：`LoopProposalStore` + 單寫者服務

- 照搬 MaintenanceTargetStore 的 JSON 文件存儲（`loops/proposals/proposals.json`）；
  狀態機 pending_approval → approved / rejected，repair 不需要；
- `LoopProposalLifecycleService`（類比 RelationLifecycleService）：唯一寫者，
  emit `loop-proposal-changed` 事件進 EventBus（控制中心要能實時看到）。

### P1-4 配額硬頂（提案入口處）

- 每日提案數上限（如 5）、全局活躍 loop 數上限；超限提案直接 rejected，
  記 learning event，不進人工隊列。

### P1-5 路由與執行

- `GET /api/loop-proposals`、`POST /api/loop-proposals/:id/approve|reject`
  （照搬 approve-issue 的 400/404/409 語義）；
- approve → 用鉗制後的 card 調 loopCardStore 創建 loop，提案轉 approved
  （記 created loop_id）；reject 帶 reason，進 learning 賬本。

### P1-6 前端

- ActionInbox 加 `loop_proposal` kind：卡片顯示觸發器/任務摘要/預算/發布模式/
  提案理由/parent loop 鏈接，一鍵批准/拒絕；
- LoopDetailPage 顯示子 loop 列表（血緣可視化的最小版）。

### P1-7 prompt 教學

- runtime-input.ts：僅對帶 `can_propose_loops` 的 loop 注入提案塊格式說明
  （默認不教——提不了案是默認態，能提案是顯式授權）。

**驗收**（E2E）：父 loop 產出 LOOP-PROPOSAL → 收件箱出現提案 → 批准 → 新 loop
存在且血緣正確 → 子 loop 嘗試再提議被拒（depth 限制）→ 拒絕路徑進 learning 賬本。
測試：解析器、鉗制純函數（每條規則一個用例）、路由 400/404/409、配額超限。

## P2（後續）

- 級聯殺：archive 父 loop 可選停掉子 loop；
- 控制中心「loop 家族樹」視圖；
- 元 loop 模板：每日自檢 loop 讀 learning 失敗聚類 → 提議補丁 loop
  （把 learning worker 的提案能力和 loop 創建閉合）。

## 風險

- 最大風險是遞歸放大（loop 生 loop 的成本失控）——所以配額和深度限制是
  P1 的必需品，不是 P2 的錦上添花。
- 鉗制層必須純函數 + 單測覆蓋；這裡不能用模型判斷。
