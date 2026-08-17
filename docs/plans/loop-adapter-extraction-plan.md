# Loop Adapter 抽離計劃（github_pr / github_issue 兩種形態註冊化）

> 實作狀態（2026-08-17）：Gate、Target、Workspace registries 已落地並在
> app 啟動時註冊/凍結；GitHub PR/Issue polling、webhook、feedback filter、
> workspace resolver 已由 `loop/adapters/github/` 承載；ActionInbox kind
> metadata 已註冊化並支持後端 capabilities 覆蓋。核心保留的 GitHub 引用為
> 存量 relation serialization、兼容 helper 與既有 policy/intent 語義。

> **交接說明**：本文件是可直接執行的架構改造任務書。讀者是執行改造的 coding agent（GPT）。
> 所有行號以 2026-08-16 的工作區為準（基線 commit `b87941e`；工作區另有他人未提交改動：
> `packages/server/src/loop/state/cold-storage.ts` 的 mkdir 修復、
> `packages/client/src/components/RunStreamOutput.shared.ts` 與 `.test.ts`、
> `packages/client/tsconfig.test.json`、`packages/client/package.json`——
> **動工前先 `git status` 確認基線，絕不覆蓋/還原這些在制工作**）。
> 行號漂移時按符號名搜索定位。開始前閱讀倉庫根目錄 `AGENTS.md` 與 `CLAUDE.md`。
>
> **執行紀律**：
> - strangler 式遷移：每一步行為零變化、測試全綠、可獨立提交、可回滾。禁止「大重構 PR」。
> - 最小改動，不順手重構無關代碼；註釋語言跟隨所在文件（server 的 loop 子系統用簡體中文）。
> - 既有存儲格式是紅線：`loops/maintenance/targets.json`、`loops/proposals/proposals.json`、
>   relation 狀態字符串（`awaiting_feedback` 等）、EventBus 事件名（`relation-state-changed` 等）
>   一律不變。前端 API 形狀不變。
> - 接口設計只取現存三個閘門 / 兩種目標的並集，**不為假想未來形態多加一個參數**。
> - 測試模式：`packages/server` 是「tsc 編譯後跑 `node dist/**/x.test.js`」，新測試文件加進
>   `packages/server/package.json` 的 test 腳本鏈（串聯 &&）。client 是
>   `tsc -p tsconfig.test.json` + `.test-dist/`，文件需同時加進 tsconfig include 與 package.json 鏈。
> - 不許 git commit（由人類分步提交）；不許留 `// ... rest unchanged` 半成品。

---

## 0. 目標與非目標

**目標**：loop 核心成為與 GitHub 無關的引擎；`github_pr` 與 `github_issue` 兩種形態
抽離為註冊進來的 adapter。驗收標準只有一條：**下一個新形態（如 GitLab、本地目錄巡檢）
= 新增一個 adapter 文件夾 + 一行註冊，不改 `loop/` 核心任何一行。**

**非目標**：不做外部插件框架（adapter 是單倉單進程的內部 TS 接口）；不改 run 執行、
verification、control plane、learning 的任何行為；不動 UI 佈局（只做 kind 元數據註冊化）。

**背景證據**（為什麼做）：loop 核心 18 個文件有 81 處 GitHub 專屬標識符；閘門模式已被
平行複製三次（PR-PUBLISH → ISSUE-PROPOSAL → LOOP-PROPOSAL，31 處標記塊引用 13 個文件），
每次新功能都在核心裡加 if。

## 1. 現狀地圖（GitHub 特異性在哪裡）

