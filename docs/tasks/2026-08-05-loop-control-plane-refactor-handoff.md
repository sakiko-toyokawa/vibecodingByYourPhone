# Loop 子系統 Phase 3 重構交接單

> 交接人：Kimi Code CLI  
> 時間：2026-08-05  
> 範圍：`packages/server/src/loop/` 下 `run-service.ts` 與 `control-plane.ts` 的拆分重構，以及 active run 重啟恢復

**狀態速覽**：
- ✅ `run-service.ts` / `control-plane.ts` 拆分完成
- ✅ active run 重啟恢復完成（新增 `ControlPlane.failRun()` 兜底，避免不可恢復 run 永遠卡住）
- ✅ 空轉檢測 + 死循環檢測（P0，已實作並驗收）
- ✅ 既有 lint 錯誤已清理完畢（0 errors）
- ✅ `loopWatchdog` 閾值已暴露為啟動選項 / 環境變數
- ✅ 已開始補充子模組單元測試（`control-plane/blocker.test.ts`）
- ⏳ 繼續補充 `control-plane/` 與 `run/` 其餘子模組的單元測試（P2）

---

## 1. 本次已完成的任務

### P1：拆分 `run-service.ts` 為子模組（已完成）

已創建以下模組，並將 `run-service.ts` 重寫為薄 facade：

- `packages/server/src/loop/run/types.ts`
- `packages/server/src/loop/run/workspace.ts`
- `packages/server/src/loop/run/ledger-summary.ts`
- `packages/server/src/loop/run/artifacts.ts`
- `packages/server/src/loop/run/turn-execution.ts`
- `packages/server/src/loop/run/context.ts`
- `packages/server/src/loop/run/turn-loop.ts`

### P1：拆分 `control-plane.ts` 為子模組（已完成）

已創建以下模組，並將 `control-plane.ts` 重寫為薄 facade：

- `packages/server/src/loop/control-plane/types.ts`
- `packages/server/src/loop/control-plane/blocker.ts`
- `packages/server/src/loop/control-plane/budget.ts`
- `packages/server/src/loop/control-plane/lookup.ts`
- `packages/server/src/loop/control-plane/side-effects.ts`
- `packages/server/src/loop/control-plane/transition.ts`

### P2：`loopWatchdog` 閾值暴露為啟動選項（已完成）

新增 `AppOptions` / `Config` 欄位與環境變數：

- `loopIdleNoProgressTurnsThreshold` → `LOOP_IDLE_NO_PROGRESS_TURNS`
- `loopRepeatedBlockerThreshold` → `LOOP_REPEATED_BLOCKER_THRESHOLD`

並在 `server.ts` 傳入 `createApp`，`app.ts` 最終寫入 `loopWatchdog`。預設值仍為 3，可視生產情況調整。

### P2：補充子模組單元測試（部分完成）

已新增 `packages/server/src/loop/control-plane/blocker.test.ts`，直接覆蓋 blocker fingerprinting 的穩定性、差異化、正規化與 policy escalation 行為。該測試已加入 `packages/server/package.json` 的 `test` script。

### 驗收狀態（全部通過）

| 命令 | 結果 |
|------|------|
| `pnpm --filter @yep-anywhere/server build` | 通過 |
| `pnpm typecheck` | 通過 |
| `pnpm --filter @yep-anywhere/server test` | 全部通過 |
| `pnpm lint` | 通過（0 errors） |

---

## 2. 尚未完成的 P0 生產風險任務（需交接給下一位接手者）

根據用戶提供的慶典優先級，以下兩項 **P0** 尚未開始實作，存在直接生產風險：

### 2.1 空轉檢測 + 死循環檢測（已完成）

**問題**：輪次可能無限掛起（例如 retry 循環、重複子任務推進、或執行層未產出有效 diff）。

**已實作**：
- 擴充 `loopWatchdog` 設定（`packages/server/src/loop/run/types.ts` / `run-service.ts` / `app.ts`）：
  - `idleNoProgressTurnsThreshold`：連續 N 輪 retry 但 workspace diff stat 無變化 → 視為空轉。
  - `repeatedBlockerThreshold`：同一 `blocker_fingerprint` 在單次 run 內連續出現 N 次 → 視為死循環。
- 在 `packages/server/src/loop/run/turn-loop.ts` 的 `runTurns` 中：
  - 連續相同輸出（`similar_output`）與連續無 diff 進展（`no_diff_progress`）會呼叫 `escalateToNeedsHumanForStagnation()`，將 judgment 升級為 `needs_human` 並寫入 `loop-stagnation.json` artifact。
  - 當 control decision 結果為 `needs_human` 且 `repeated_blocker_count >= repeatedBlockerThreshold` 時，呼叫 `ControlPlane.failRun(runId, reason, { force: true })` 強制轉為 `failed`，避免永遠等待人工。
- `ControlPlane.failRun()` 新增 `{ force?: boolean }` 選項：預設仍保留 `needs_human` / `paused` / `budget_limited` 給人工決策；`force: true` 時可從 blocking state 強制轉為 `failed`（供死循環打斷使用）。

**新增/更新測試**：
- `packages/server/src/loop/run-service-idle-stagnation.test.ts`
  - idle watchdog 殺死無活動輪次（既有）。
  - 連續相同 retry 輸出 → `needs_human`（既有）。
  - 連續 retry 但 diff stat 無變化 → `needs_human`（新增）。
  - 同一 blocker 重複出現 → 強制 `failed`（新增）。
