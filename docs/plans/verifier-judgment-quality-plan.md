# Verifier 裁決質量修復任務書（judge 獨立性 + 任務類型口徑 + 低風險自動出口）

> **交接說明**：本文件是可直接執行的修復任務書。讀者是執行改造的 coding agent（DeepSeek）。
> 所有行號以 2026-08-14 的工作區為準（最近相關提交 `b7111d2`）。若行號漂移，按符號名
> 搜索定位。開始前請先閱讀倉庫根目錄 `AGENTS.md` 與 `CLAUDE.md`，以及姊妹篇
> `docs/plans/loop-operations-hardening-plan.md`（「被生產數據證明正確的決策」一節
> 是本任務書的邊界：fail-closed 不可翻轉）。
>
> **執行紀律**：
> - 最小改動，不順手重構無關代碼；註釋風格跟隨所在文件（該子系統大量使用中文註釋）。
> - 每完成一個項目跑該項列出的驗證命令，全綠再進下一項。
> - schema / adapter_policy 鍵變更必須向後兼容：舊 card、舊 payload 行為不變。
> - **憑證紀律**：任何 API key 只走環境變量或既有 credential store，**嚴禁寫進
>   代碼、測試、文檔或 git 歷史**。kimi 的 key 由部署者配置
>   （如 `MOONSHOT_API_KEY` / `KIMI_API_KEY`，以實際接入的 provider 通道為準）。
>
> **背景事件**：2026-08-14 aiHub E2E（PR #6，docs-only marker 文件）暴露 L4 verifier
> 結構性偏向 inconclusive：judge 與 maker 同模型（deepseek-v4-flash 自評），prompt
> 要求「證據不足 = inconclusive，不要猜」，聚合層 inconclusive 蓋掉 passed，控制面
> 無自動路徑直接 needs_human。本次三個修復項分別對應裁判資格、裁決口徑、出口洩壓。

---

## 修復項 1：judge 獨立——verifier 可配置獨立 provider/model（kimi k3-256k）

**問題與證據**：
`packages/server/src/loop/verification/agent/run-verifier-agent.ts:100-103`——
judge 的 `providerName` 與 `model` 直接繼承 maker 的 `loopRuntime(ctx.card)`。
`adapter_policy` 目前只有 `model` / `timeout_seconds` 兩個消費鍵
（`packages/server/src/loop/assembly/adapter-policy.ts:33-51`），且 `model` 同時
覆蓋 maker 和 judge（turn-execution 與 run-verifier-agent 都讀它）——**現有旋鈕
無法讓 judge 與 maker 不同**。同模型自評 + adversarial prompt = 結構性 inconclusive。

**目標配置**：judge 使用 **kimi k3-256k**（部署方指定的模型名，執行時先核對
Moonshot 控制台的準確 model id 與接入方式），maker 保持 loop 自己的
provider/model 不變。

**路由現狀（2026-08-14 查證，本項的設計前提）**：
- maker 的 provider/model 已是 per-loop 可配：UI 表單 → `loopCardBuilder.ts:101-109`
  → `card.loop.runtime`（schema `loop-card.ts:217-222`）→ `turn-execution.ts:596-597`。
- 五個消費點全部讀同一份 `loopRuntime(ctx.card)` + 同一個 `adapterPolicy.model`：
  maker（`turn-execution.ts:596-597`）、L4 verifier（`run-verifier-agent.ts:100-103`）、
  interaction agent（:52-55）、policy reviewer（`reviewer.ts:310-313`）、
  artifacts（`artifacts.ts:216-219`）。本項只拆 L4 verifier 這一處，其餘不動。
- provider 是**進程級單例**（`codex.ts:2854` 無參構造）：**model 是 per-call 傳的
  （`startSession` 參數），endpoint/key 是 per-process 共享的**（codex CLI 的
  `~/.codex` 配置或進程環境；`config.baseUrl → OPENAI_BASE_URL` 的覆蓋路徑存在於
  `codex.ts:836-841` 但單例未啟用）。因此 judge 用 kimi + maker 用 deepseek 若
  同走 codex provider，單個進程全局端點無法同時指向兩家——這是本項真正的
  攔路虎，不是 schema 問題。

