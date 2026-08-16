# RunStreamOutput 解析器單測任務書（SDK 信封回歸網）

> **交接說明**：本文件是可直接執行的測試補強任務書。讀者是執行改造的 coding agent（DeepSeek）。
> 行號以 2026-08-16 工作區為準；若漂移，按符號名搜索定位。
> 開始前先讀倉庫根目錄 `AGENTS.md` 與 `CLAUDE.md`，並 `git status` 確認基線
> （工作區可能有他人未提交改動，不要覆蓋）。
>
> **執行紀律**：
> - 最小改動：本任務只做「抽純函數 + 加測試」，不順手改渲染邏輯、不改樣式。
> - 不許留 `// ... rest unchanged` 半成品；不許 git commit。
> - 註釋語言跟隨所在文件（client 組件現用簡體中文註釋）。

---

## 0. 背景與問題診斷

提交 `c60b6d3`（fix(client): unwrap SDK message envelope in run stream output）修了一個
生產 bug：loop run 的 stream 輸出頁面（LoopDetailPage → RunStreamOutput）一度只剩
`[result] turn finished`，中間所有 assistant/user/tool 內容全丟。根因是 agent SDK 的
runtime 事件是**信封結構**——真實內容在 `msg.message.content`（`{role, content}`），
而解析器只讀扁平的 `msg.content`。

修復沒有配套測試。`buildDisplayEntries` 是全前端**數據格式耦合最重**的函數：
SDK 升級改事件形狀、新增 runtime adapter（codex / claude / kimi 輸出形狀不同）、
或有人再動解析邏輯，都會無聲地讓頁面再次空白。需要一張回歸網。

## 1. 現狀

`packages/client/src/components/RunStreamOutput.tsx`（481 行）中以下部分是**純函數/純類型**，
與 React、loopsApi、WebSocket 無關，但當前是模塊私有、無法直接測：

- 類型：`RuntimeEvent`、`DisplayEntry`、`RuntimeContentBlock`
- 函數：`blockText`、`toolInputSummary`、`parseRuntimeEvents`、`turnOfEventFile`、`buildDisplayEntries`
- 常量：`MAX_PARSE_LINES`（5000）、`MAX_DISPLAY_ENTRIES`（200）

信封解包的核心邏輯在 `buildDisplayEntries` 開頭（約 140-147 行）：

```ts
const innerMessage =
  msg.message && typeof msg.message === "object"
    ? (msg.message as { role?: string; content?: unknown })
    : null;
const content = innerMessage?.content ?? msg.content;
```

**既有測試模式（照搬對象）**：

- 純邏輯抽取：`LoopApprovalCards.shared.tsx` / `FilePathLink.shared.tsx`——純函數放
  `.shared` 文件，組件本體再 import 回去。
- 測試文件：`LoopApprovalCards.test.tsx`（手寫 assert 風格）、
  `src/lib/loopDecisions.test.ts`（純 ts 測試範例）。
- 編譯鏈：`packages/client/tsconfig.test.json` 的 `include` 數組 + `packages/client/package.json`
  的 `test` 腳本（`tsc -p tsconfig.test.json` 編譯到 `.test-dist/`，再
  `node --experimental-specifier-resolution=node .test-dist/...test.js` 串聯）。
  **新文件必須同時加進這兩處**，否則測試根本不會跑。

## 2. 任務步驟

### 2.1 抽取純函數

新建 `packages/client/src/components/RunStreamOutput.shared.ts`（純 ts，無 JSX，
不 import React / loopsApi / hooks），把第 1 節列出的類型、常量、函數原樣移入並 `export`。
`RunStreamOutput.tsx` 改為從 `./RunStreamOutput.shared.js` import，刪除本地定義。
行為必須零變化——這是搬遷不是重寫。

### 2.2 新增測試

新建 `packages/client/src/components/RunStreamOutput.test.ts`，用 `node:assert/strict`，
覆蓋以下用例（fixtures 用下面的最小形狀即可；如能從生產 `~/.yep-anywhere/loops/` 下
某個 run 的 `runtime-events-turnN.jsonl` 摘 2-3 行真實事件脫敏後做 fixture 更好）：

1. **信封 assistant 文本**（c60b6d3 的核心回歸）：
   ```json
   {"at":"2026-08-15T10:00:00.000Z","message":{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"我先查看 issue 內容。"}]}}}
   ```
   預期：產生 1 條 `kind === "assistant"`、`text` 含「我先查看 issue 內容。」的 entry。
2. **信封 user + tool_result**：user 信封事件 content 為
   `[{type:"tool_result","tool_use_id":"t1","content":"ok"}]`，且前面有過
   tool_use（id `t1`, name `Bash`）→ 期望 `tool_result` entry 的 label 為
   `tool_result · Bash`。
3. **信封 assistant + tool_use**：content 為
   `[{type:"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]`
   → `tool_use` entry，label `tool_use · Bash`，text 含 `ls`。
4. **扁平 legacy 形狀仍工作**：`{"message":{"type":"assistant","content":[{"type":"text","text":"legacy"}]}}`
   → assistant entry（驗證 `?? msg.content` 兜底沒被破壞）。
5. **stream_event delta 聚合**：`message_start`(id msg_1) → 兩條 `content_block_delta`
   （text_delta "你好" / text_delta "世界"）→ `message_stop` → 恰好 1 條 assistant
   entry，text 為「你好世界」（驗證按 message 聚合、不是一 delta 一條）。
6. **result 事件**：`{"message":{"type":"result"}}` → 1 條 `result` entry，text `turn finished`。
7. **error 事件**：`{"message":{"type":"system","error":"boom"}}` → `error` entry。
8. **turnOfEventFile**：`runtime-events.jsonl` → 1；`runtime-events-turn3.jsonl` → 3；
   `notes.md` → `Number.POSITIVE_INFINITY`。
9. **parseRuntimeEvents 容錯**：混入一行非法 JSON 被跳過；超過 `MAX_PARSE_LINES` 時只解析尾部
   （可構造 5001 行，首行放一個標記事件，斷言標記事件**不**在結果裡）。

### 2.3 接線

- `packages/client/tsconfig.test.json` 的 `include` 加入：
  `src/components/RunStreamOutput.shared.ts`、`src/components/RunStreamOutput.tsx`、
  `src/components/RunStreamOutput.test.ts`。
  注意 `RunStreamOutput.tsx` 會帶入 `../api/loops` 和 `../hooks/useSessionStream`
  的類型依賴——如果 tsc 報找不到模塊，把它們的類型依賴一併加入 include，
  或只在測試裡 import shared 文件、include 裡不放組件本體（**優先後者，更簡單**：
  include 只加 shared.ts + test.ts）。
- `packages/client/package.json` 的 `test` 腳本在鏈中（LoopWorkspaceHint 之後的位置即可）
  插入：`&& node --experimental-specifier-resolution=node .test-dist/components/RunStreamOutput.test.js`。

## 3. 驗證（全綠才算完成）

```bash
pnpm --filter @yep-anywhere/client test    # 含新測試，且首尾清理 .test-dist 正常
pnpm typecheck                             # 根目錄，client 不能引入新錯誤
pnpm lint                                  # biome
```

## 4. 回報

列出：新增/修改文件清單、每個測試用例對應的斷言要點、三條驗證命令的結果。
如果 include 接線選了「只加 shared + test」方案，說明原因（避免組件依賴鏈進測試編譯）。