| 位置 | 特異性 |
|---|---|
| `loop/relation/relation-store.ts:10-39` | `RELATION_STATES` 與 `GithubPrSubject/GithubIssueSubject` 封閉 union；`relationStateToTargetState` 把 GitHub 語義映射進通用 MaintenanceTarget |
| `loop/relation/lifecycle-service.ts:218-345` | `registerGithubPrPublish` / `registerGithubIssueProposal`——閘門掛起邏輯；通用部分（upsert/transition/receiveFeedback/resolve）在同文件 51-212 行 |
| `loop/relation/pr-publish.ts` | PR-PUBLISH / ISSUE-PROPOSAL 標記塊解析器（純 GitHub 語義） |
| `loop/relation/relation-poller.ts:77-293` | pollOnce 的 PR 輪詢主體；`pollIssueRelation`（299-380）是 issue 形態——同一類裡的兩條平行路徑 |
| `routes/github.ts` webhook（655 行起）+ `handleWebhookRelation` | webhook 匹配/作者過濾/逐 relation 喚醒；approve-pr / approve-issue / mark-ready / resolve 人工閘門路由 |
| `loop/run/turn-loop.ts:1354-1386` | run 完成時的閘門註冊：`discovery?.source === "github_prompt"` 特判 + PR/ISSUE 兜底 + LOOP-PROPOSAL 授權判斷，全部內聯 |
| `loop/assembly/runtime-input.ts` | `relationPromptLines` / `maintenanceTargetPromptLines` / `loopProposalPromptLines` 硬編碼注入 |
| `loop/run/workspace.ts:61-91` | `isGitHubPromptLoop` 特判分支（通用 `managed://` 分支是其後補的） |
| `loop/relation/feedback-filter.ts` | GitHub 作者過濾（bot 名單/[bot] 後綴/自己賬號） |
| 前端 `ActionInbox.tsx` / `GitHubRelationCard.tsx` / `MaintenanceTargetCard.tsx` | inbox kind、卡片字段按類型硬編碼 |

**已經是正確雛形、不要拆的部分**：`MaintenanceTarget.target_type + adapter_data`
（`loop/maintenance/types.ts`）、trigger queue/dispatcher/cron、control plane、
verification、`loop/proposal/*`（LOOP-PROPOSAL 已是最乾淨的閘門實例，S1 時它是
registry 接口的主要參照）。

## 2. 目標架構

```
loop/                          ← 核心（改完後不含任何 github_* 標識符）
  gates/registry.ts            GateDefinition + GateRegistry
  targets/registry.ts          TargetAdapter + TargetAdapterRegistry
  workspace/resolvers.ts       WorkspaceResolver 註冊表（或併入 targets，見步驟 S4 取捨）
  relation/                    通用 relation 存儲/生命週期（subject 改開放形狀）
  adapters/github/             第一個 adapter：兩種形態都住這裡
    index.ts                   registerGitHubAdapter(registries) 一行接線
    pr-target.ts               github_pr：poll handler、webhook handler、狀態映射
    issue-target.ts            github_issue：同上
    gates/pr-publish.ts        從 relation/pr-publish.ts 搬入 + GateDefinition 包裝
    gates/issue-proposal.ts    同上
    prompts.ts                 relation/maintenance-target 教學行
    workspace.ts               github_prompt resolver
    feedback-filter.ts         從 relation/ 搬入
```

核心接口（簽名以此為準；只覆蓋現存三閘門/兩目標的並集）：

```ts
// loop/gates/registry.ts
export interface GateContext {
  loopId: string;
  runId: string;
  card: LoopCard;
  // 各 gate 落地所需的最小依賴集合（relation/proposal 單寫者等），
  // 由 app.ts 裝配時注入；gate 實現只許用 ctx 裡聲明過的東西。
  deps: GateDeps;
}

export interface GateDefinition {
  /** "pr_publish" | "issue_proposal" | "loop_proposal" */
  readonly kind: string;
  /** 卡片開關：false 時不教也不收（LOOP-PROPOSAL 的 can_propose_loops 語義）。 */
  enabledFor(card: LoopCard): boolean;
  /** prompt 教學行；僅 enabledFor(card) === true 時注入 runtime input。 */
  promptLines?(): string[];
  /**
   * run 完成時調用：從 finalText 解析並（掛起/落賬/丟棄）。
   * 鉗制、配額、冪等全部內聚在 gate 實現裡，核心不感知。
   * 返回 true = 本 run 被該 gate 消費（供 PR→ISSUE 兜底順序用）。
   */
  onRunCompleted(ctx: GateContext, finalText: string): Promise<boolean>;
}

export class GateRegistry {
  register(def: GateDefinition): void;           // 重複 kind 註冊直接 throw
  forCard(card: LoopCard): GateDefinition[];     // enabledFor 過濾後、註冊序
}
```