**修改點**：
- `packages/server/src/loop/assembly/adapter-policy.ts`：`ResolvedAdapterPolicy`
  新增兩個可選鍵 `verifier_model`（string）與 `verifier_provider`（string，
  取值限 `ProviderName` 合法值）；未知鍵仍記 `ignoredKeys`，不向後兼容破壞。
- `run-verifier-agent.ts:100-103`：改為
  `providerName: adapterPolicy.verifierProvider ?? loopRuntime(ctx.card)?.provider`、
  `model: adapterPolicy.verifierModel ?? adapterPolicy.model ?? loopRuntime(ctx.card)?.model`。
  即：顯式 verifier 配置 > 通用覆蓋 > maker 繼承。
- kimi 接入通道（兩條路徑，**按順序嘗試**，選通了的那條並在完成報告說明）：
  1. **per-call env 覆蓋**：`run-verifier-agent.ts:98-99` 已把 `env: ctx.input.env`
     傳進 `startSession`。先查 codex provider 的 env 合併順序（`codex.ts`
     buildEnv 與 session env 誰覆蓋誰）：若 session env 優先，judge 側傳
     `OPENAI_BASE_URL`（Moonshot 端點）+ key 即可 per-call 指向 kimi，
     `verifier_provider: "codex"` + `verifier_model: "<kimi model id>"`，
     不動 provider 架構。若合併順序不利，最小改動是讓 session env 優先
     （只影響顯式傳 env 的調用方，現狀只有 verifier/interaction agent 傳）。
  2. **judge 走不同 provider**：參照 `claude-ollama.ts:226` 注入
     `ANTHROPIC_BASE_URL` 的先例，給 judge 用另一家 provider 通道接 kimi
     （OpenAI 兼容），與 maker 的 codex 進程級端點天然隔離。
  無論哪條，model id 以 Moonshot 控制台為準核對；key 只走環境變量，
  嚴禁硬編碼端點或憑證。兩條都走不通時如實記錄缺口，不交半成品。
- 在 `human-report.md` 或 ledger 能力快照中記錄本輪 judge 的 provider/model，
  保證「以為生效其實沒有」可被審計（跟隨 adapter-policy.ts:12-13 的既有哲學）。

**測試**：
- adapter-policy 單測：新鍵解析、非法值進 `ignoredKeys`、舊 payload 行為不變。
- verifier agent 測試（跟隨既有測試文件模式）：設 `verifier_model` 後
  `startSession` 收到的 model/provider 為新值；不設則與現狀一致。

**驗證**：`pnpm --filter @yep-anywhere/server test` 全綠 + `pnpm typecheck`。

## 修復項 2：裁決口徑按任務類型分流——docs-only/chore 變更不要求測試證據

**問題與證據**：
`packages/server/src/loop/verification/agent/prompt.ts:128` 的裁決口徑是單一
通用標準：「證據不足 = inconclusive，不要猜」。對 docs-only / marker / config
類變更，「沒有測試、沒有可執行驗證」是**預期狀態**而非證據不足——下層
static/runtime 天然無產出，全部壓到 L4，L4 按通用口徑只能給 inconclusive。
聚合層 `aggregate.ts:32-37`（inconclusive 蓋掉 passed）與控制面
`decide.ts:172-176`（inconclusive 無自動路徑）把這個偏向放大成 needs_human。
**注意**：聚合與控制面的 fail-closed 行為不動，本項只改 L4 的裁決口徑。

**修改點**：
- `packages/server/src/loop/verification/agent/prompt.ts`：在裁決口徑段
  （:128 附近）增加任務類型分支指示。判別依據用 L4 輸入裡已有的 diff 摘要
  （檔案路徑清單）：
  - 變更僅觸及文檔/註釋/標記文件（`*.md`、`docs/**`、LICENSE、changelog 等，
    無可執行代碼改動）→ 裁決標準改為：①文件確實落盤且位置符合意圖；
    ②內容與 intent contract 的需求對齊；③無代碼語義改動混入。三條滿足即可
    給 `passed`，**不得**以「無測試證據」為由給 inconclusive。
  - 含代碼改動 → 維持現行口徑（證據不足 = inconclusive，不要猜），一字不改。
