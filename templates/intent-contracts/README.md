# 意圖合約範本庫（P5）

常見 `task_type` 的既定合約形狀。LoopCard 開啟
`loop.intent_understanding.use_agent` 後，合約構建順序：

1. `handoff.default_task_type` 命中範本 → 直接套用，**視為已人工確認**
   （範本本身就是人審過的），不調用 LLM。
2. 未命中 → 意圖理解 Agent 產生合約草案，`confirmed_by_human=false`，
   run 在首輪執行前泊入 `needs_human`；人工 approve 視為確認。
3. Agent 失敗 → 回退確定性裝配（既有行為）。

## 權威來源

運行時讀取的是程式碼內常量
`packages/server/src/loop/contract/intent-templates.ts`
（server 不依賴倉庫相對路徑讀檔）。本目錄的 JSON 是給使用者參考的
鏡像副本；修改範本請改 TS 常量並同步這裡。

## 檔案

- `read-only-report.json` → task_type `read_only_report`
- `dependency-update.json` → task_type `dependency_update`
- `maintenance.json` → task_type `maintenance`
