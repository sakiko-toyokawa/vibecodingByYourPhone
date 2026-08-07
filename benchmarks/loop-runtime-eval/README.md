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