```ts
// loop/targets/registry.ts
export interface TargetPollContext {
  lifecycle: RelationLifecycleService;
  triggerQueueStore: TriggerQueueStore;
  drainPendingTriggers?: (loopId?: string) => Promise<void>;
}

export interface TargetAdapter {
  readonly targetType: string;                    // "github_pr" | "github_issue"
  /** 輪詢一個 relation；返回產生的喚醒事件數。 */
  poll(relation: RelationRecord, ctx: TargetPollContext): Promise<number>;
  /**
   * 處理一次 webhook 投遞；返回路由響應體（路由層統一 202）。
   * 多 relation 逐個喚醒與 event_id 後綴邏輯留在路由層，adapter 只處理單個。
   */
  handleWebhook(
    relation: RelationRecord,
    payload: Record<string, unknown>,
    ctx: TargetWebhookContext,
  ): Promise<Record<string, unknown>>;
  /** relation 狀態 → 通用 MaintenanceTargetState 的映射（存儲層調用）。 */
  toTargetState(state: string): MaintenanceTargetState;
  fromTargetState(state: MaintenanceTargetState, fallback?: unknown): string;
}

export class TargetAdapterRegistry {
  register(adapter: TargetAdapter): void;         // 重複 targetType 直接 throw
  get(targetType: string): TargetAdapter | null;  // 未知類型返回 null，調用方跳過並 warn
}
```

`RelationRecord.subject` 從封閉 union 改為開放形狀 `Subject = { type: string } & Record<string, unknown>`；
`GithubPrSubject/GithubIssueSubject` 降格為 adapter 內部類型（adapter 自行窄化校验）。
**狀態字符串與存儲字段不變**——這是向後兼容紅線。

## 3. 遷移步驟（每步獨立提交點，順序執行）

### S1 GateRegistry 落地（行為零變化）
- 新建 `loop/gates/registry.ts`（接口如上）。
- `turn-loop.ts:1354-1386` 的內聯段替換為：
  `for (const gate of gateRegistry.forCard(ctx.card)) { if (await gate.onRunCompleted(...)) break-or-continue }`
  ——注意保留現有語義：PR 閘門命中後 ISSUE 閘門不再嘗試（兜底順序），LOOP-PROPOSAL 與前兩者獨立（都要跑）。
  實現上給 GateDefinition 加 `exclusiveGroup?: string`（pr/issue 同組）或讓 onRunCompleted 返回
  consumed 由核心決定繼續與否——二選一，在代碼註釋裡說明理由。
- 三個閘門以**現狀函數的薄包裝**註冊（registerGithubPrPublish 等原樣不動）。
- `app.ts` 裝配處構建 registry 並注入 LoopRunService（deps 加 `gateRegistry`）。
- 驗證：`pnpm --filter @yep-anywhere/server test` 全綠（29 個 github 路由測試 + proposal 測試一個字不改）。

### S2 prompt 教學走 registry
- `runtime-input.ts` 的 relation/loop-proposal 教學段改為遍歷 `gateRegistry.forCard(card)` 的
  `promptLines()`；`maintenanceTargetPromptLines` 暫留（它依賴 target 實例而非卡片，S3 再收）。
- assembleRuntimeInput 的 deps 加 registry；既有測試（runtime-input.test.ts）應無需修改即綠，
  若有 fixture 缺 registry，補一個註冊了三閘門的測試用 registry helper（放 `loop/gates/testing.ts`）。

### S3 TargetAdapterRegistry 落地（本計劃主體）
- 新建 `loop/targets/registry.ts`。
- poller：`RelationPoller.pollOnce` 改為遍歷 relations 後按 `subject.type` 查 registry 分發；
  現 PR 主體（relation-poller.ts:94-290）與 `pollIssueRelation` 原樣搬成兩個 adapter 的 `poll`。
- webhook：`routes/github.ts` 的 `handleWebhookRelation` 改為經 registry 分發到 adapter；
  **保留 2026-08-16 修復的語義**：多 relation 逐個喚醒（`findAllByGitHubPr/Issue`）、
  event_id 帶 relation 後綴、issue_comment 經 `issue.pull_request` 路由到 github_pr、
  作者過濾——這四條各有測試守護（github.test.ts 的 28/29 號用例等），分發改寫後必須原樣全綠。
