# Loop 多層死循環防護機制（面試導向）

## 為什麼值得講

AI Agent loop 最常見的生產事故之一，是模型在同一個問題上反覆重試，燒掉大量 token、時間與人工注意力。只靠 prompt 說「不要重複」不可靠，因為 LLM 輸出不穩定；只靠 max_turns 又太粗糙，因為會把「合理但慢的長任務」也砍掉。

本專案的做法是：把「死循環 / 空轉 / 重複阻塞」變成可偵測、可審計、有確定性規則的狀態，而不是依賴模型自覺。

## 一、核心機制

### 1. Blocker fingerprint hash

控制面會把一次 `needs_human` / retry 決策的穩定特徵算成 hash：

- judgment 的 `next_action`
- `unresolved_risks`
- `evidence`
- policy escalation 的 action / reason

同一個 hash 代表「同一類阻斷原因」。如果同一 blocker 連續出現超過門檻，run 會被強制 `failed`，避免人類無限次 approve 同一個死結。

相關實作：

- `packages/server/src/loop/control-plane/blocker.ts`
- `packages/server/src/loop/control-plane/control-plane.ts`

### 2. Similar output hash

每輪 final text 先正規化，再去掉時間戳、UUID、hex id 等易變 token，再算 hash。連續多輪輸出 hash 完全相同時，判斷為「agent 在重複同一份報告 / 空轉」，升級 `needs_human`。

相關實作：

- `packages/server/src/loop/run/turn-execution.ts`
- `packages/server/src/loop/run/turn-loop.ts`

### 3. Diff progress hash

retry 場景不只檢查文字，也檢查工作區是否真的有進展。每輪 `git diff --stat` 會算 hash；如果連續多輪 diff 沒有變化，代表 agent 說「繼續修」但實際沒改東西，升級 `needs_human`。

相關實作：

- `packages/server/src/loop/run/turn-loop.ts`

### 4. Budget / stop rules 硬上限

最後一層是確定性硬限制：

- `max_turns`
- `max_retries`
- `max_time_minutes`
- `stop_on_repeated_failure`

即使前面的啟發式都沒抓到，預算耗盡也會把 run 停在 `budget_limited` 或 `failed`，不會無限跑下去。

## 二、面試答法

推薦回答結構：

1. 先說問題：LLM loop 不能依賴 prompt 避免死循環。
2. 再講層次：
   - blocker hash：識別「同一種阻塞原因重複出現」
   - output hash：識別「同一份文字重複產出」
   - diff hash：識別「沒有實際工作區進展」
   - budget / stop rule：最終硬上限
3. 強調 fail-closed：
   - 不確定時升級 `needs_human`，而不是繼續自動重試
   - 同一 blocker 重複到門檻時強制 `failed`
4. 強調可審計：
   - fingerprint、重複次數、stagnation report 都會落盤
   - 每個決策都有 decision ledger entry

## 三、舉例

UI 顯示：

```text
Technical metadata
blocker: blocker:82ea396ced6e07b2 (1)
```

意思是：

- `82ea396ced6e07b2` 是這次阻塞原因的穩定 hash。
- `(1)` 是目前該 blocker 出現次數。
- 如果變成 `(3)`，且達到 `repeatedBlockerThreshold`，run 會被強制 `failed`，避免死循環。

## 四、為什麼這是優點

- **確定性**：hash + 門檻是純計算規則，不是模型自評。
- **可審計**：每一次阻塞、重複、停滯都有 artifact / ledger。
- **fail-closed**：拿不準就往 `needs_human`，不為了自動化而自動化。
- **分層防禦**：文字重複、無 diff、同 blocker、預算耗盡，各有獨立偵測。
- **可解釋**：`Technical metadata` 顯示的 hash 雖然不是人話，但配合 `human_reasons` 與 judgment report 就能定位根因。

## 五、缺點 / 待改進

- hash 只能發現「重複」，不能解釋「為什麼」；需要 human reason 與 verifier report 配合。
- 目前偵測以 turn 粒度為主，缺少更細的 token/成本執行中熔斷。
- `direct` workspace 模式沒有自動回滾；死循環即使被偵測，也需要人工處理殘留改動。

## 延伸閱讀

- `docs/loop-engineering-java-interview-guide.md`
- `docs/ai-agent-interview-questions.md`
