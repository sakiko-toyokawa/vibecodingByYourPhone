# Phase 7 整合測試與性能基準計劃

> 上游總計劃：`docs/plans/loop-verifier-state-implementation-plan.md`
> 狀態：已實作；本地 Codex runtime 已跑通 `read-only-todo-scan`
>（2026-08-08，chicken-farm / deepseek-v4-flash）

## 目標

Phase 7 把 Phase 0–6 的 Loop 模組串成可驗收的真實 runtime 全鏈路，並把
L3/L4 的常見失敗轉成既有 `FailureTag` 詞彙，最後用可重複執行的基準回答兩個
問題：

1. 從 `trigger → intent agent → maker → L1-L4 verifier → judgment → retry`
   的完整鏈路是否穩定。
2. 驗證成本是否維持在 Maker 成本的 30% 以下，state log 是否在大量事件下
   仍可快速讀取。

## 範圍

### 包含

- 真實 LLM/runtime full-chain harness。
- full-chain behavior cases。
- L3/L4 失敗歸因到 `FailureTag` 的確定性映射與 learning 消費驗證。
- structural / token / state log 性能基準。
- `CLAUDE.md`、`AGENTS.md`、benchmark README 與總計劃文件同步。

### 不包含

- 新增 HTTP API。
- 新增 `FailureTag` 新值（除非現有 8 值無法表達且已有 learning 消費者）。
- 把真實 runtime benchmark 變成無憑證 CI 必跑測試。

## 實作拆分

### 1. 真實 runtime full-chain harness

目標：`benchmarks/loop-runtime-eval/` 能啟動真實 provider session，跑完整
Loop 狀態機，並輸出可比較的 JSON report。

- 新增 `run-full-chain.ts`：
  - 讀 `PHASE7_PROVIDER`（預設 `claude`）、`PHASE7_MODEL`、
    `PHASE7_WORKSPACE`。
  - provider 未安裝或未認證時 fail fast。
  - 用真實 `Supervisor({ provider })` 取代 `FakeSupervisor`。
- 擴充 `evaluator.ts`：
  - `RuntimeEvalOptions` 增加 `provider`、`model`、`verificationRequired`、
    `useIntentAgent`、`taskType`、`expectedArtifacts`、`expectedFailureTags`。
  - full-chain card 啟用 `intent_understanding.use_agent` 與
    `rule / structural / review`，保留 `static / runtime` 短路。
  - `LoopRunService` 接上 `runStateStore`，讓 checkpoint / machine state /
    human report 一起被驗證。
- 新增場景：
  1. `read-only-todo-scan`：唯讀掃描 TODO，驗證 report artifact。
  2. `typescript-fix-retry`：TS 型別錯誤修復，驗證 structural + retry。
  3. `rule-violation-attribution`：硬編碼 secret 違規，驗證 failure tag。
  4. `review-adversarial`：review agent 產出 adversarial risk。
- 結果格式新增：
  - `metrics.makerTokens`
  - `metrics.verifierTokens`
  - `metrics.stateLogReadMs`
  - `metrics.checkpointCount`
  - `metrics.handoffCount`
  - `failureTags`

### 2. L3/L4 錯誤模式歸因

目標：decision ledger 與 learning event 能回答「這次失敗是哪一層、哪一類」。

- 新增 `loop/verification/failure-tags.ts`：
  - `mapVerifierFailureToTag(report, context)`。
  - `failureTagsFromReports(reports)`。
- 預設映射：

| 訊號 | FailureTag |
|---|---|
| L3 structural diagnostics / import cycle / schema error | `verification_error` |
| L4 review inconclusive + escalate / parse fallback | `verification_error` |
| verifier agent / tsc process crash | `runtime_blackbox_error` |
| `missing_required_artifact:*` evidence | `tool_error` |
| intent contract 缺 raw goal / 意圖理解缺口 | `intent_error` |
| policy 攔截 | `policy_error` |

- `verifyRun` 回傳 `failureTags`，turn-loop 傳進 `applyJudgment`，
  `attributeFailureTags` 合併既有 adapter/policy 歸因。

### 3. 性能與成本基準

目標：三項可量化指標：

1. `structural` 的 `tsc --noEmit` 啟動時間。
2. Maker 與 Verifier token 成本比例。
3. 1000 events 的 state log 讀取時間。

- 新增 `benchmarks/loop-runtime-eval/benchmark.ts`：
  - 產生 1000 個 `state_snapshot` / `checkpoint` event，量測
    `RunStateStore.load()` / `readEvents()`。
  - 量測最小 TS fixture 的 `tsc --noEmit` 時間。
  - full-chain run 完成後從 artifact 收集 token usage。
- 成本口徑：
  - Maker = executor runtime events 的 `input_tokens + output_tokens`。
  - Verifier = collector + review agent usage artifacts。
  - `verifier_cost_ratio = verifier / maker`。
- 驗收：
  - 平均 `verifier_cost_ratio <= 0.30`。
  - state log 1000 events p95 `< 100ms`。
  - 每個 full-chain 案例都有 checkpoint 與 machine-state artifact。

### 4. 文件同步

- 更新 `benchmarks/loop-runtime-eval/README.md`：
  - 真實 runtime 參數、provider 認證、輸出格式。
- 更新 `CLAUDE.md` / `AGENTS.md`：
  - Phase 7 benchmark 指令與成本口徑。
- 更新總計劃 Phase 7 章節：
  - 加入本文件連結與完成摘要。

## 測試計劃

1. `pnpm typecheck`
2. `pnpm lint`
3. `pnpm --filter @yep-anywhere/server test`
4. `pnpm test:loop-modules`
5. `PHASE7_PROVIDER=claude PHASE7_MODEL=<model> pnpm exec tsx benchmarks/loop-runtime-eval/run-full-chain.ts`
6. `pnpm exec tsx benchmarks/loop-runtime-eval/benchmark.ts`

本機 Codex 驗證指令（Windows PowerShell）：

```powershell
$env:PHASE7_PROVIDER='codex'
$env:PHASE7_MODEL='deepseek-v4-flash'
$env:PHASE7_CODEX_PROFILE='chicken-farm'
$env:PHASE7_CODEX_HOME="$env:USERPROFILE\.codex"
$env:PHASE7_CODEX_PATH='<codex.exe>'
pnpm test:phase7:full-chain read-only-todo-scan
```

2026-08-08 實跑結果：`finalState=complete`、8/8 stages passed、
`checkpointCount=1`、`handoffCount=2`、`missingArtifacts=[]`。

## 驗收標準

- 4 個 full-chain 場景在真實 runtime 下完成，且各場景產出 ledger、
  checkpoint、machine-state、human-report。
- L3/L4 failure tag 進入 decision entry 與 learning event，並有 unit test。
- benchmark report 落在 `benchmarks/loop-runtime-eval/results/`。
- 指標不低於上述門檻。
- 文件與實作一致。

## 假設

- 預設 provider 為 `claude`，可用 `PHASE7_PROVIDER` 換成
  `codex` / `gemini` / `codex-oss` 等既有 provider。
- 真實 runtime benchmark 需要有效 API key 或 CLI auth，因此是手動或排程
  基準，不是普通 CI unit test。
- `FailureTag` 詞彙不擴充，除非 mapping 證明必要。