- relation-store：`relationStateToTargetState/targetStateToRelationState` 改為查 adapter 的
  `toTargetState/fromTargetState`；subject 類型放寬（開放形狀），`GithubPrSubject` 等移入 adapter
  並在 store 保留 re-export 兼容層（標 `@deprecated`，禁止新代碼引用）。
- feedback-filter 移入 adapter；poller/webhook 經 ctx 拿到它（self login 緩存隨 adapter 走）。
- 驗證：server 全鏈 + relation-poller.test.ts（683 行，12 個用例）原樣全綠。

### S4 Workspace resolver 註冊化
- `workspace.ts` 的 `isGitHubPromptLoop` 分支搬入 adapter 的 `resolveWorkspace`；
  通用 `managed://` 分支與越界拒絕（path traversal 守衛）**留在核心**——那是全局安全閘，
  不屬於任何 adapter。順序：github resolver 先匹配，核心 managed:// 兜底。
- `workspace.test.ts`（2 用例）原樣全綠，另加 1 例：github_prompt 卡經 adapter resolver 解析。

### S5 前端 kind 註冊化（最小版）
- 後端：`GET /api/loop-proposals` 這類列表響應裡的記錄自帶 `kind` 字段（已有）；
  ActionInbox 的 `kindLabel/kindClass` switch 改為「內建默認 + 後端 manifest 覆蓋」的 Map
  （manifest 由 adapter 在 `GET /api/loop-center/capabilities` 之類的聚合端點暴露）。
  **範圍控制**：只把標籤/配色/卡片鏈接規則抽成 kind 鍵控的 map，不發明 UI 插件協議。
- LoopDetailPage 的 GitHub 專屬區塊（GitHubRelationCard）保持原樣，不在本期動。

### S6 文件搬遷與清掃
- `pr-publish.ts` → `adapters/github/gates/`；`feedback-filter.ts` → `adapters/github/`；
  relation/ 只留通用存儲 + 生命週期；loop/index.ts 的 barrel 更新。
- 全倉 grep `github_prompt|github_pr|github_issue`：`loop/` 核心（adapters/ 以外）應只剩
  兼容層 re-export 與測試 fixture。
- 更新 `AGENTS.md`/`CLAUDE.md` 中受影響的結構描述（若有）。

## 4. 驗收

每步：① `pnpm --filter @yep-anywhere/server test` ② 根目錄 `pnpm typecheck` ③ `pnpm lint` 全綠。

終驗收（S6 後）：
1. 全量測試鏈 + typecheck + lint 全綠，且既有測試文件**零改動**（fixture 補 registry 除外）；
2. 新增 registry 單測：重複註冊 throw、未知 targetType 返回 null 並跳過、
   一個 dummy adapter（`local_dir` 形態）在測試裡註冊後能被 poller 分發——
   這是「第二形態零核心改動」的可執行證明；
3. 生產數據兼容：用真實 `~/.yep-anywhere/loops/maintenance/targets.json`（拷貝到臨時
   dataDir）啟動測試，RelationStore.list() 與既有 relation 讀取無差異；
4. `grep -c "github_" packages/server/src/loop --exclude-dir=adapters` 中核心引用收斂到
  兼容層（目標：除 re-export 與測試外為 0）。

## 5. 風險與迴避

- **最大風險是 S3 的 webhook 分發改寫弄壞觸發層**——該層 2026-08-14~16 剛修過四輪
  （見 `docs/plans/trigger-layer-correctness-plan.md` 與 commit `56810c8`），每條語義都有
  生產事故對應。改寫時把 github.test.ts 的 29 個用例當契約，先跑通再重構內部。
- registry 依賴裝配順序：adapter 註冊必須早於首次 poll/run。在 app.ts 裝配處加
  `registry.freeze()`，凍結後再 register 直接 throw，把順序錯誤變成啟動即炸。
- 別碰 turn 執行、verification、control-plane——本期它們不在縫上。
- 如果發現某處「GitHub 特異性」其實被非 GitHub 路徑依賴（例如 `rel-${loopId}-${runId}`
  的 relation_id 命名被前端解析），停下來記進計劃附錄，不要現場發明兼容方案。
