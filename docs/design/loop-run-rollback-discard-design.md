# Loop Run 回滾 / 丟棄設計

> 狀態：已實作（2026-08-09）
> 日期：2026-08-09
> 優先順序：P0

## 一、背景與現狀

目前 loop run 有三種接近「丟棄」的能力：

- worktree 策略在未 approve 時可保留或清理 worktree，但沒有統一的「丟棄本次 run」操作。
- direct 策略每輪會產生 `diff-turnN.patch` 等證據，但只能人工以 git 指令還原。
- `LoopCardStore.archiveLoop` 只歸檔整個 loop，不能針對單一 run。

因此使用者缺少一個可審計、冪等、可預期的單次 run 丟棄入口。

## 二、設計決策

### 2.1 新增 discarded 終態

- `RunStateSchema` 新增 `"discarded"`。
- `DecisionKindSchema` 新增 `"discarded"`，對應 `DecisionEntry`。
- `discarded` 是終態，不自動 resume、不進入 retry，也不參與學習提案的 retry 歸因。
- ledger、artifacts、decision entry 保留；只有 worktree 可依選項清理，審計證據不刪。

### 2.2 API

新增 `POST /api/runs/:id/discard`。

```json
{
  "reason": "run produced unwanted changes",
  "revert_files": true,
  "cleanup_worktree": true,
  "force": false
}
```

規則：

- `reason` 必填。
- `revert_files` 預設 true，direct 策略下將 run 的 workspace 修改還原。
- `cleanup_worktree` 預設 true，worktree 策略下清理 run worktree 與 branch。
- active/retry 預設 409；`force: true` 時先終止執行程序再執行 discard。
- `discarded` 後再次呼叫同一 endpoint 回傳 409 `invalid_state`，避免重複副作用。

### 2.3 Direct 回滾

- 以 run 的 checkpoint workspace snapshot 與每輪 diff 為回滾事實源。
- 回滾前比對目前 workspace `HEAD` / status；與 run 結束後的外部改動衝突時拒絕，除非 `force: true`。
- 回滾結果寫入 `discard-result.json` artifact，包含成功、失敗、未處理檔案與原因。
- 非 git workspace 不自動 revert；呼叫端需在回應中收到明確錯誤，避免假成功。

### 2.4 Worktree 清理

- `cleanup_worktree: true` 時刪除 `<dataDir>/worktrees/<loop_id>/<run_id>` 與 `loop/<run_id>` branch。
- 清理前先確認 run 已終止，且沒有其他 turn 正在使用該 worktree。
- 清理失敗不影響 run 狀態改為 discarded；失敗資訊進 artifact，後續由 cleanup job 重試。

## 三、介面與資料流

```text
POST /api/runs/:id/discard
  -> runService.discardRun(runId, options)
  -> controlPlane.markDiscarded(runId)
  -> workspace rollback / worktree cleanup
  -> decision ledger + discard-result artifact
```

## 四、邊界與失敗模式

- active/retry 未帶 force：409。
- run 不存在：404。
- direct 回滾遇到外部修改：409，除非 force。
- 非 git direct workspace 且 `revert_files: true`：400，提示改用 `revert_files: false`。
- 回滾部分失敗：run 仍標記 discarded，artifact 標註失敗清單。
- worktree 清理部分失敗：不遮蔽 discard 成功，清理 job 重試。

## 五、驗收標準

- discard 後 run_state 為 `discarded`，decision ledger 有對應 entry。
- direct discard 成功後，run 修改的檔案回到 checkpoint snapshot。
- worktree discard 成功後，run worktree 與 branch 不再存在。
- 重複 discard 回傳 409。
- UI 可展示預期影響檔案數、目前 git 狀態與確認按鈕。
