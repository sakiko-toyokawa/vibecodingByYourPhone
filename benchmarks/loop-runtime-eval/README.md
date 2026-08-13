# Loop Runtime Evaluation

不同於 `benchmarks/loop-modules/` 的單元/集成測試，這裏提供一個**端到端 runtime 評測器**：給定一個 prompt，啓動一次真實 loop run，實時追蹤狀態流轉，並對每個環節打分。

## 用途

- 給 loop 一個任務 prompt，觀察它如何走過 `trigger → contract → assembly → execution → verification → judgment → control_decision → state_persistence`。
- 看哪一環節失敗、哪一環節雖然沒崩潰但沒達到標準。
- 像 AI 模型基準一樣輸出每個 stage 的分數與 trace。

## 運行方式

```bash
npx tsx benchmarks/loop-runtime-eval/run.ts "Fix the failing test in src/"
```

可選參數：

```bash
npx tsx benchmarks/loop-runtime-eval/run.ts "Fix the failing test in src/" \
  --lint-fails \
  --test-fails \
  --max-turns 3 \
  --max-retries 2
```

- `--lint-fails`：讓目標 workspace 的 `lint` 腳本失敗，觀察 loop 如何處理 static 驗證失敗。
- `--test-fails`：讓 `test` 腳本失敗，觀察 runtime 驗證失敗。
- `--max-turns` / `--max-retries`：控制預算。

## 輸出說明

腳本輸出一份 JSON（stdout），包含：

- `loopId`, `runId`
- `finalState`：run 最終狀態
- `terminal`：是否到達終態
- `elapsedMs`：總耗時
- `stateTrace`：狀態流轉時間線
- `stages`：每個環節的通過狀態、分數、原因、證據
- `artifacts`：落盤的 artifact 名稱與內容
- `ledgerSummary`：決策條目與 run entry 數量

stderr 會同時輸出人可讀的摘要表格。

## 限制

- 目前使用 mock Supervisor，因此 **execution 階段不會真的調用 LLM/runtime**。它用來驗證 loop 管線本身的流轉與 artifact 落盤。
- 要評測真實 LLM/runtime，需要把 `FakeSupervisor` 替換成真正的 Supervisor 並配置 provider/API key。

## Phase 7：真實 runtime full-chain

Phase 7 新增 `run-full-chain.ts`，用真實 provider 跑完整
`trigger → intent agent → maker → L1-L4 verifier → judgment` 鏈路：

```bash
PHASE7_PROVIDER=claude PHASE7_MODEL=<model> pnpm test:phase7:full-chain
```

本機 Codex app-server 需要先解析 profile，因為 `--profile` 不適用於
`codex app-server`。Harness 會把 profile 的 provider 欄位轉成 `-c`
overrides：

```bash
PHASE7_PROVIDER=codex \
PHASE7_MODEL=deepseek-v4-flash \
PHASE7_CODEX_PROFILE=chicken-farm \
PHASE7_CODEX_HOME="$HOME/.codex" \
PHASE7_CODEX_PATH="$(command -v codex)" \
pnpm test:phase7:full-chain read-only-todo-scan
```

可選參數：

- `PHASE7_PROVIDER`：`claude` / `codex` / `gemini` / `codex-oss` 等既有 provider，預設 `claude`。
- `PHASE7_MODEL`：provider model 覆寫。
- `PHASE7_WORKSPACE`：指定目標 workspace；缺省建立臨時 workspace。
- `PHASE7_TIMEOUT_MS`：單一案例 timeout，預設 300000。
- `PHASE7_CODEX_PROFILE`：Codex profile 名；harness 轉成 app-server
  `-c` overrides。
- `PHASE7_CODEX_HOME`：profile 所在的 Codex home（Windows 下避免讀到
  外層 sandbox 的 `CODEX_HOME`）。
- `PHASE7_CODEX_PATH`：直接指定 codex 二進位路徑；Windows 下建議避開
  pnpm 的 Unix shim。
- 第一支 CLI 參數：指定單一 scenario id，例如 `read-only-todo-scan`。

provider 未安裝或未認證時 script 會 fail fast，不退回 mock。

## Phase 7：性能基準

```bash
pnpm benchmark:phase7
```

輸出 JSON 到 `benchmarks/loop-runtime-eval/results/`，量測：

- 1000 個 state event 的 `load()` / `readEvents()` p95。
- 最小 TS fixture 的 `tsc --noEmit` 啟動時間。
- full-chain run 的 Maker / Verifier token 成本與 checkpoint / handoff artifact 數量。

## GitHub PR Maintenance E2E

需要真實 server、provider auth 與 GitHub PAT：

```bash
GITHUB_TOKEN=ghp_... \
GITHUB_TEST_REPO=owner/repo \
GITHUB_TEST_ISSUE=12 \
SERVER_URL=http://127.0.0.1:3400 \
pnpm exec tsx benchmarks/loop-runtime-eval/run-github-pr-maintenance-flow.ts
```

驗證：issue 修復 → `PR-PUBLISH` → relation `pr_pending_approval` →
模擬人工 approve/mark-ready → webhook feedback → 同一 loop 維護 →
relation 回到 `awaiting_feedback`。測試結束會關閉建立的 PR；此流程需要
專用測試 repo，不要用正式 repo。