- prompt 中明確：分類判斷本身不確定（例如 md 與代碼混合且難以界定）時，
  按代碼口徑從嚴——分類層同樣 fail-closed。

**測試**：
- prompt builder 的單測（若已有則跟隨其模式）：斷言新口徑段落存在且
  代碼口徑原文未變。
- 無現成 L4 mock 測試基礎的話，補一個最小用例：構造 docs-only 的
  verification input，斷言 prompt 包含 docs 分支指令。

**驗證**：server 測試全綠。**生產驗收**：重跑一個 docs-only 的 github
maintenance 小任務（可復用 aiHub 模式），確認 L4 對 marker 文件給 passed
而非 inconclusive，run 自主 complete。

## 修復項 3：低風險 loop 的自動出口——接通 `auto_approve_low_risk`

**問題與證據**：
`HumanGateSla` schema 與 sweep 機制已建成
（`packages/shared/src/loop-schema/loop-card.ts:5-15`；
`packages/server/src/loop/control-plane/control-plane.ts:121-125` 出廠默認
24h 催辦 / 7 天 abandon / policy=keep；`sweepHumanSla()` 1221-1310 含
auto-approve-low-risk 分支 1270+）。但默認 policy 是 `keep`——不修復項 3，
verifier  inconclusive 積壓依然只有人工一個出口。本項讓低風險 loop
（github 維護類、docs-only 類）能啟用 `auto_approve_low_risk`。

**修改點**：
- 確認 `sweepHumanSla` 的 auto-approve 分支（control-plane.ts:1270+）對
  「verifier inconclusive → needs_human」這類 human_reasons 的適用性：
  目前 low-risk 的判定依據是什麼（human_reasons code 白名單？card 標記？），
  若判定依據不含 verification 類 inconclusive，擴充白名單並寫清註釋
  （fail-closed 精神：擴充只加明確低風險的 code，如 `verification_inconclusive`
  對應的 code；`execution_failed`、`duplicate_pr` 等永遠不进白名單）。
- 建卡链路：`packages/client/src/lib/loopCardBuilder.ts` 的 github 類卡構建處，
  給 `human_gate_sla` 提供可選配置（UI 不強求，本項只要求 card schema 可表達 +
  builder 可透傳；UI 引導屬 hardening 計劃 #4 殘留子項，不在此做）。
- 文檔：在 card schema 註釋或 `docs/` 相應位置說明三檔 policy 的適用場景。

**測試**：
- `control-plane.test.ts`（跟隨 177-207 既有 SLA 測試模式）：低風險 code +
  policy=auto_approve_low_risk + 超時 → 自動 approve 且事件落 EventBus；
  非白名單 code + 同 policy → 不自動 approve。

**驗證**：server 測試全綠。生產觀察：下一個 inconclusive needs_human 在
SLA 窗口後被自動處置（而非無限期泊車）。

---

## 執行順序與總驗收

順序：1 → 2 → 3（項 1 改變 judge 質量，項 2 改變裁決口徑，兩者疊加後
項 3 的自動出口風險才可控——先讓裁決變準，再給 inconclusive 開自動閥）。

每項完成後跑 `pnpm --filter @yep-anywhere/server test`；全部完成後跑
`pnpm typecheck` 與 `pnpm lint`。

**總驗收（生產閉環）**：用一個 docs-only github maintenance 任務重跑
`pnpm test:loop:github:pr-maintenance`（腳手架在
`benchmarks/loop-runtime-eval/run-github-pr-maintenance-flow.ts`，
judge 配置為 kimi k3-256k），達成：run 無人工干預自主 complete、L4 裁決
passed、ledger 可見 judge 的 provider/model 記錄。結果 JSON 落盤到
`benchmarks/loop-runtime-eval/results/pr-maintenance-<timestamp>.json`
（給腳本補落盤，目前只打 stdout——`run-github-pr-maintenance-flow.ts:226`）。