- `packages/server/package.json` 已將新測試加入 `test` script。

**相關文件**：
- `packages/server/src/loop/run/turn-loop.ts`
- `packages/server/src/loop/control-plane/control-plane.ts`
- `packages/server/src/loop/control-plane/blocker.ts`
- `packages/server/src/loop/run-service.ts`
- `packages/server/src/app.ts`
- `packages/server/src/loop/run-service-idle-stagnation.test.ts`

### 2.2 active run 重啟恢復（已完成）

**問題**：伺服器重啟後，處於 `active` / `retry` 狀態的 run 若無法恢復執行，會永遠卡在非終止狀態。

**已實作**：
- `app.ts` 啟動時已掃描 `RunStateStore.list()` 並對 `active` / `retry` run 調用 `LoopRunService.resumeAfterRestart()`。
- `resumeAfterRestart()` 會嘗試通過 `rebuildContext()` 重建執行上下文並續跑同一輪。
- **新增安全網**：當上下文無法重建，或恢復後的 run 在產生 judgment 前崩潰時，會調用 `ControlPlane.failRun()` 將 run 強制轉移到 `failed`，避免永遠卡住。
- `failRun()` 只對 `active` / `retry` 生效；`needs_human` / `paused` / `budget_limited` 等等待人工決策的狀態會被保留。

**相關文件**：
- `packages/server/src/loop/run/turn-loop.ts`（`resumeAfterRestart` + 失敗兜底）
- `packages/server/src/loop/control-plane/control-plane.ts`（新增 `failRun`）
- `packages/server/src/loop/app.ts`（啟動掃描）
- `packages/server/src/loop/run-service-restart-recovery.test.ts`（新增不可恢復場景測試）

---

## 3. 已知技術債與 lint 狀態

`pnpm lint` **已通過（0 errors）**。本次清理了重構前遺留的 15 個 lint 錯誤，分佈於：

- `packages/server/src/loop/contract/planner.ts` — 重命名遮蔽全局的 `escape` 變數。
- `packages/server/src/loop/assembly/runtime-input.ts` — 移除無插值的模板字串。
- `packages/server/src/loop/run/types.ts` — import 排序與格式化。
- `packages/server/src/loop/run/workspace.ts` — import 排序與格式化。
- `packages/server/src/loop/run/artifacts.ts` — 函數簽名與三元運算子格式化。
- `packages/server/src/loop/run/ledger-summary.ts` — 格式化。
- `packages/server/src/loop/run-service-planner.test.ts` — 移除非空斷言。
- `packages/server/src/loop/verification/strategies/contract-criteria.ts` — 移除無插值模板字串。

**注意**：所有新增與修改的檔案均已清理乾淨，不再貢獻 lint 錯誤。

---

## 4. 關鍵文件清單

### 新拆分出的控制面子模組

```
packages/server/src/loop/control-plane/
├── control-plane.ts      # 薄 facade，保留 class 公開 API
├── types.ts              # 共享型別與 state shape
├── blocker.ts            # blocker fingerprinting
├── budget.ts             # 預算耗盡檢查與告警
├── lookup.ts             # run / waiting run / exists 查詢
├── side-effects.ts       # 事件發射、STATE.md 投影、learning_event
└── transition.ts         # 單一寫入狀態轉移路徑 + 失敗歸因
```

### 新拆分出的 run-service 子模組

```
packages/server/src/loop/run/
├── types.ts
├── workspace.ts
├── ledger-summary.ts
├── artifacts.ts
├── turn-execution.ts
├── context.ts
└── turn-loop.ts
```

### 入口/整合點

- `packages/server/src/loop/run-service.ts` — 調度 run 子模組與 control-plane
- `packages/server/src/loop/index.ts` — 對外 export `ControlPlane` 等

---

## 5. 注意事項

1. **避免循環 import**：本次重構已修復 `blocker.ts` 與 `side-effects.ts` 的循環引用風險。後續新增 control-plane 子模組時，請只從 `types.ts` 取型別，業務邏輯通過函數參數傳入 `deps` 與 `state`。
2. **狀態單一寫入者**：所有狀態遷移必須經由 `transition.ts` 的 `transition()`，避免在 run-service 層直接寫 `runStateStore.save()`。
3. **測試鉤子**：`settleLearningEvents()` 與 `settleStateMdProjections()` 仍保留在 `ControlPlane` 上，供測試等待 fire-and-forget 副作用。

---

## 6. 建議下一步（優先順序）

1. **P2**：繼續補充 `control-plane/` 與 `run/` 子模組的單元測試。已新增 `packages/server/src/loop/control-plane/blocker.test.ts`，後續可優先補充：
   - `transition.ts`：狀態轉移、失敗歸因、預算快照。
   - `budget.ts`：`exhaustedAtTurnStart` / `exhaustedFields` 各種邊界。
   - `lookup.ts`：`findRun` / `findWaitingRun` / `runExists`。
2. **P3**：觀察生產環境中空轉/死循環閾值的實際表現，必要時調整 `LOOP_IDLE_NO_PROGRESS_TURNS` / `LOOP_REPEATED_BLOCKER_THRESHOLD` 預設值。
