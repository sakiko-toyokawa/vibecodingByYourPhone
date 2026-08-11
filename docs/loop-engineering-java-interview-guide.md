# Loop Engineering 實戰學習指南：從狀態機到審計的完整工程化思想

> 目標讀者：能寫出功能代碼，但對「工程化」還沒形成體系的開發者；或準備面試、需要把項目經驗講清楚的工程師。
>
> 學習目標：讀完後能獨立解釋「為什麼 `packages/server/src/loop/` 裡每一行看起來多餘的程式碼，其實都在處理**出錯、並發、重啟、自欺**這四件事」；並能把這些思想遷移到普通 Java 項目中。
>
> 本指南基於 `E:/projects/loop/docs/學習指南.md`，並結合本專案 `packages/server/src/loop/` 的真實程式碼撰寫。

---

## 目錄

1. [前言：為什麼要學 Loop Engineering](#前言為什麼要學-loop-engineering)
2. [學習地圖與自測](#學習地圖與自測)
3. [第一部分：基礎篇](#第一部分基礎篇)
   - 第 1 章：Loop Engineering 是什麼
   - 第 2 章：九層閉環總覽
4. [第二部分：核心工程化思想](#第二部分核心工程化思想)
   - 第 3 章：狀態機——loop 的骨架
   - 第 4 章：冪等與事實源——同一事件只發生一次
   - 第 5 章：Fail-closed——故障時倒向更安全的一側
   - 第 6 章：審計與證據——讓一切可回放
   - 第 7 章：測試哲學——什麼叫「真的測到了」
5. [第三部分：實戰與 bug](#第三部分實戰與-bug)
   - 第 8 章：十二個我們踩過的坑
   - 第 9 章：讀代碼路線圖
6. [第四部分：對照與思想](#第四部分對照與思想)
   - 第 10 章：Loop 思想在普通 Java 項目中的對應
   - 第 11 章：計算機思想總結
7. [第五部分：面試篇](#第五部分面試篇)
   - 第 12 章：核心面試題與詳細答案
   - 第 13 章：場景設計題
8. [附錄：術語表與延伸閱讀](#附錄術語表與延伸閱讀)

---

## 前言：為什麼要學 Loop Engineering

### 一個常見的誤解

很多人第一次聽到 Loop Engineering，會以為它就是「把 prompt 寫長一點」或者「讓 AI 多輪對話」。這是錯的。

Loop Engineering 不是優化一次會話的輸出品質，而是建立一個**可長期運行的外層控制系統**。它要回答的問題是：

- 這個任務什麼時候該啟動？
- 啟動後怎麼知道它有沒有在正確的軌道上？
- 如果它跑偏了，是該重試、暫停、升級人工，還是停止？
- 它做完之後，怎麼驗證結果真的對？
- 失敗了怎麼沉澱成改進，而不是下次再犯？

這些問題沒有一個是「算法難題」，但每一個都會在真實系統中反覆出現。Loop Engineering 的本質，就是把這些「會出事的邊角」用明確的機制管住。

### 本專案的位置

我們的專案 `vibecodingByYourPhone-main` 選擇了一條務實的路線：

- **不從零實現 agent harness**：不自己寫 tool loop、session 管理、上下文壓縮。
- **把 Claude Code / Codex 當成黑箱執行器**：通過 adapter 做原生調用。
- **在外層建立可審計的控制閉環**：合約、裝配、調度、驗證、狀態機、預算、學習、發布控制。

這意味著我們的獨特重點不是「更聰明的 agent」，而是「把現有 agent runtime 包進一個可長期運行、可恢復、可驗證、可演化的控制閉環」。

### 工程化的四句話

本指南會反覆出現一個核心觀點：

> **工程化不是「寫更多代碼」，是讓系統在出錯、並發、重啟、自欺四種情況下仍然可預期。**

這個項目裡每一行「看起來多餘的代碼」，背後都是這四種情況之一。

---

## 學習地圖與自測

### 建議閱讀順序

| 順序 | 章節 | 重點 |
|---|---|---|
| 1 | 前言 + 學習地圖 | 建立整體認知 |
| 2 | 第 1-2 章 | 理解 Loop Engineering 是什麼、九層閉環 |
| 3 | 第 3-7 章 | 掌握五大核心工程化思想 |
| 4 | 第 8-9 章 | 通過真實 bug 和讀代碼路線圖鞏固 |
| 5 | 第 10-11 章 | 把思想遷移到 Java 項目和計算機原理層面 |
| 6 | 第 12-13 章 | 用面試題和場景題自測 |

### 前置自測

在開始之前，先判斷你對每章應該花多少時間：

| 問題 | 會 | 不會 |
|---|---|---|
| 能解釋 loop（外層控制閉環）和單次 prompt 的區別 | ☐ | ☐ |
| 能說出「為什麼狀態要畫狀態機而不是堆 boolean」 | ☐ | ☐ |
| 能解釋冪等鍵為什麼要有「時效」 | ☐ | ☐ |
| 能說出 append-only 賬本為什麼要「容錯加載 + 原子寫」 | ☐ | ☐ |
| 能解釋 fail-closed 和「盡力而為」的區別，並舉一例 | ☐ | ☐ |
| 知道 bypass 自批准為什麼必須逐條落賬 | ☐ | ☐ |
| 能判斷一個測試是「真的測到了」還是「在演戲」 | ☐ | ☐ |
| 能說出「殼子」的四個信號 | ☐ | ☐ |

- 第 1、2 列全勾：可以直接跳到第 8-13 章。
- 有任意一個不會：建議從第 1 章順序讀，不要跳。

---

## 第一部分：基礎篇

### 第 1 章 Loop Engineering 是什麼

#### 1.1 一句話定義

> Loop Engineering 關注的是一個**可長期運行的 Agent 控制系統**，而不是優化一次 prompt 或一次 session。

它把 Claude Code / Codex 這類現成 coding agent runtime 視為可調度的**黑箱執行器**；Loop Engineering 負責外層長期控制系統，而不是重新實現 agent harness，也不接管 runtime 內部 agent loop。

#### 1.2 Loop 與單次 Prompt 的本質區別

| 維度 | 單次 Prompt | Loop Engineering |
|---|---|---|
| 時間範圍 | 一次會話 | 長期運行，可能跨小時、跨天、跨重啟 |
| 狀態管理 | 依賴模型上下文 | 外層狀態機 + 賬本 |
| 停止條件 | 用戶主動結束或模型自然停止 | 顯式合約：budget、stop_rules |
| 驗證 | 模型自評 | 獨立 verifier + 證據 |
| 失敗處理 | 重新發一個 prompt | 重試、暫停、升級、學習 |
| 權限 | 由 runtime 決定 | 外層 policy + 人工閘門 |

#### 1.3 Loop 與 Subagent 的區別

這是面試裡非常愛問的點。

- **Subagent 是執行角色**：用來拆分任務或做專門化執行，運行在 runtime 內部。
- **Loop 是執行外部的控制系統**：負責狀態與停止條件、預算與重試、工具與工作區邊界、人工閘門與 bypass 語義、狀態賬本與可驗證學習。

Subagent 可以運行在 loop 內（例如做獨立 reviewer），但**不能替代 loop**：它沒有自己的預算、狀態機和賬本。

#### 1.4 核心生命週期

一個 loop 的典型生命週期可以概括為：

```text
觸發 Trigger
  -> 意圖合約 Intent Contract
  -> Runtime 輸入裝配 Runtime Input Assembly
  -> Agent Runtime Adapter
  -> 執行 Execute
  -> 觀測 Observe
  -> 驗證 Verify
  -> 決策 Decision
  -> 學習 Learn
```

每一個箭頭都是一次「邊界」——數據從一個模塊流向另一個模塊，必須有明確的契約和檢驗。

---

### 第 2 章 九層閉環總覽

本專案的 Loop Engineering 可以拆成九層。每一層負責閉環中的一段，層與層之間通過明確的契約銜接。

```text
+--------------------------------------------------+
| 1. Trigger（觸發）                                |
|    決定 loop 什麼時候醒來，保證同一定時點只點一次火 |
+--------------------------------------------------+
| 2. Intent Contract（意圖合約）                    |
|    把自然語言請求收斂成可驗證、可終止、有邊界的合約 |
+--------------------------------------------------+
| 3. Assembly（輸入裝配）                           |
|    把合約翻譯成 runtime 的原生調用參數             |
+--------------------------------------------------+
| 4. Runtime Adapter（執行底座）                    |
|    把黑箱 runtime 當執行器調用，如實記錄能力邊界   |
+--------------------------------------------------+
| 5. Observability（觀測）                          |
|    給每一輪執行留可追溯的痕跡                      |
+--------------------------------------------------+
| 6. Verification（驗證）                           |
|    不看 executor 怎麼說，看證據怎麼說              |
+--------------------------------------------------+
| 7. Control Plane（控制面）                        |
|    run 的狀態機、預算、停止規則、人工閘門的唯一入口 |
+--------------------------------------------------+
| 8. Policy（策略）                                 |
|    決定哪些動作能自批准、哪些必須升級人工          |
+--------------------------------------------------+
| 9. Learning / Eval（學習與評測）                  |
|    把「失敗」沉澱成「改進」，但改進必須過驗證管線 |
+--------------------------------------------------+
```

#### 2.1 各層權威文件與實現

| 層 | 權威文件 | 本專案實現 |
|---|---|---|
| 1 Trigger | `loop-engineering/trigger/觸發模塊.md` | `packages/server/src/loop/trigger/cron-scheduler.ts` |
| 2 Contract | `loop-engineering/intent-contract/意圖合約.md` | `packages/server/src/loop/contract/intent-contract.ts` |
| 3 Assembly | `loop-engineering/runtime-input/Runtime輸入裝配.md` | `packages/server/src/loop/assembly/runtime-input.ts` |
| 4 Adapter | `loop-engineering/agent-runtime-adapter/` | `packages/server/src/sdk/providers/claude.ts`、`codex.ts` |
| 5 Observability | `loop-engineering/observability/` | `packages/server/src/watcher/EventBus.ts` |
| 6 Verification | `loop-engineering/verification-policy/` | `packages/server/src/loop/verification/` |
| 7 Control Plane | `loop-engineering/control-plane/` | `packages/server/src/loop/control-plane/` |
| 8 Policy | `loop-engineering/policy-engine/` | `packages/server/src/loop/policy/` |
| 9 Learning | `loop-engineering/loop-state-and-learning/` | `packages/server/src/loop/learning/` |

#### 2.2 為什麼要拆成九層

拆成九層不是為了「看起來高級」，而是為了讓每一層有單一的回答對象：

- Trigger 只回答「什麼時候啟動」。
- Contract 只回答「要做什麼、做到什麼程度」。
- Assembly 只回答「怎麼把合約翻譯成 runtime 能懂的輸入」。
- Adapter 只回答「怎麼調用 runtime」。
- Verification 只回答「結果對不對」。
- Control Plane 只回答「接下來走哪條路」。
- Policy 只回答「這個動作能不能做」。
- Learning 只回答「怎麼從失敗中改進」。

當兩層混在一起的時候，bug 就會變得難以定位。例如：

- 如果把「能不能做」和「接下來走哪條路」混在一起，安全邏輯就會混進狀態機，難以審計。
- 如果把「結果對不對」和「怎麼改進」混在一起，eval 就會變成「自我證明」。

---

## 第二部分：核心工程化思想

### 第 3 章 狀態機——loop 的骨架

#### 3.1 概念一句話

> 狀態機 = 明確列出「系統有哪些狀態、什麼條件下允許從哪裡到哪裡」，除此之外的轉移一律拒絕。

#### 3.2 為什麼不能堆 boolean

初學者寫狀態，最容易寫成：

```ts
let isRunning = false;
let isPaused = false;
let isDone = false;
let isFailed = false;
let needsHuman = false;
```

三個問題隨之而來：

1. **組合爆炸**：`isPaused=true && isDone=true` 是什麼狀態？
2. **轉移不受控**：任何地方都能改標誌。
3. **無法回答「怎麼到這兒的」**：你只知道現在的組合，不知道歷史路徑。

在 Loop 這種長期運行系統裡，第三個問題尤其致命。一個 run 可能經歷 `active → retry → active → needs_human → active → complete`，如果沒有狀態機，你根本無法回放這個過程。

#### 3.3 本專案怎麼做

本專案的答案是 `packages/server/src/loop/control-plane/state-machine.ts`。

```ts
export const RUN_STATE_TRANSITIONS: Readonly<
  Record<RunState, readonly RunState[]>
> = {
  active: [
    "complete",
    "retry",
    "needs_human",
    "paused",
    "failed",
    "budget_limited",
  ],
  retry: ["active"],
  needs_human: ["active", "failed", "paused"],
  paused: ["active"],
  budget_limited: ["active"],
  complete: [],
  failed: [],
};
```

7 個枚舉狀態 + 一張顯式轉移表 + **所有狀態變更必須過單一 `transition()` 入口**（`control-plane.ts`）。非法轉移不是「忽略」，是拋 `IllegalTransitionError`。

```ts
export function assertLegalTransition(
  from: RunState,
  to: RunState,
  context: { runId: string; turn: number },
): void {
  if (!isLegalTransition(from, to)) {
    console.error(
      `[ControlPlane] illegal transition rejected: run=${context.runId} turn=${context.turn} ${from} -> ${to}`,
    );
    throw new IllegalTransitionError(from, to, context);
  }
}
```

為什麼要拋錯而不是忽略？因為**非法轉移本身就是 bug 信號**，吞掉它等於藏 bug。

#### 3.4 狀態機與決策表的協作

狀態機只負責「能不能轉」；具體「該轉到哪裡」由決策表決定。`packages/server/src/loop/control-plane/decide.ts` 就是這張決策表：

```ts
export function decideControl(ctx: ControlDecisionContext): ControlDecision {
  if (!ctx.executionOk) {
    return { kind: "failed", reason: "execution failed; ..." };
  }

  if (!ctx.verificationRan || !ctx.judgment) {
    return { kind: "complete", reason: "card requires no verification phases" };
  }

  const judgment = ctx.judgment;
  if (judgment.requires_human) {
    return { kind: "needs_human", reason: "a verifier requires human review" };
  }

  if (judgment.overall === "passed") {
    return { kind: "complete", reason: "judgment overall == passed" };
  }

  if (judgment.overall === "failed" && judgment.retryable) {
    if (ctx.canRetry) {
      return { kind: "retry", reason: "budget has headroom for another turn" };
    }
    return { kind: "budget_limited", reason: "budget is exhausted" };
  }

  return { kind: "needs_human", reason: "not automatically retryable" };
}
```

這張表對應 `02-schema契約.md §7` 的遷移表：

| execution | verification / judgment | decision |
|---|---|---|
| failed | (any) | failed |
| ok | not run | complete |
| ok | passed && !requires_human | complete |
| ok | requires_human | needs_human |
| ok | failed && retryable && budget 有餘量 | retry |
| ok | failed && retryable && budget 耗盡 | budget_limited |
| ok | failed && !retryable / inconclusive / escalate | needs_human |

注意兩個關鍵原則：

1. **requires_human 永遠不被通過結論覆蓋**：人工透傳優先級最高。
2. **retryable failure 但預算耗盡 → budget_limited 而不是 needs_human**：因為這是一條定義良好的自動路徑，只是沒錢了。

#### 3.5 真實 bug：complete → complete

這是 `control-plane.ts` 裡一個真實發生過的 bug。

`applyJudgment` 裡原來寫的是：

```ts
state: existing?.state ?? "active"
```

問題在哪？

- 狀態文件按 **loop** 儲存，不是按 **run** 儲存。
- 第一個 run 完成後，文件裡是 `complete`。
- 第二個 run 開始，第一次判定時讀到這個文件，from-state 直接繼承了 `complete`。
- 轉移表拒絕 `complete → complete`，run 拋異常死掉。
- 但文件裡還躺著上個 run 的 `complete`，介面上看起來像成功了。

修復後：

```ts
const isSameRun = existing?.run_id === input.runId;
const fromState: RunState = isSameRun ? existing.state : "active";
```

只有 `existing.run_id === input.runId` 時才沿用舊狀態和預算快照，否則從 `active` 和合约預算重新起算。

**教訓**：持久化狀態的測試必須覆蓋「這個文件被別人寫過」的路徑。單測每個 case 都用乾淨狀態文件，所以全綠也漏；真實環境第二輪必現。

#### 3.6 普通 Java 項目對應

| Loop 專案 | 普通 Java 專案 |
|---|---|
| `RunState` 枚舉 | `OrderStatus` / `TaskStatus` / `WorkflowStatus` 枚舉 |
| `RUN_STATE_TRANSITIONS` 轉移表 | Spring State Machine、Cola StateMachine，或自己寫的 `Transition` 表 |
| `assertLegalTransition` | Service 層統一校驗，不允許 DAO 直接 setStatus |
| 按 loop 儲存 run_state | 按業務實體儲存最新狀態，但要注意「這個狀態屬於哪一次流程實例」 |

**Java 範例：訂單狀態機**

```java
public enum OrderStatus {
    CREATED, PAID, SHIPPED, COMPLETED, CANCELLED
}

public class OrderStateMachine {
    private static final Map<OrderStatus, Set<OrderStatus>> TRANSITIONS = Map.of(
        CREATED, Set.of(PAID, CANCELLED),
        PAID, Set.of(SHIPPED, CANCELLED),
        SHIPPED, Set.of(COMPLETED),
        COMPLETED, Set.of(),
        CANCELLED, Set.of()
    );

    public static void assertLegal(OrderStatus from, OrderStatus to) {
        if (!TRANSITIONS.getOrDefault(from, Set.of()).contains(to)) {
            throw new IllegalStateTransitionException(
                String.format("Illegal transition: %s -> %s", from, to)
            );
        }
    }
}
```

```java
@Service
public class OrderService {
    @Autowired
    private OrderRepository orderRepository;

    public void payOrder(Long orderId) {
        Order order = orderRepository.findById(orderId)
            .orElseThrow(() -> new OrderNotFoundException(orderId));

        // 狀態變更必須經過狀態機
        OrderStateMachine.assertLegal(order.getStatus(), OrderStatus.PAID);

        order.setStatus(OrderStatus.PAID);
        order.setPaidAt(Instant.now());
        orderRepository.save(order);
    }
}
```

關鍵點：**不要把狀態欄位暴露成 public setter**，所有狀態變更必須經過狀態機。

#### 3.7 計算機思想

- **有限狀態自動機（Finite State Automaton）**：程式 = 狀態 + 事件 + 轉移函數。把隱含狀態顯式化，複雜度從「任意組合」降到「有向圖」。
- **防禦式程式設計（Defensive Programming）**：非法輸入不是忽略，而是明確拒絕並留下日誌。
- **單一入口原則（Single Entry Point）**：所有狀態變更走同一條路，方便審計、加鎖、加鉤子。
- **歸屬校驗（Ownership Validation）**：持久化狀態必須能回答「這屬於誰」。

#### 3.8 面試題與答案

**Q1：為什麼不能用一堆 boolean 表示狀態？**

A：三個問題。第一，組合爆炸，`isPaused=true && isDone=true` 這種狀態語義不明；第二，轉移不受控，任何地方都能改標誌，容易出現非法組合；第三，無法追溯歷史路徑。狀態機用枚舉 + 轉移表把隱含狀態顯式化，非法轉移直接拋錯，避免「看起來合法、實際不可能」的狀態組合。

**Q2：本專案中 `complete → complete` 的 bug 根因是什麼？**

A：狀態文件按 loop 儲存，但 code 沒有校驗 `run_id` 歸屬。第一個 run 完成後文件裡是 complete；第二個 run 讀到上個 run 的 complete 狀態，轉移表拒絕後拋異常。但 UI 仍顯示舊狀態，造成「run 死掉但看起來成功」的幻象。修復後只有 `existing.run_id === input.runId` 才沿用舊狀態。

**Q3：Java 裡怎麼防止 DAO 層直接改狀態？**

A：狀態欄位不暴露 public setter；DAO 只負責持久化；Service 層統一調用狀態機；非法轉移拋業務異常並記錄。更嚴格的話，可以在實體裡把 setter 設為包級私有，並通過狀態機方法來改變狀態。

**Q4：`decideControl` 裡為什麼 requires_human 不被 passed 覆蓋？**

A：這是「人工透傳優先級最高」原則。即使 verifier 判 overall passed，但只要某個 verifier 標記 requires_human，就說明存在無法自動判斷的風險，必須升級人工。這是 fail-closed 在狀態決策中的體現。

---

### 第 4 章 冪等與事實源——同一事件只發生一次

#### 4.1 概念一句話

> 冪等 = 同一操作執行 N 次和執行 1 次效果相同；要做到它，你需要一個能跨重試 / 重啟記住「做過了」的鍵。

#### 4.2 冪等鍵三要素

1. **確定性生成**：同樣的邏輯事件必得同樣的鍵。
2. **可持久化**：只放記憶體的冪等鍵，進程重啟即失效。
3. **有明確時效**：鍵不能無限累積。

第三點最容易被忽視。一個好的冪等鍵應該「自帶壽命」，這樣就不需要額外的清理邏輯。

#### 4.3 本專案怎麼做

**cron 點火冪等鍵**

`packages/server/src/loop/trigger/cron-scheduler.ts`：

```ts
export function minuteStamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function cronDedupeKey(loopId: string, date: Date): string {
  return `${loopId}:${minuteStamp(date)}`;
}
```

同一定時點必然得到同一個鍵。點火鍵持久化到 `loops/trigger/cron-fired.json`：

```ts
private async loadFired(now: Date): Promise<void> {
  const currentStamp = minuteStamp(now);
  try {
    const content = await fs.readFile(this.firedFile, "utf-8");
    const parsed = JSON.parse(content) as { keys?: unknown };
    if (Array.isArray(parsed.keys)) {
      for (const key of parsed.keys) {
        // 鍵的時效就是它的分鐘戳：只保留本分钟的鍵，歷史鍵自然淘汰
        if (typeof key === "string" && key.endsWith(`:${currentStamp}`)) {
          this.firedKeys.add(key);
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[CronScheduler] cron-fired.json 損壞，按空集起步:", error);
    }
  }
}
```

進程重啟後載入本分钟的鍵，歷史鍵自然淘汰。**好鍵自帶壽命**。

**決策賬本冪等鍵**

`packages/server/src/loop/control-plane/control-plane.ts`：

```ts
decision_id: `decision-${deps.runId}-t${deps.turn}-${kind}-${auditSeq}`
```

同一個判定重放（比如消息重發）撞上已有條目就不追加、不重存、不重廣播——**重放安全**。

#### 4.4 事實源：為什麼用文件不用資料庫

Yep Anywhere 有意零外部依賴，loop 的全部狀態落在 `~/.yep-anywhere/loops/` 的文件裡。沒有資料庫的事務保護，就要自己回答三個問題：

**問題一：寫一半崩了怎麼辦？**

先寫 `.tmp` 再 `rename` 原子替換——讀者永遠看不到半份文件。`run-ledger-store.ts` 和 `failure-pattern-store.ts` 都是這麼做的。

```ts
async writeArtifact(runId: string, name: string, content: string): Promise<void> {
  const filePath = path.join(dir, name);
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, filePath);
}
```

**問題二：讀到一個壞文件怎麼辦？**

容錯加載：備份成 `.corrupt-<時間戳>` 後從空開始，服務不崩、壞內容不丟（可追查）。追加寫的 jsonl 則是「壞行跳過 + 警告」，一行壞不拖死整個文件。

```ts
for (const line of content.split("\n")) {
  try {
    parsed = JSON.parse(line);
  } catch {
    console.warn(`[RunLedgerStore] skipping unparseable line in runs/${runId}.jsonl`);
    continue;
  }
  // ...
}
```

**問題三：並發寫怎麼辦？**

單寫者約定：每種文件只有一個寫者（`04-存儲約定.md` 單寫者表），進程內經 DI 容器共享同一個 store 實例；追加寫用 per-file promise 鏈串行化。

```ts
private appendChains = new Map<string, Promise<void>>();

private enqueueAppend(runId: string, line: string): Promise<void> {
  const filePath = path.join(this.runsDir, `${runId}.jsonl`);
  const previous = this.appendChains.get(runId) ?? Promise.resolve();
  const next = previous.then(async () => {
    await fs.mkdir(this.runsDir, { recursive: true });
    await fs.appendFile(filePath, line, "utf-8");
  });
  this.appendChains.set(runId, next.catch(...));
  return next;
}
```

注意一個容易忽視的點：**「容錯」不是「當不存在」**。本專案早期版本壞文件直接當空處理，修復後先備份再起步——靜默吞掉錯誤和優雅降級的區別，就在於有沒有留下可查的痕跡。

#### 4.5 普通 Java 項目對應

| Loop 專案 | 普通 Java 專案 |
|---|---|
| `cronDedupeKey` | 消息隊列消費時的 `messageId` / `bizId` |
| `loops/trigger/cron-fired.json` | Redis `SET idempotency_key NX EX 86400` 或資料庫冪等表 |
| `decision_id` | 業務單號、訂單號、請求流水號 |
| `tmp + rename` 原子寫 | 資料庫事務、樂觀鎖、CAS |
| 壞行跳過 + 警告 | 資料庫冪等表主鍵衝突時忽略或返回已處理結果 |

**Java 範例一：支付回調冪等處理**

```java
@Service
public class PaymentCallbackService {
    @Autowired
    private IdempotencyKeyRepository idempotencyRepository;
    @Autowired
    private OrderService orderService;

    @Transactional
    public void handleCallback(String outTradeNo, String status) {
        // 冪等鍵：業務單號本身就帶唯一性
        String idempotencyKey = "PAYMENT_CALLBACK:" + outTradeNo;

        // 利用唯一索引防重
        try {
            idempotencyRepository.insertIgnore(idempotencyKey, Duration.ofHours(24));
        } catch (DuplicateKeyException e) {
            log.warn("重複回調，忽略: {}", outTradeNo);
            return;
        }

        orderService.paid(outTradeNo, status);
    }
}
```

冪等鍵 `outTradeNo` 本身就帶時效：訂單完成後回調窗口關閉，歷史鍵可以歸檔清理。

**Java 範例二：消息隊列消費冪等**

```java
@Component
public class OrderEventListener {
    @Autowired
    private IdempotencyService idempotencyService;

    @KafkaListener(topics = "order-events")
    public void onMessage(ConsumerRecord<String, String> record) {
        String messageId = record.headers().lastHeader("messageId").value();

        // Redis NX + EX：冪等且帶時效
        Boolean isNew = redisTemplate.opsForValue()
            .setIfAbsent("idempotency:" + messageId, "1", Duration.ofMinutes(10));

        if (Boolean.FALSE.equals(isNew)) {
            log.warn("重複消息，忽略: {}", messageId);
            return;
        }

        processEvent(record.value());
    }
}
```

#### 4.6 計算機思想

- **冪等性（Idempotency）**：分散式系統三大難題之一（冪等、有序、一致）的基礎解法。
- **事實源（Source of Truth）**：只有一個權威地方記錄「發生了什麼」，其他都是投影或副本。
- **原子性（Atomicity）**：`tmp + rename` 對應資料庫事務；壞檔案備份對應日誌備份與回放。
- **容錯降級（Graceful Degradation）**：壞文件不讓服務掛掉，但必須留下可追溯的痕跡。
- **單寫者（Single Writer）**：通過約定而非鎖來避免並發寫衝突。

#### 4.7 面試題與答案

**Q1：冪等鍵為什麼要持久化？**

A：只放記憶體的冪等鍵在進程重啟後會丟失，同一分鐘 / 同一條消息會被重複處理。本專案的 cron 點火鍵原來只在記憶體 Set 裡，重啟後同一分鐘會重複點火；修復後持久化到 `cron-fired.json`，進程邊界才得以守住。

**Q2：冪等鍵為什麼要帶時效？**

A：無限累積會造成儲存爆炸和查詢變慢。好的冪等鍵自帶壽命，例如 cron 鍵只保留本分钟，支付回調鍵在訂單終態後可清理。本專案的 cron 鍵利用分鐘戳自然淘汰，不需要額外清理任務。

**Q3：Java 專案裡，冪等表和業務表是分開還是合一起？**

A：小系統可以合一起（業務單號帶唯一索引）；大系統建議分開，冪等表專門做「請求級去重」，業務表做「狀態級去重」，職責更清晰，也方便按時效清理。關鍵是冪等表要有獨立的過期策略，不能無限增長。

**Q4：文件儲存怎麼保證原子寫？**

A：先寫臨時文件，再 `rename` 替換目標文件。現代文件系統的 `rename` 在同一文件系統內通常是原子的，讀者永遠看不到半份文件。這對應資料庫事務中的「提交」動作。

**Q5：壞文件應該直接刪除還是備份後重啟？**

A：應該備份後重啟。直接刪除等於靜默吞掉錯誤，事後無法追查；備份成 `.corrupt-<時間戳>` 後從空開始，既保證服務不掛，又保留證據。這是「容錯」和「掩蓋錯誤」的區別。

---

### 第 5 章 Fail-closed——故障時倒向更安全的一側

#### 5.1 概念一句話

> Fail-closed = 出故障時默認倒向更嚴格、更安全的一側；fail-open（盡力而為）則倒向更寬鬆的一側。安全相關的系統只能選前者。

#### 5.2 一個實用的判斷口訣

> **這個故障發生後，用戶是「被多攔了一次」還是「被少攔了一次」？** 多攔（false positive）煩人但安全；少攔（false negative）安靜但致命。工程化選前者。

#### 5.3 本專案的三個教科書級實例

**實例一：驗證層崩潰 → 升級人工**

修復前，`verifyRun` 拋異常只打日誌，run 繼續走 complete——驗證系統自己的故障恰好繞過了驗證本身。這叫 **verifier theater**，驗證演戲。

修復後（`run-service.ts` catch 分支）：合成一份 `inconclusive + requires_human` 的 judgment 交給狀態機，run 升級 `needs_human`，錯誤落 artifact 當證據。

> **判不清的時候，給機器不如給人。**

**實例二：Codex 策略架空 → 裝配層拒絕**

調查發現 Codex 橋把 `bypassPermissions` 映射成「永不審批 + 全權限沙盒」，策略引擎在 codex 鏈路上一個鉤子都不會觸發——聲明了 policy 的 run 跑上去等於裸奔，而且沒有任何告警。

正確做法不是「盡力而為跑起來」，而是裝配層直接拋錯拒絕（`06-項目規定.md #24`）。後來 codex 橋真接線了（`06-項目規定.md #39`），守衛才按口徑放開。

> **安全機制靜默失效，比沒有這個機制更糟**——沒有機制時你知道自己裸奔，靜默失效時你以為穿了盔甲。

**實例三：bypass 自批准審計失敗 → 拒絕調用**

`packages/server/src/loop/policy/approval-hook.ts`：

```ts
case "allow":
  try {
    await appendAudit(verdict, toolName, "bypass_used");
  } catch (error) {
    // Fail-closed: bypass 的自批准以可審計為前提
    console.error(
      `[policy] audit append failed for run ${deps.runId}; denying ${toolName} (fail-closed):`,
      error,
    );
    recordEvent(verdict, toolName, "denied");
    return {
      behavior: "deny",
      message: "policy audit ledger write failed; self-approval is not allowed without audit (fail-closed)",
    };
  }
  recordEvent(verdict, toolName, "bypass_used");
  return { behavior: "allow" };
```

bypass 的核心承諾是「本地、可回滾、可審計」。無法落賬的自批准不成立。

#### 5.4 另一個例子：eval 集損壞 → 回滾

發布管線的 regression 檔要復跑 eval 集當閘門。eval 文件壞了怎麼辦？跳過驗證放行是最錯的答案。實現是 fail-closed 回滾：尺子丟了，這批貨一律不發（`learning/pipeline.ts`）。

#### 5.5 普通 Java 項目對應

| Loop 專案 | 普通 Java 專案 |
|---|---|
| 驗證層崩潰 → needs_human | 風控規則引擎掛了 → 交易掛起人工審核 |
| Codex 策略架空 → 拒絕 | 權限系統沒接好 → 接口直接拋 403，不允許降級 |
| bypass 審計失敗 → deny | 審計日誌寫失敗 → 敏感操作不允許執行 |
| eval 集損壞 → 回滾 | CI 閘門腳本壞了 → 禁止發布 |

**Java 範例：銀行轉帳風控兜底**

```java
@Service
public class TransferService {
    @Autowired
    private RiskEngineClient riskEngine;

    public TransferResult transfer(TransferRequest req) {
        try {
            RiskResult risk = riskEngine.evaluate(req);
            if (risk.isBlocked()) {
                return TransferResult.rejected("risk blocked");
            }
        } catch (RiskEngineException e) {
            // 風控引擎故障：fail-closed，不允許放行
            log.error("風控引擎異常", e);
            return TransferResult.manualReview("risk engine unavailable");
        }

        // ... 執行轉帳
        return TransferResult.success();
    }
}
```

**Java 範例：權限系統降級策略**

```java
@Component
public class PermissionGuard {
    public boolean canAccess(String userId, String resource) {
        try {
            return permissionClient.check(userId, resource);
        } catch (PermissionServiceException e) {
            // 權限服務掛了：fail-closed，不允許訪問
            log.error("權限服務異常，拒絕訪問: user={}, resource={}", userId, resource, e);
            return false;
        }
    }
}
```

#### 5.6 計算機思想

- **故障模式與影響分析（FMEA）**：設計系統時先問「這個組件掛了會怎樣」。
- **默認安全（Secure by Default）**：沒有明確許可 = 拒絕。
- **瑞士奶酪模型（Swiss Cheese Model）**：每層防禦都有孔，fail-closed 讓孔不會對齊成隧道。
- **最少權限原則（Principle of Least Privilege）**：故障時回到權限最小的狀態。

#### 5.7 面試題與答案

**Q1：什麼是 fail-closed？和 fail-open 的區別是什麼？**

A：fail-closed 是故障時倒向更嚴格、更安全的一側；fail-open 是倒向更寬鬆的一側。安全相關系統必須 fail-closed，因為「少攔一次」可能造成資損或數據洩露。判斷口訣：故障後用戶是「被多攔了一次」還是「被少攔了一次」。

**Q2：本專案中 bypass 自批准為什麼審計寫失敗就要拒絕？**

A：bypass 模式的合法性建立在「每一次自批准都可審計」上。如果審計寫不進去還放行，就違反了核心承諾，等於繞過了監督。此時必須 fail-closed 拒絕該調用。

**Q3：Java 專案裡，熔斷和 fail-closed 是什麼關係？**

A：熔斷是「檢測到故障後快速失敗」，fail-closed 是「失敗後的默認方向」。兩者常一起用：熔斷觸發後，後備邏輯要選擇更安全的那個分支，而不是簡單放行。例如 Hystrix fallback 返回「請稍後重試」而不是直接成功。

**Q4：cron 的待觸發隊列是純記憶體的，重啟丟 pending——這算 fail-open 還是 fail-closed？為什麼可接受？**

A：這算 fail-open，但它是**顯式接受的權衡**：`05-分階段計劃.md` 明確「重啟不補跑」，且 `run_active` 仍是並發兜底。它不是安全關鍵路徑，而是調度優化，所以可以接受。關鍵是這個權衡要被文檔記錄，而不是偷偷發生。

**Q5：為「策略審計賬本寫失敗」設計兜底方向。bypass 自批准承諾「可審計」，寫不進賬本時該放行還是拒絕？**

A：必須拒絕。這是 `approval-hook.ts` 現成的答案：bypass 的核心承諾是可審計，審計失敗還放行就是自欺欺人。

---

### 第 6 章 審計與證據——讓一切可回放

#### 6.1 概念一句話

> 審計 = 事後能完整回答「發生了什麼、為什麼」；證據 = 回答時所依賴的、不落進對話上下文的持久材料。

#### 6.2 為什麼要審計

長期運行的系統一定會出問題。出問題後，你需要回答：

- 什麼時候發生的？
- 誰觸發的？
- 系統當時是什麼狀態？
- 為什麼會這樣決策？
- 依據是什麼證據？

如果這些問題答不上來，你就只能猜。而猜，是工程化的大敵。

#### 6.3 本專案的三種賬本

本專案把狀態和學習相關的記錄分成三類賬本：

| 賬本 | 回答什麼問題 | 本專案實現 |
|---|---|---|
| 運行賬本（run ledger） | 「發生了什麼」 | `run-ledger-store.ts` 寫入 `runs/<run_id>.jsonl` |
| 決策賬本（decision ledger） | 「為什麼這麼決定」 | `control-plane.ts` / `approval-hook.ts` 寫入 decision_entry |
| 失敗模式賬本（failure pattern） | 「哪類錯在反覆出現」 | `failure-pattern-store.ts` |

#### 6.4 引用不內嵌

賬本條目裡不塞大文本，只存 `artifact://<run_id>/<file>` 這樣的 URI。證據本體（diff、日誌、報告）落在 `loops/artifacts/<run_id>/` 下，賬本保持輕小可速讀。

`packages/server/src/loop/state/run-ledger-store.ts`：

```ts
async writeArtifact(runId: string, name: string, content: string): Promise<void> {
  const dir = path.join(this.artifactsDir, runId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, filePath);
}
```

讀取方容忍 ENOENT——超過保留期的證據被清理後，引用解析為 missing 而不是報錯。統一解析入口是 `loop/state/uri.ts` 的 `resolveUri`，不許各處手寫路徑拼接（防 `..` 逃逸）。

```ts
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

private assertSafeName(name: string, what: string): void {
  if (!SAFE_NAME.test(name)) {
    throw new Error(
      `[RunLedgerStore] unsafe ${what}: '${name}' (must match ${SAFE_NAME})`,
    );
  }
}
```

#### 6.5 bypass 自批准：為什麼逐條落賬

bypass 模式允許 loop 不經過人工就批准自己的工具調用——它的合法性完全建立在「每一次自批准都可審計」上。

`packages/server/src/loop/policy/approval-hook.ts` 每放行一次，就寫一條 `bypass_used` 決策賬本：

```ts
const entry: DecisionEntry = {
  decision_id: `decision-${deps.runId}-t${deps.turn}-${kind}-${auditSeq}`,
  loop_id: deps.loopId,
  run_id: deps.runId,
  decision: kind,
  reason: `${kind === "bypass_used" ? "bypass self-approval" : "policy hard-gate block"}: tool=${toolName} action=${verdict.classification.action} risk=${verdict.classification.risk} (${verdict.classification.summary}); ${verdict.reason}`,
  evidence_refs: [],
  policy_refs: [policyRef],
  next_action: kind === "policy_blocked" ? "escalated_to_needs_human" : "none",
  created_at: new Date().toISOString(),
};
await deps.store.appendDecisionEntry(deps.runId, entry);
```

這些權限事件還會落成本輪的 `permission-events.json`，作為證據送進驗證輸入（`02-schema契約.md §5`：高風險任務的驗證必須包含權限事件）。

#### 6.6 maker / checker：六類證據怎麼流到驗證層

執行者（maker）和驗證者（checker）是分開的——寫代碼的模型給自己打分太寬。驗證層拿到的輸入包（`VerificationInputBundle`，`02-schema契約.md §5`）在本專案裡每一類證據都有真實來源：

| 證據 | 來源 | 對應 artifact |
|---|---|---|
| diff | turn 結束 `git diff HEAD` | `diff.patch` |
| stdout | result 消息 finalText | `stdout.log` |
| 結構化輸出 | 輪內歸一消息流 | `runtime-events.jsonl` |
| 權限事件 | 策略鉤子裁決 | `permission-events.json` |
| 執行者自述 | prompt 契約 `<<<EXECUTOR-SUMMARY>>>` 標記塊提取 | `executor-summary.md` |
| 已知失敗模式 | 失敗模式賬本 open 模式投影 | `failure-patterns.json` |

產物按輪命名（turn > 1 帶 `-turnN` 後綴）——否則重試輪會把上一輪的證據覆蓋，歷史輪賬本裡的引用就懸空了。

#### 6.7 普通 Java 項目對應

| Loop 專案 | 普通 Java 專案 |
|---|---|
| `run_ledger_entry` + `decision_entry` | 業務操作日誌表 + 審計日誌表 |
| `artifact://` URI | 對象存儲 URL（OSS / S3 / MinIO） |
| `permission-events.json` | 權限變更日誌、數據訪問日誌 |
| maker / checker 分離 | 代碼審查、測試與開發分離、風控與交易分離 |

**Java 範例：電商下單審計**

```java
@Entity
@Table(name = "order_audit_log")
public class OrderAuditLog {
    @Id
    @GeneratedValue
    private Long id;

    private String orderNo;
    private String action;       // CREATE / PAY / SHIP / CANCEL
    private String operator;     // 操作人 or 系統服務
    private String decision;     // 決策結果
    private String reason;       // 決策理由
    private String evidenceUrls; // 證據引用，逗號分隔的 OSS URL
    private Instant createdAt;
}
```

```java
@Service
public class OrderAuditService {
    @Autowired
    private OrderAuditLogRepository auditLogRepository;

    public void logDecision(String orderNo, String action, String decision,
                            String reason, List<String> evidenceUrls) {
        OrderAuditLog log = new OrderAuditLog();
        log.setOrderNo(orderNo);
        log.setAction(action);
        log.setDecision(decision);
        log.setReason(reason);
        log.setEvidenceUrls(String.join(",", evidenceUrls));
        log.setCreatedAt(Instant.now());
        auditLogRepository.save(log);
    }
}
```

關鍵點：**日誌裡不存大對象，只存引用；證據本體放對象存儲，並設保留策略。**

#### 6.8 計算機思想

- **事件溯源（Event Sourcing）**：狀態不是一個字段，而是一串可回放的事件。
- **不可抵賴性（Non-repudiation）**：每條記錄帶時間戳、身份、理由，事後無法否認。
- **引用透明性（Referential Transparency）**：賬本只存引用，證據可以獨立清理、遷移、驗證。
- **審計跟蹤（Audit Trail）**：系統必須留下完整的操作軌跡，這是合規和排障的基礎。

#### 6.9 面試題與答案

**Q1：為什麼賬本「只存引用」而不是把 diff 全文塞進去？**

A：賬本需要輕小可速讀，diff 全文體量大。分離後賬本可快速遍歷，證據本體可獨立管理保留期和清理策略。這是「引用透明性」原則：賬本存的是「指向證據的指針」，而不是證據本身。

**Q2：如果 executor 沒按契約輸出自述標記塊，executor_summary 應該填什麼？**

A：如實填 `null`。自述缺失本身也是信號，不能編造一個「看起來正常」的值。這是工程化裡「如實記錄」原則的體現。

**Q3：Java 專案裡，審計日誌和業務日誌有什麼區別？**

A：業務日誌主要用於排查和監控，格式靈活，保留期短；審計日誌用於合規和取證，要求結構化、不可篡改、長期保留、與業務數據分離存儲。審計日誌通常需要記錄「誰、什麼時候、對什麼、做了什麼、為什麼」。

**Q4：為什麼 bypass 自批准必須逐條落賬？**

A：bypass 模式的合法性完全建立在「每一次自批准都可審計」上。逐條落賬才能保證事後能回放每一次權限決策。如果只記一個總數，出問題時根本無法追溯是哪次調用違規。

---

### 第 7 章 測試哲學——什麼叫「真的測到了」

#### 7.1 概念一句話

> 測試的價值 = 你改錯實現時它會不會變紅；不會變紅的測試是在演戲。

#### 7.2 本專案的測試紀律

本專案的測試有幾個顯著特點：

1. **跑真實的子進程**：verification 的測試真的起 `node -e` 進程看退出碼。
2. **真實的臨時文件**：store 的測試用 `mkdtemp` 真寫真讀。
3. **時鐘注入**：scheduler / worker 的時間都是參數，測試可以精確控制「現在是幾點」。
4. **不用假數據**：測試裡出現的每個 run、每份賬本，都和生產路徑同一套 schema。

#### 7.3 verifier theater：形式上有驗證、實質上沒牙

本專案踩過的最典型坑：eval 內置用例全是 `node -e "process.exit(0)"` 和 `process.exit(1)`——退出碼永遠符合預期，發布管線形式上 fail-closed、實質上對任何提案都放行。

解法是把用例換成 **behavior case**：直接調用被測子系統的真實函數（合約校驗、裝配不變量、模板注入實效、硬閘門裁決、聚合透傳），並且評估時**把被測提案真實應用進去**——strict 策略檔的 regression 真的會紅，這才叫閘門有牙。

#### 7.4 「殼子」四信號

審計這個專案時總結的四個信號，專治「看起來有、實際沒有」：

1. **配置 / 枚舉定義了，運行時沒有消費者**（schedule.queue、stop_rules 修復前就是這樣）。
2. **類型在，運行時寫的是編造值**（賬本 runtime 塊曾硬編碼 `adapter: "claude"`）。
3. **接口在，數據沒接線**（詳情接口返回硬編碼 null）。
4. **兜底方向反了**（故障路徑比正常路徑更寬鬆——驗證崩潰判過）。

#### 7.5 普通 Java 項目對應

| Loop 專案 | 普通 Java 專案 |
|---|---|
| 真子進程測試 | `@SpringBootTest` 起真容器、Testcontainers 起真資料庫 |
| 真臨時文件 | `JUnit` 的 `@TempDir` |
| 時鐘注入 | `Clock` 接口 + 固定時鐘 `Clock.fixed(...)` |
| behavior case | 調用真 Service 方法，而不是 mock 所有依賴 |

**Java 範例：狀態機測試**

```java
@Test
void shouldRejectIllegalTransition() {
    Order order = new Order();
    order.pay();
    assertThatThrownBy(() -> order.pay()) // 重複支付
        .isInstanceOf(IllegalStateTransitionException.class);
}
```

這個測試會變紅，如果你把 `pay()` 的狀態校驗刪掉。這就是「有牙」的測試。

**Java 範例：時鐘注入測試限時任務**

```java
@Service
public class CouponService {
    private final Clock clock;

    public CouponService(Clock clock) {
        this.clock = clock;
    }

    public boolean isExpired(Coupon coupon) {
        return coupon.getExpireAt().isBefore(Instant.now(clock));
    }
}
```

```java
@Test
void shouldExpireCouponAfterDeadline() {
    Clock fixedClock = Clock.fixed(
        Instant.parse("2026-07-28T10:00:00Z"), ZoneId.of("UTC")
    );
    CouponService service = new CouponService(fixedClock);

    Coupon coupon = new Coupon();
    coupon.setExpireAt(Instant.parse("2026-07-28T09:59:59Z"));

    assertThat(service.isExpired(coupon)).isTrue();
}
```

#### 7.6 計算機思想

- **可證偽性（Falsifiability）**：一個不能證偽的測試沒有價值，就像一個永遠為真的命題。
- **契約測試（Contract Testing）**：測試驗證的是接口契約，而不是具體實現。
- **混沌工程（Chaos Engineering）**：主動製造故障，驗證兜底方向是否正確。
- **回歸測試（Regression Testing）**：確保新改動不破壞已有行為。

#### 7.7 面試題與答案

**Q1：「測試全綠」為什麼不能證明「第二輪 run 不會崩」？**

A：因為單測每個 case 都用乾淨狀態文件，沒有覆蓋「狀態文件被別人寫過」的路徑。本專案的 `complete → complete` bug 就是單測全綠但真實環境第二輪必現的典型例子。

**Q2：怎麼判斷一份 eval 報告「有沒有牙」？**

A：看它是否測量真實行為。如果所有用例都是 `exit(0)` / `exit(1)` 空轉，那就是 verifier theater。有牙的用例會直接調用被測子系統真實函數，並且把被測提案真實應用進去，確保 strict regression 真的會紅。

**Q3：Java 專案裡，什麼時候不應該用 mock？**

A：當你要驗證的是「組件整合後的真實行為」時，不應該 mock 掉所有依賴。過度 mock 會讓測試變成「演戲」，生產環境一出問題就全線崩潰。例如驗證資料庫事務、驗證緩存一致性、驗證消息投遞，都應該用真組件或 Testcontainers。

**Q4：什麼是「殼子」？舉四個信號。**

A：「殼子」是定義 / 接口 / 配置在，運行時無真實行為的現象。四個信號：配置 / 枚舉定義了但沒消費者；類型在但運行時寫編造值；接口在但數據沒接線；兜底方向反了（故障路徑比正常路徑更寬鬆）。

---

## 第三部分：實戰與 bug

### 第 8 章 十二個我們踩過的坑

下面這十二個坑全部來自本專案的真實經歷。讀懂它們，你就讀懂了這個項目最濃縮的工程決策史。

#### 坑 1：Codex 上策略引擎靜默失效

**現象**：聲明了 policy 的 run 在 Codex 鏈路上等於裸奔，沒有任何告警。

**根因**：Codex 橋把 `bypassPermissions` 映射成「永不審批 + 全權限沙盒」，策略引擎的鉤子一個都不觸發。

**教訓**：安全機制靜默失效比沒有更糟；先 fail-closed，再真接線。這條登記在 `06-項目規定.md #24`，後來 codex 橋真接線後登記在 `#39`。

#### 坑 2：同 loop 第二個 run 必崩還偽裝成功

**現象**：第一個 run 完成後，第二個 run 啟動第一次判定就拋異常，但 UI 顯示「完成」。

**根因**：`run_state.json` 按 loop 存，from-state 沒校驗 `run_id`。第二個 run 繼承了上個 run 的 `complete` 狀態，轉移表拒絕 `complete → complete`。

**教訓**：持久化狀態必須覆蓋「文件被別人寫過」的路徑。修復見 `control-plane.ts`。

#### 坑 3：驗證層崩潰 run 卻 complete

**現象**：verify 模塊自己拋異常，run 繼續走 complete。

**根因**：catch 只打日誌，繼續走「通過」分支。

**教訓**：判不清給機器不如給人。修復後合成 `inconclusive + requires_human`，升級 needs_human。

#### 坑 4：發布管線對任何提案都放行

**現象**：eval 報告全綠，但任何提案發布後系統行為都沒變好。

**根因**：eval 用例全是 `process.exit(0)` / `process.exit(1)` 空轉，形式上 fail-closed、實質上沒判別力。

**教訓**：用例不衡量真實行為 = verifier theater。換成 behavior case。

#### 坑 5：提案 published 但行為零變化

**現象**：學習 worker 產出的提案顯示已發布，但系統行為沒變。

**根因**：worker 不帶 payload + adapterPolicy 無消費者 + 檔名無註冊表。

**教訓**：「生效」必須有真實消費者，否則是假生效。

#### 坑 6：失敗模式賬本越攢越多但驗證不看

**現象**：`failure-pattern-store` 裡積累了大量失敗模式，但 verifier 輸入裡 `known_failure_patterns` 恆為 `[]`。

**根因**：機制建成不等於接線完成，沒有消費者。

**教訓**：查「殼子」四信號之第一條：配置 / 枚舉定義了，運行時沒有消費者。

#### 坑 7：重啟後同一分鐘重複點火

**現象**：server 重啟後，同一個 loop 在同一分鐘內被觸發兩次。

**根因**：冪等鍵只在記憶體 Set 裡，進程重啟即失效。

**教訓**：冪等鍵必須可持久化且自帶時效。修復後持久化到 `cron-fired.json`。

#### 坑 8：合法合約（3/3）被拒絕

**現象**：`max_turns=3, max_retries=3` 的合法合約被系統拒絕。

**根因**：實現私加 `max_retries < max_turns` 約束，而 spec 只說「同時生效、先觸者停」。

**教訓**：不允許悄悄引入第三種說法。發現實現偏離 spec 必須登記偏差。見 `06-項目規定.md #31`。

#### 坑 9：`node -e fs.writeFileSync('/etc/...')` 被自批准

**現象**：一個寫入 `/etc` 的高風險命令被 bypass 自批准了。

**根因**：命令名白名單只看命令名 `node`，沒看實際寫目標。

**教訓**：邊界檢查要看目標，不只看命令名。見 `06-項目規定.md #37`。

#### 坑 10：接口顯示上個 run 的「完成」

**現象**：API 返回某個 run 的狀態是 complete，但實際上這個 run 剛啟動就崩了。

**根因**：展示層按 loop 取 run_state，沒按 run 過濾。

**教訓**：展示層也要校驗歸屬。狀態機的歸屬校驗不能只發生在寫入端。

#### 坑 11：安全架構重複造輪子，與執行器脫節

**現象**：`gh auth status`、`docker ps` 等只讀命令被誤判為高風險，導致 GitHub issue 模式無法使用；每個新工具都需要手動添加規則到 `classify.ts`。

**根因**：我們試圖自己實現一套完整的安全分類系統（命令名正則 + 風險分級），與執行器自帶的安全機制（Codex 的 sandbox、Claude 的 permissionMode）重複。後來又嘗試 LLM 輔助分析器和 ensemble 架構，引入延遲、成本和誤判風險。

**教訓**：
1. **不要重複造輪子**：利用執行器自帶的安全機制，只補充業務層面的硬約束（硬閘門）。
2. **合約應該是安全決策的源頭**：安全等級由合約決定（`security_level`），然後映射到執行器模式，而不是獨立於合約的動態分類。
3. **簡單比複雜更可靠**：合約安全等級 + 執行器模式映射比複雜的 LLM 分析更可靠、更可預測。
4. **架構分離**：Loop 核心（簡單可靠） vs Benchmark/Eval Harness（複雜深入）。
5. **Agent 應該自主判斷**：硬性規則只用于兜底，不用于分流。

修復後的架構：`security_level`（read_only / workspace_write / full_access）→ 執行器模式映射（Claude permissionMode / Codex sandbox）→ 硬閘門檢查。見 `06-項目規定.md` 與 `docs/loop-engineering/policy-engine/安全架构教训.md`。

#### 坑 12：Verifier 假設所有項目都是 Node.js 項目

**現象**：GitHub prompt loop 的 verifier 返回 `inconclusive`，導致 run 進入 `needs_human`，即使 Claude 已經正確完成了任務（搜索 GitHub issues 並創建了 `search-results.md`）。

**根因**：Verifier 假設所有 workspace 都是 Node.js 項目，有 `package.json` 和測試命令（`lint`、`test`）。它檢查 `package.json` 中的 `scripts` 來檢測測試命令，如果沒有就返回 `inconclusive`。但 GitHub prompt loop 的 workspace 是空的（只有 Claude 創建的文件），所以 verifier 找不到測試命令。

**教訓**：
1. **Verifier 的假設過於狹隘**：假設所有項目都是 Node.js 項目，所有任務都需要測試，所有 success criteria 都是測試通過。
2. **Verifier 應該根據 intent contract 的 success criteria 來驗證**：而不是假設有測試命令。對於 GitHub issue 修復任務，success criteria 是「找到 3 個候選 issues」，verifier 應該檢查 `search-results.md` 是否存在且包含 3 個候選 issues。
3. **Verifier 應該支持多種驗證方式**：不僅僅是運行測試命令，還可以檢查文件是否存在、內容是否符合預期等。
4. **Verifier 應該支持自定義驗證命令**：允許用戶在 LoopCard 中指定自定義的 verification command。
5. **空 workspace 不是失敗**：當沒有需要驗證的內容時，verification 應該通過（vacuous truth），而不是返回 `inconclusive`。

修復後的邏輯：`subprocess-verifier.ts` 中，當 `commands` 是空數組時，返回 `passed` 而不是 `inconclusive`。見 `packages/server/src/loop/verification/subprocess-verifier.ts`。

---

### 第 9 章 讀代碼路線圖

理論過完，按下面順序動手。每一步都有明確的「讀什麼 / 做什麼 / 怎麼驗證」。

#### Day 1：schema 與存儲

1. **讀** `packages/shared/src/loop-schema/` 全部（約 10 個小文件）——先建立「合法數據長什麼樣」。
2. **讀** `packages/server/src/loop/state/` 的四個 store——重點看容錯加載、原子寫、串行追加。
3. **動手**：跑一次 `packages/server` 的 `npm test`，挑 `state/cleanup.test.ts` 讀懂它在驗證什麼。

#### Day 2：控制面與 run 主鏈路

1. **讀** `packages/server/src/loop/control-plane/state-machine.ts`（很短）→ `decide.ts`（決策表）→ `control-plane.ts` 的 `applyJudgment`。
2. **讀** `packages/server/src/loop/run-service.ts`——它是 2000+ 行，但骨架就一句：裝配 → 逐輪執行 → 落證據 → 驗證 → 判定 → 落賬。找到這六段各自的位置。
3. **動手**：起一個真 run，打開 `~/.yep-anywhere/loops/artifacts/<run_id>/` 逐文件看——你能在文件系統裡「看見」閉環。

#### Day 3：驗證、策略、學習

1. **讀** `packages/server/src/loop/verification/verify-run.ts` + `aggregate.ts`。
2. **讀** `packages/server/src/loop/policy/classify.ts` + `arbiter.ts` + `approval-hook.ts`。
3. **讀** `packages/server/src/loop/learning/worker.ts` + `pipeline.ts` + `eval-runner.ts`。
4. **自測**：對照 `E:/projects/loop/docs/loop-engineering/interview/面試問題.md` 的 58–67 題（實現實戰追問），能講清「為什麼這樣設計、不這樣會出什麼事」才算過。

#### 第一個練手任務

給 `verification_error` 做 verifier 側歸因分類——目前驗證失敗統一歸 `verification_error`，細分（命令不存在 / 超時 / 斷言失敗）能讓學習聚類更準。涉及 `verification/subprocess-verifier.ts` 與 `control-plane.ts` 的歸因掛載點。

---

## 第四部分：對照與思想

### 第 10 章 Loop 思想在普通 Java 項目中的對應

下面這張大表把 Loop Engineering 的核心機制映射到普通 Java 項目中常見的技術方案。

| Loop Engineering 概念 | Loop 專案實現 | 普通 Java 項目對應 |
|---|---|---|
| 狀態機 | `state-machine.ts` + `decide.ts` | Spring State Machine、Cola StateMachine、自研狀態機 |
| 冪等鍵 | `cronDedupeKey` / `decision_id` | 業務單號、messageId、請求流水號 + 唯一索引 / Redis NX |
| 事實源 | `~/.yep-anywhere/loops/` 文件 | 資料庫、Redis、對象存儲 |
| 原子寫 | `tmp + rename` | 資料庫事務、樂觀鎖、CAS、二階段提交 |
| 容錯加載 | 壞文件備份成 `.corrupt-<時間戳>` | 數據庫主從切換、日誌備份與回放、降級讀 |
| 單寫者 | per-file promise 鏈 | 資料庫行鎖、分散式鎖、隊列單消費者 |
| fail-closed | 驗證崩潰 → needs_human | 風控掛了 → 人工審核、權限掛了 → 403 |
| 審計賬本 | `run-ledger-store.ts` + `decision_entry` | 審計日誌表、操作日誌、Binlog |
| 證據引用 | `artifact://` URI | OSS / S3 URL、文件服務鏈接 |
| maker / checker | verification 與 runtime 分離 | 代碼審查、QA 與開發分離、風控與交易分離 |
| 測試紀律 | 真子進程、真臨時文件、時鐘注入 | `@SpringBootTest`、Testcontainers、`Clock` 接口 |
| 契約校驗 | zod schema | Bean Validation、OpenAPI 契約測試 |
| 發布管線 | shadow → regression → canary → publish | CI/CD、藍綠發布、金絲雀 |

#### 10.1 一個完整的 Java 對照案例：工作流引擎

假設你在 Java 項目裡要實現一個審批工作流，你可以這樣對應 Loop Engineering 的思想：

```text
Loop Engineering          Java 工作流
─────────────────────────────────────────────
Trigger                   定時任務（Quartz）/ 消息監聽
Intent Contract           流程定義（BPMN / 自研 DSL）
Assembly                  流程實例初始化、任務分配
Runtime Adapter           調用具體審批服務
Observability             流程執行日誌、SLA 監控
Verification              審批規則校驗、會簽結果檢查
Control Plane             工作流狀態機、會簽策略
Policy                    權限校驗、敏感操作人工複核
Learning                  流程瓶頸分析、異常模式沉澱
```

#### 10.2 另一個對照案例：電商訂單系統

```text
Loop Engineering          電商訂單
─────────────────────────────────────────────
Trigger                   用戶下單 / 支付回調 / 定時關單
Intent Contract           訂單模型：商品、價格、地址、優惠
Assembly                  庫存鎖定、優惠計算、運費計算
Runtime Adapter           調用支付寶 / 微信支付
Observability             訂單狀態變更日誌、支付埋點
Verification              支付結果驗證、庫存回滾檢查
Control Plane             訂單狀態機、超時關閉、自動退款
Policy                    高風險訂單人工審核、反欺詐
Learning                  退換貨原因聚類、欺詐模式識別
```

---

### 第 11 章 計算機思想總結

Loop Engineering 的每一個工程決策背後，都是通用的計算機科學思想。下面按主題總結。

#### 11.1 狀態與計算

- **有限狀態自動機（FSA）**：把隱含狀態顯式化為狀態圖。
- **確定性（Determinism）**：同樣輸入必得同樣輸出，這是冪等和測試的基礎。
- **不變量（Invariant）**：系統任何時刻都必須滿足的條件，例如「complete 是終態」。

#### 11.2 分散式系統

- **冪等性（Idempotency）**：同一操作多次執行效果相同。
- **最終一致性（Eventual Consistency）**：賬本是 append-only，讀者可能讀到稍舊的視圖。
- **單寫者（Single Writer）**：通過約定避免並發衝突。
- **容錯降級（Graceful Degradation）**：故障時不崩潰，但留下痕跡。

#### 11.3 安全與可靠性

- **Fail-closed / Fail-safe**：故障時倒向更安全的一側。
- **默認安全（Secure by Default）**：沒有明確授權 = 拒絕。
- **不可抵賴性（Non-repudiation）**：審計日誌讓操作無法否認。
- **最少權限原則（Least Privilege）**：只給必要的權限。

#### 11.4 軟體工程

- **單一職責原則（SRP）**：九層閉環每一層只回答一個問題。
- **契約優先（Contract First）**：schema 是邊界處的權威。
- **事件溯源（Event Sourcing）**：狀態 = 事件序列的折疊。
- **可證偽性（Falsifiability）**：測試必須能檢測錯誤實現。
- **持續學習（Continuous Learning）**：從失敗中沉澱改進，但改進必須過驗證。

---

## 第五部分：面試篇

### 第 12 章 核心面試題與詳細答案

下面 25 題按難度遞進，覆蓋本指南所有核心思想。建議先遮住答案自己作答。每題現在都包含「為什麼重要」、「深入回答」、「正例與反例」、「常見陷阱」四個小節，方便你講出完整的工程判斷。

#### 基礎題（1-10）

**Q1：Loop Engineering 和單次 prompt engineering 的本質區別是什麼？**

**為什麼重要**
這題區分「把 prompt 調好」與「把整個執行迴圈工程化」。面試官想看你是否理解：LLM 只是迴圈中的一個元件，外層還有觸發、合約、裝配、驗證、決策、學習。

**深入回答**
- prompt engineering 優化的是「一次會話」的輸出品質：給一個 prompt，期待一個好回答。
- Loop Engineering 建立的是一個可長期運行的外層控制系統：
  - 觸發（trigger）
  - 合約（intent contract）
  - 輸入裝配（runtime input assembly）
  - 執行（execution）
  - 觀測（observability）
  - 驗證（verification）
  - 決策（control plane / judgment）
  - 學習（learning / failure patterns）
- prompt 只是 loop 的一個輸入件，可以被 loop 調度、驗證和改進。沒有 loop，prompt 無法保證多輪一致性、預算控制與失敗恢復。

**正例與反例**
- 正例：一個定時檢查 GitHub issue 的 loop，會觸發、分解任務、執行多輪、驗證結果、在失敗時重試或升級人工。
- 反例：一個手動把任務貼到 Claude Code 的視窗，靠人工盯著它跑完。這是單次 prompt engineering，不是 loop engineering。

**常見陷阱**
- 把「寫一個很長的 system prompt」當成 Loop Engineering。
- 以為 multi-turn 對話就是 loop，忽略外層狀態機與驗證。

**A**：prompt engineering 優化的是一次會話的輸出品質；Loop Engineering 建的是一個可長期運行的外層控制系統：觸發 → 合約 → 輸入裝配 → 執行 → 觀測 → 驗證 → 決策 → 學習。prompt 只是 loop 的一個輸入件，可以被 loop 調度、驗證和改進。

---

**Q2：為什麼說 subagent 是執行角色，而 loop 是控制系統？**

**為什麼重要**
很多人把 subagent 與 loop 混為一談。面試官想看你是否能區分「做事情的單位」與「決定什麼時候做、做到哪裡停、失敗怎麼辦的系統」。

**深入回答**
- **subagent**：
  - 負責執行具體任務或專門化工作。
  - 例：planner agent 分解任務、coding agent 改程式碼、verifier agent 做驗證。
  - 它是 runtime 內部的執行角色。
- **loop**：
  - 負責狀態與停止條件、預算與重試、工具與工作區邊界、人工閘門與 bypass、狀態賬本與可驗證學習。
  - 它是控制職能。
- 關係：subagent 可以運行在 loop 內，但不能替代 loop。loop 為 subagent 提供合約、邊界與審計。

**正例與反例**
- 正例：planner subagent 產出計畫後，loop 決定每輪執行哪個 subtask、何時重試、何時升級人工。
- 反例：讓 coding subagent 自己決定何時停止、何時提交 PR，結果它在沒跑測試的情況下就宣稱完成。

**常見陷阱**
- 認為有 subagent 就不需要 loop。
- 把 loop 的狀態機邏輯塞進 subagent，導致控制與執行混雜。

**A**：subagent 用來拆分任務或做專門化執行，是 runtime 內部的執行角色。loop 負責狀態與停止條件、預算與重試、工具與工作區邊界、人工閘門與 bypass、狀態賬本與可驗證學習——這些是控制職能。subagent 可以運行在 loop 內，但不能替代 loop。

---

**Q3：觸發層如何保證冪等？**

**為什麼重要**
冪等是分散式系統的基本功。觸發層如果做不到冪等，可能導致同一事件被處理多次，產生重複結算、重複 PR、重複通知。

**深入回答**
- 冪等鍵設計：
  - 每個外部事件生成 `event_id` 或 `dedupe_key`（如 `<loop_id>:<minute stamp>`）。
  - 在時間窗口內查重。
- 具體機制：
  - 重複事件返回已有 run 或直接忽略。
  - 配合活躍 run 查詢（`run_active`）防止同一 loop 觸發多個並發 run。
  - 冪等鍵必須是確定性生成、可持久化、有明確時效。
- 冪等不是「只能執行一次」，而是「執行多次與一次效果相同」。

**正例與反例**
- 正例：cron 每分鐘觸發，鍵為 `loop:123:2026-07-30T09:15`，同一分鐘內的第二次觸發被忽略。
- 反例：用戶快速點兩下「執行」，系統產生兩個 run，結果互相覆蓋或並發改壞工作區。

**常見陷阱**
- 冪等鍵時效太長，導致合法的新事件被當成重複。
- 冪等鍵時效太短，導致重複事件繞過檢查。
- 只對 trigger 去重，卻沒檢查 `run_active` 狀態。

**A**：每個外部事件生成 `event_id` 或 `dedupe_key`（如 `<loop_id>:<minute stamp>`），在時間窗口內查重。重複事件返回已有 run 或直接忽略，配合活躍 run 查詢防止同一 loop 觸發多個並發 run。

---

**Q4：狀態機和一堆 boolean 的根本區別是什麼？**

**為什麼重要**
這題考的是「系統設計的嚴謹性」。boolean 組合在簡單場景好用，但隨著狀態增多會變得難以控制與除錯。

**深入回答**
- **boolean 組合**：
  - `isRunning`、`isPaused`、`isFailed`、`needsHuman` 等多個 flag。
  - 問題：組合爆炸，可能出現 `isRunning=true && isPaused=true` 的非法狀態。
  - 轉移不受控，任何程式碼都可以隨便改 flag。
- **狀態機**：
  - 顯式定義合法狀態與合法轉移。
  - 非法轉移被拒絕並記錄。
  - 狀態之間的關係清晰，可審計、可測試。
- 狀態機不是只為了「好看」，而是為了防止系統進入未定義狀態。

**正例與反例**
- 正例：`active → retry → active → complete`，每個轉移都經過 `assertLegalTransition` 檢查。
- 反例：兩個並發請求同時把 `isPaused` 與 `isRunning` 設為 true，系統行為不可預測。

**常見陷阱**
- 認為「我的系統很簡單，不需要狀態機」。當狀態超過 3 個時，狀態機通常已經值得引入。
- 狀態機只存在於文件，程式碼中沒有強制執行。

**A**：狀態機顯式定義合法轉移，非法轉移被拒絕並記錄；boolean 組合爆炸且轉移不受控。

---

**Q5：冪等鍵設計的三大原則是什麼？**

**為什麼重要**
冪等鍵是冪等性的核心。設計不好會導致重複執行或合法事件被攔截。

**深入回答**
1. **確定性生成**：同樣的輸入與條件必須產生同樣的鍵。不能依賴隨機數或時間戳（除非時間戳是業務語義的一部分）。
2. **可持久化**：鍵必須能被持久化儲存（資料庫、Redis、檔案），重啟後仍能查重。
3. **有明確時效**：鍵必須有過期時間或自然淘汰機制。時效太長會卡住合法重試，時效太短會失去冪等保護。
- 進階：冪等鍵最好同時包含「業務語義」與「時間邊界」。例如 `settlement:daily:sales:2026-07-30` 本身就帶有日期，新的一天自然生成新鍵。

**正例與反例**
- 正例：`report:daily:sales:2026-07-30` + 48 小時過期時間。
- 反例：用 `Math.random()` 生成冪等鍵，導致每次請求都產生不同鍵，完全失去冪等意義。

**常見陷阱**
- 冪等鍵只對「請求 ID」去重，但沒有包含業務語義，導致不同業務操作共享鍵。
- 冪等表沒有清理機制，最終變成巨大單表。

**A**：確定性生成、可持久化、有明確時效。

---

**Q6：fail-closed 和 fail-open 的區別是什麼？**

**為什麼重要**
安全相關系統必須 fail-closed。面試官想看你是否能在故障時做出正確的預設選擇。

**深入回答**
- **fail-closed**：故障時倒向更嚴格、更安全的一側。
  - 例：權限審批服務掛了 → 新授權申請掛起，不允許自動通過。
  - 例：審計寫入失敗 → 拒絕 tool call。
- **fail-open**：故障時倒向更寬鬆的一側。
  - 例：監控服務掛了 → 繼續服務，只是暫時沒有監控。
- 安全相關系統必須 fail-closed；非關鍵優化系統有時可以 fail-open，但必須是「顯式接受的權衡」。

**正例與反例**
- 正例：policy arbiter 無法確定動作是否安全時，選擇 deny 或 hard_gate。
- 反例：支付閘門在資料庫連不上時自動通過所有交易。

**常見陷阱**
- 為了「使用者體驗」把安全系統設成 fail-open。
- 沒有文件化 fail-open 的風險與補償措施。

**A**：fail-closed 故障時倒向更嚴格、更安全的一側；fail-open 倒向更寬鬆的一側。安全相關系統必須 fail-closed。

---

**Q7：為什麼賬本「只存引用」而不是把 diff 全文塞進去？**

**為什麼重要**
這題考的是資料架構與可擴展性。賬本需要輕量、可快速遍歷，而證據本體可能有不同保留策略。

**深入回答**
- 賬本的職責：記錄「發生了什麼」與「在哪裡可以找到證據」，而不是儲存所有細節。
- 只存引用（artifact URI）的好處：
  - 賬本輕小可速讀，方便快速遍歷與回放。
  - 證據本體（diff、log、stdout）可以獨立管理保留期與清理策略。
  - 避免賬本變成超大文件，影響讀寫效能。
- 缺點：需要額外一步去讀取 artifact。但這一步是必要的分離。

**正例與反例**
- 正例：ledger 記錄 `diff_ref: artifact://run-xxx/diff.patch`，需要時再讀取。
- 反例：ledger 直接包含整個 diff 內容，幾百輪後 ledger 變成數百 MB，無法快速讀取。

**常見陷阱**
- 為了「方便」把大對象塞進賬本，破壞 append-only 與輕量性。
- 引用丟失或失效，導致無法回放。

**A**：賬本需要輕小可速讀，diff 全文體量大。分離後賬本可快速遍歷，證據本體可獨立管理保留期和清理策略。

---

**Q8：什麼是 verifier theater？舉一個本專案的例子。**

**為什麼重要**
verifier theater 是形式上有驗證、實質上沒判別力的狀態。這題考的是你對「真測試」與「假測試」的辨識能力。

**深入回答**
- verifier theater = 有驗證步驟，但驗證無法區分好壞結果。
- 常見形式：
  - eval 用例全是 `exit(0/1)` 空轉，對任何提案都放行。
  - verifier 只檢查「檔案是否存在」，不檢查內容是否正確。
  - 測試用例只呼叫 mock，沒有驗證真實行為。
- 危害：讓團隊誤以為系統很安全，實際上問題會在生產環境才爆發。

**正例與反例**
- 正例：verifier 執行真實的 test suite，並檢查 diff 是否符合預期。
- 反例：verifier 只檢查「executor-summary 裡有沒有寫『完成』」。

**常見陷阱**
- 把「有測試」當成「測試有效」。
- 為了提高通過率而寫弱測試。

**A**：形式上有驗證、實質上沒判別力。例子：eval 用例全是 `exit(0/1)` 空轉，對任何提案都放行。

---

**Q9：maker 和 checker 為什麼必須分離？**

**為什麼重要**
這是軟體工程與安全的基本原則。執行者給自己打分會偏寬，獨立驗證才能保證客觀性。

**深入回答**
- **maker**：執行任務、產出結果的單位（如 coding agent）。
- **checker**：獨立驗證結果是否合格的單位（如 verifier、人工審查）。
- 為什麼分離：
  - 自我評估容易偏寬，因為 maker 已經投入 sunk cost。
  - 獨立 checker 有不同的視角與標準。
  - CMU 研究證實：獨立評估 agent（CRDAL 架構）顯著優於自評。
- 分離的代價：額外成本與延遲。但對於高風險或高品質要求的任務，這是值得的。

**正例與反例**
- 正例：程式碼由 Agent 生成，由 test suite 與 reviewer 獨立驗證。
- 反例：Agent 自己生成程式碼，自己說「我測試過了，沒問題」。

**常見陷阱**
- 形式上分離，但 checker 實際上還是讀取 maker 的自我陳述來判斷。
- checker 與 maker 共享太多上下文，失去獨立性。

**A**：執行者給自己打分會偏寬，獨立驗證才能保證客觀性。CMU 研究證實獨立評估 agent 顯著優於自評。

---

**Q10：什麼是「殼子」？**

**為什麼重要**
「殼子」是工程中常見的隱患：看起來有功能，實際上沒接線。面試官想看你是否能識別這類問題。

**深入回答**
- 「殼子」= 定義 / 接口 / 配置在，運行時無真實行為的現象。
- 四個識別信號：
  1. **配置沒消費者**：某個 flag 寫在 config 裡，但程式碼沒有人讀取。
  2. **類型存編造值**：為了通過 type check 而塞的假值。
  3. **接口沒接線**：函數定義了，但從來沒被呼叫，或呼叫後結果沒被使用。
  4. **兜底方向反了**：fallback 應該 fail-closed，卻變成 fail-open。
- 殼子最危險的地方：它讓你以為系統有某種保護，實際上沒有。

**正例與反例**
- 正例：你檢查每個配置項都有運行時消費者，並寫測試驗證「改錯會變紅」。
- 反例：系統有一個 `max_retries` 配置，但程式碼中根本沒讀取，結果永遠用預設值。

**常見陷阱**
- 只看單元測試覆蓋率，忽略「配置是否被消費」。
- 把「編譯通過」當成「功能存在」。

**A**：定義 / 接口 / 配置在，運行時無真實行為的現象。四個信號：配置沒消費者、類型存編造值、接口沒接線、兜底方向反了。

---

#### 進階題（11-20）

**Q11：本專案中 `complete → complete` 的 bug 說明了什麼？**

**為什麼重要**
這題考的是「持久化狀態的歸屬權」。狀態寫入時必須確認這個狀態是屬於當前 run 的，否則可能覆蓋別人的狀態。

**深入回答**
- 背景：某個 run 已經 `complete`，但由於某種原因又觸發了一次狀態寫入，結果把 `complete` 寫成 `complete`，看似無害，但可能伴隨著其他欄位被覆蓋。
- 核心教訓：
  - 持久化狀態必須覆蓋「文件被別人寫過」的路徑。
  - 必須校驗歸屬（run_id、goal_id）。
  - 寫入前應檢查當前磁碟狀態是否與預期一致。
- 更廣泛的意義：任何「覆蓋寫入」都要問：「我有沒有權利覆蓋？會不會覆蓋到別人的東西？」

**正例與反例**
- 正例：寫入 `run_state.json` 前檢查檔案中的 `run_id` 與當前 run 一致，不一致則報錯。
- 反例：任何 run 都可以覆蓋 `state/<loop_id>.json`，結果前一個 run 的狀態被後一個 run 覆蓋。

**常見陷阱**
- 認為「狀態已經是 complete 了，不會再被寫」。實際上 retry、race condition、bug 都可能觸發寫入。
- 只檢查狀態合法性，不檢查狀態歸屬。

**A**：持久化狀態必須覆蓋「文件被別人寫過」的路徑，必須校驗歸屬（run_id）。

---

**Q12：bypass 自批准的核心承諾是什麼？審計失敗該怎麼辦？**

**為什麼重要**
bypass 是無人值守 run 的關鍵機制，但它不是「無限制」。面試官想看你是否理解 bypass 的契約與審計要求。

**深入回答**
- bypass 自批准的核心承諾：**本地、可回滾、可審計**。
  - 本地：動作發生在工作區內。
  - 可回滾：可以透過 git / worktree 復原。
  - 可審計：每次 self-approve 都要寫 decision ledger。
- 審計失敗怎麼辦：
  - 如果系統無法把這次 self-approve 寫入 ledger，就必須拒絕這次呼叫。
  - 這是 fail-closed：寧可拒絕合法的本地操作，也不允許無審計的操作。

**正例與反例**
- 正例：Agent 修改工作區檔案，系統成功把 `bypass_used` 寫入 ledger。
- 反例：Agent 修改工作區檔案，但 ledger 寫入失敗，系統還是允許了操作，結果無法追溯。

**常見陷阱**
- 把 bypass 當成「繞過所有限制」。bypass 不能繞過硬閘門。
- 審計失敗時為了「不影響功能」而 fail-open。

**A**：本地、可回滾、可審計；審計失敗必須拒絕調用，fail-closed。

---

**Q13：為什麼 decision_id 要包含 runId + turn + state？**

**為什麼重要**
這題考的是「冪等寫入」與「重放安全」。decision 是 append-only 的事實記錄，必須避免重複寫入。

**深入回答**
- decision_id = `runId + turn + state` 構成一個確定性鍵。
- 好處：
  - 同一判定重放時會撞上已有條目，實現重放安全。
  - 不追加、不重存、不重廣播。
  - 即使控制面被重複觸發，ledger 也不會髒掉。
- 這是「冪等鍵」原則在決策層的應用：鍵必須能唯一標識一次狀態轉移。

**正例與反例**
- 正例：網路重試導致 `applyJudgment` 被呼叫兩次，第二次因為 decision_id 已存在而被忽略。
- 反例：decision_id 使用隨機 UUID，每次重試都產生新條目，ledger 出現重複決策。

**常見陷阱**
- decision_id 只包含 runId，導致同一 run 的不同 turn 產生衝突。
- decision_id 包含 timestamp，失去冪等性。

**A**：這樣同一個判定重放時會撞上已有條目，實現重放安全：不追加、不重存、不重廣播。

---

**Q14：cron 的待觸發隊列是純記憶體的，重啟丟 pending——這算 fail-open 還是 fail-closed？為什麼可接受？**

**為什麼重要**
這題考的是「顯式權衡」。不是所有 fail-open 都是錯的，關鍵是是否被明確接受且有補償措施。

**深入回答**
- 這算 **fail-open**：重啟後 pending 請求丟失，不會自動補跑。
- 為什麼可接受：
  - spec 明確規定「重啟不補跑」。
  - 它不是安全關鍵路徑，而是調度優化。
  - `run_active` 仍是並發兜底：如果某個 loop 該跑但沒跑，下一次 cron 觸發會正常處理。
- 關鍵：fail-open 必須是「顯式接受的權衡」，而不是「不小心設計成這樣」。

**正例與反例**
- 正例：文件清楚寫明「cron pending queue 為記憶體，重啟不保留」，並且有 cron 下次觸發的補償。
- 反例：支付系統的待處理隊列也是純記憶體，重啟後交易消失。

**常見陷阱**
- 把所有 fail-open 都當成 bug。
- 沒有文件化 fail-open 的行為與風險。

**A**：算 fail-open，但它是顯式接受的權衡：spec 明確「重啟不補跑」，且 `run_active` 仍是並發兜底。它不是安全關鍵路徑，而是調度優化。

---

**Q15：為什麼 `max_retries < max_turns` 的私加約束是錯的？**

**為什麼重要**
這題考的是「不要違反合約」。spec 是數值權威來源，程式碼不應該私自加上沒有規定的限制。

**深入回答**
- spec 只說：「`max_turns` 含首輪、`max_retries` 不含首輪、同時生效、先觸者停」。
- 私加 `max_retries < max_turns` 的問題：
  - 拒絕了合法合約，例如 `max_turns=3`、`max_retries=3` 應該是允許的。
  - 在合約層與實作層引入「第三種說法」，造成不一致。
  - 使用者按 spec 設定的合約被無聲拒絕，體驗糟糕。
- 原則：實作必須忠實反映 spec；如果要加限制，必須先在 spec 中更新。

**正例與反例**
- 正例：控制面嚴格按 spec 檢查 `used_turns >= max_turns` 或 `used_retries >= max_retries`，先觸發者停。
- 反例：UI 或控制面私自加上 `max_retries < max_turns`，導致合法合約被拒絕。

**常見陷阱**
- 開發者覺得「這樣比較合理」就加上限制，沒有更新 spec。
- 把「防禦式程式碼」變成「隱藏規則」。

**A**：spec 只說「同時生效、先觸者停」，私加約束會拒絕合法合約（如 3/3）。這違反了「不允許悄悄引入第三種說法」的規定。

---

**Q16：為什麼權限橋接需要 post-run verifier 兜底？**

**為什麼重要**
權限橋接只是把 policy 投影到 runtime 權限，它不是萬能安全層。面試官想看你是否理解「投影 ≠ 執行保證」。

**深入回答**
- 權限橋接（policy projection）的工作：
  - 把 `PolicyProfile` 轉換成 runtime 的 permission mode / deny list / approval hook。
  - 攔截明顯的硬閘門動作。
- 為什麼還需要 post-run verifier：
  - adapter 不支持的策略無法映射。
  - 映射了的策略也無法確認 runtime 內部實際執行了什麼。
  - runtime 可能透過間接路徑產生外部副作用（例如修改 CI 配置導致部署）。
- post-run verifier 用 diff、trace、permission events、外部副作用證據判斷 runtime 是否真的越界。

**正例與反例**
- 正例：run 結束後，verifier 檢查 diff 是否只包含工作區內檔案，並檢查 permission events 是否有未授權動作。
- 反例：以為 policy projection 攔截了所有危險動作，就取消了 post-run verifier。

**常見陷阱**
- 把 policy projection 當成唯一安全層。
- 忽略間接副作用。

**A**：權限橋接只是策略投影，不是萬能安全層：adapter 不支持的策略映射不了，映射了的也無法確認內部執行。post-run verifier 用 diff、trace、permission events、外部副作用證據判斷 runtime 是否真的越界。

---

**Q17：為什麼 Intent Contract 是停止條件的合約化？**

**為什麼重要**
沒有顯式停止規則，loop 會無限修復循環和預算空耗。面試官想看你是否理解「停止條件必須寫進合約」。

**深入回答**
- Intent Contract 不僅描述要做什麼，還描述：
  - 成功條件（success criteria）
  - 約束（constraints）
  - 預算（max_turns / max_retries / max_time / max_tokens）
  - 停止規則（stop rules）
- 每個 run 至少要有五類停止：
  1. **成功停止**：達成目標且通過驗證。
  2. **預算停止**：輪次、時間、token、重試任一達上限。
  3. **歧義停止**：結果 inconclusive，需要人工。
  4. **安全停止**：觸發硬閘門或異常行為。
  5. **重複停止**：同一錯誤反覆出現。
- 把停止條件寫進合約的好處：可審計、可驗證、前後端一致。

**正例與反例**
- 正例：合約明確寫 `max_turns=10`、`max_time_minutes=30`、`max_same_failure=3`。
- 反例：停止條件散落在 prompt 與程式碼各處，導致行為不一致。

**常見陷阱**
- 只關注「成功條件」，忽略「失敗與預算停止」。
- 停止條件只存在於文件，沒有在控制面強制執行。

**A**：沒有顯式停止規則，loop 會無限修復循環和預算空耗。每個 run 至少要有五類停止：成功停止、預算停止、歧義停止、安全停止、重複停止。

---

**Q18：四段驗證為什麼是 evidence escalation path？**

**為什麼重要**
四段驗證是 Loop Engineering 的核心設計。面試官想看你是否理解「從便宜證據到昂貴證據」的漸進式驗證。

**深入回答**
- 四段驗證：static → runtime → interaction → review。
- 它是 evidence escalation path：
  - **static**（編譯、lint）：便宜、確定、快速。
  - **runtime**（測試）：稍微昂貴，但仍然是客觀證據。
  - **interaction**：需要人機互動或模擬評估。
  - **review**：模型評審或人工審查，最昂貴、最主觀。
- 設計原則：
  - 低層硬失敗且高層不會增加信息時，直接短路停止。
  - 不要一開始就跑最昂貴的 review。

**正例與反例**
- 正例：程式碼編譯失敗，直接停止，不再跑測試或人工審查。
- 反例：每次 run 都從 LLM-as-a-judge 開始，不管 test 是否通過，浪費大量成本。

**常見陷阱**
- 四段都跑滿，不管低層是否已經失敗。
- 把 review 段當成萬能驗證，忽略前面便宜的確定性檢查。

**A**：它定義證據升級路徑：從便宜、確定的證據（編譯、lint）逐步升級到昂貴、模糊的判斷（模型評審、人審）。低層硬失敗且高層不會增加信息時直接停止。

---

**Q19：為什麼 executor 的自然語言總結不能直接作為完成結論？**

**為什麼重要**
這題再次強調 maker/checker 分離。面試官想看你是否警惕「LLM 自評」。

**深入回答**
- 如果 executor 的自然語言總結可以直接作為完成結論，就退化成了 executor 自評。
- 問題：
  - LLM 可能幻覺，說自己完成了，實際沒有。
  - LLM 對「完成」的標準可能與合約不一致。
  - 沒有獨立證據，無法審計。
- verifier 必須基於獨立證據（diff、stdout、測試結果）判斷。
- executor-summary 可以作為輔助理解，但不能替代確定性證據。

**正例與反例**
- 正例：verifier 檢查 `npm test` 的退出碼與 diff 內容，而不是讀 executor 的「我完成了」。
- 反例：系統只因為 executor 輸出「任務完成」就標記 run 為 complete。

**常見陷阱**
- 把 executor-summary 當成判斷依據。
- 認為「模型說完成了就應該信任它」。

**A**：這會退化成 executor 自評。verifier 必須基於獨立證據（diff、stdout、測試結果）判斷，而不是 executor 的自我陳述。

---

**Q20：學習為什麼「不直通規則」？**

**為什麼重要**
這題考的是「改進必須經過驗證管線」。直接把觀察到的模式變成規則會導致回歸與假生效。

**深入回答**
- 學習管線：失敗 → 模式 → 提案 → shadow → regression → canary → publish（人工閘門）→ 生效。
- 為什麼不能直通規則：
  - 觀察到的模式可能是特例，不是通則。
  - 直接改規則可能破壞其他場景（回歸）。
  - 沒有經過驗證的改進會造成「假生效」：看起來修好了，實際上是繞過問題。
- 每個提案都必須經過 shadow 與 canary，確認沒有回歸才能 publish。

**正例與反例**
- 正例：某個失敗模式產生「對 GitHub issue 任務增加 timeout」的提案，先在 shadow 跑 50 個歷史任務，確認沒有回歸後才生效。
- 反例：看到一次失敗就改 prompt，結果其他 10% 的任務開始失敗。

**常見陷阱**
- 把「學習」當成「自動改程式碼」。
- 忽略人工閘門與回歸測試。

**A**：失敗 → 模式 → 提案 → shadow → regression → canary → publish（人工閘門）→ 生效。改進必須過驗證管線，否則會引入回歸或假生效。

---

#### 高階題（21-25）

**Q21：為什麼 session_ref 不能作為唯一事實源？**

**為什麼重要**
這題考的是「外部事實源 vs 內部狀態」。很多開發者會過度依賴 runtime 內部檔案，但這些檔案可能丟失或過期。

**深入回答**
- session_ref 指向 runtime 產生的 session 檔案，可能：
  - 丟失（磁碟清理、重啟）。
  - runtime 版本變更導致格式不相容。
  - event cursor 過期。
  - transcript 不完整（例如被截斷或部分損壞）。
- 可靠恢復基線應該是外部事實：
  - **ledger**：每個 decision 與 artifact ref。
  - **workspace**：當前檔案狀態。
  - **diff**：相對於基線的變更。
  - **judgment_report**：每輪的驗證結果。
- session_ref 可以用來恢復對話上下文，但不能作為「發生了什麼」的唯一權威。

**正例與反例**
- 正例：重啟後從 ledger 與 workspace 重建狀態，session 只是輔助。
- 反例：重啟後只依賴 session 檔案，結果檔案損壞導致整個 run 無法恢復。

**常見陷阱**
- 把 transcript 當成事實源。
- 沒有區分「對話上下文」與「系統狀態」。

**A**：session 文件會丟失、runtime 版本會變、event cursor 會過期、transcript 可能不完整。可靠恢復基線是外部事實：賬本、workspace、diff、judgment_report。

---

**Q22：如果兩個 server 實例同時跑（多 profile），單寫者約定還成立嗎？**

**為什麼重要**
這題考的是「單寫者約定」與「資料隔離」。面試官想看你是否理解 profile 與資料目錄的關係。

**深入回答**
- 單寫者約定：一種文件只有一個寫入口，其餘都是讀者。
- 多 profile 情況：
  - `YEP_ANYWHERE_PROFILE` 隔離資料目錄。
  - 不同 profile 寫不同的資料目錄，彼此不衝突。
  - 因此單寫者約定仍然成立，只是「同一 profile 內」的單寫者。
- 關鍵：不要用同一個 profile 跑多個 server 實例，否則會違反單寫者約定。

**正例與反例**
- 正例：開發環境用 `dev` profile，生產環境用 `prod` profile，資料完全隔離。
- 反例：兩個開發者用同一個 profile 啟動 server，同時寫入同一個 `run_state.json`，導致狀態損壞。

**常見陷阱**
- 認為多 profile 破壞了單寫者約定。其實是擴展了約定的範圍。
- 在同一 profile 內跑多個實例卻沒有分散式鎖。

**A**：成立，因為 `YEP_ANYWHERE_PROFILE` 隔離數據目錄。不同 profile 寫不同的數據目錄，彼此不衝突。但同一 profile 內仍要遵守單寫者約定。

---

**Q23：設計一個「每日報表生成」的冪等鍵，寫出它的生成式與時效。**

**為什麼重要**
這題考的是冪等鍵設計的實際應用。面試官想看你是否能把原則轉化成具體方案。

**深入回答**
- 生成式：`report:daily:<report_type>:<date>`
  - 例：`report:daily:sales:2026-07-30`
- 時效：
  - 鍵以日期為組成部分，新的一天自然淘汰舊鍵。
  - 同時在資料庫冪等表設 48 小時過期時間，避免歷史鍵無限累積。
- 為什麼這樣設計：
  - 日期提供業務語義，確保同一天不會重複生成。
  - 48 小時保留期允許手動重跑昨天的報表（如果需要補跑），同時不會讓表無限增長。

**正例與反例**
- 正例：`report:daily:sales:2026-07-30` + TTL 48h。
- 反例：`report:daily:sales` 沒有日期，導致所有天的報表共享同一個鍵，無法區分。

**常見陷阱**
- 冪等鍵不包含時間邊界，導致無法區分不同天的任務。
- TTL 設太短，導致合法的補跑被當成重複。

**A**：生成式：`report:daily:<report_type>:<date>`，例如 `report:daily:sales:2026-07-28`。時效：鍵以日期為組成部分，新的一天自然淘汰舊鍵；同時在資料庫冪等表設 48 小時過期時間。

---

**Q24：為什麼 Control Plane 和 Policy Engine 要拆分？**

**為什麼重要**
這題考的是「關注點分離」。控制平面與策略引擎回答不同的問題，混在一起會讓系統難以維護與審計。

**深入回答**
- **Control Plane**：
  - 確定性運行層。
  - 負責狀態機、預算、重試、暫停恢復。
  - 回答「run 現在處於什麼狀態、下一步該去哪」。
- **Policy Engine**：
  - 安全與審批層。
  - 負責風險分級、能力請求、人工閘門、bypass 語義。
  - 回答「這個動作能不能做」。
- 拆分好處：
  - 安全與審批邏輯不混進狀態機。
  - 兩者可以獨立演化、獨立測試、獨立審計。
  - 策略改變不需要改控制面狀態機。

**正例與反例**
- 正例：控制面只關心「狀態轉移是否合法」；policy engine 只關心「tool call 是否允許」。
- 反例：狀態機裡直接寫死「if tool == 'gh pr merge' then needs_human」，導致每次新增硬閘門都要改狀態機。

**常見陷阱**
- 把 policy 判斷寫進控制面，導致狀態機變得龐大。
- 控制面越權做 policy 決策。

**A**：控制平面是確定性運行層：狀態機、預算、重試、暫停恢復。策略引擎回答「能不能做」：風險分級、能力請求、人工閘門、bypass 語義。不拆會讓安全與審批邏輯混進狀態機，難以審計和獨立演化。

---

**Q25：你怎麼判斷一個新加入的機制不是「殼子」？**

**為什麼重要**
這題是 Q10 的實戰延伸。面試官想看你是否能系統性地檢查新功能是否真正生效。

**深入回答**
- 檢查四個信號：
  1. **配置 / 枚舉有沒有運行時消費者**：這個 flag 真的有程式碼讀取嗎？
  2. **類型值是不是編造的**：為了 type check 塞的假值，實際上不會出現在運行時。
  3. **接口數據有沒有接線**：函數是否被呼叫？結果是否被使用？
  4. **故障路徑的兜底方向是否正確**：fallback 是 fail-closed 還是 fail-open？是否符合預期？
- 最後一步：**寫一個「改錯實現會變紅」的測試**。如果你無法寫出這樣的測試，這個機制可能就是殼子。

**正例與反例**
- 正例：新加的 `max_same_failure` 停止規則，寫一個測試讓同一錯誤出現 4 次，驗證 run 確實停止。
- 反例：新加了一個「安全模式」flag，但沒有任何測試能證明它真的會攔截危險動作。

**常見陷阱**
- 只看程式碼是否存在，不看它是否被執行與消費。
- 測試只驗證「happy path」，不驗證故障路徑。

**A**：檢查四個信號：配置 / 枚舉有沒有運行時消費者；類型值是不是編造的；接口數據有沒有接線；故障路徑的兜底方向是否正確。最後寫一個「改錯實現會變紅」的測試來驗證。

---

### 第 13 章 場景設計題

這一章給出 5 個開放式場景題，適合面試或團隊討論。沒有標準答案，但有設計方向。每個場景現在都會先說明「這個場景在考什麼」，再給出具體設計方向。

#### 場景 1：設計一個定時結算系統

**這個場景在考什麼**
冪等、狀態機、重啟恢復、fail-closed。

**背景**：電商平台每天凌晨 2 點要對前一天訂單做結算。結算任務可能跑 30 分鐘，server 可能重啟。

**問題**：
- 如何保證同一天只結算一次？
- 結算到一半 server 重啟了怎麼辦？
- 如果結算腳本自己拋異常，應該怎麼處理？

**設計方向**：
- 冪等鍵：`settlement:2026-07-27`，持久化到資料庫或 Redis，帶 48 小時過期。
- 狀態機：`pending → running → completed / failed`。
- 重啟恢復：結算任務按批次進行，每完成一批落賬；重啟後從最後落賬位置繼續。
- 異常處理：fail-closed，異常時標記 failed 並告警，不允許部分結算數據混入財務系統。

**為什麼這樣設計**
- 冪等鍵保證同一天不會重複結算。
- 狀態機讓結算過程可觀測、可審計。
- 批次落賬讓重啟後可以斷點續跑，而不是從頭開始。
- fail-closed 保護財務資料不被部分錯誤資料污染。

---

#### 場景 2：設計一個文件導入系統

**這個場景在考什麼**
冪等、部分恢復、審計。

**背景**：用戶可以上傳 CSV 導入商品信息。文件可能很大，導入可能失敗。

**問題**：
- 如何防止用戶重複點擊導入？
- 導入到一半失敗了，如何部分恢復？
- 如何審計每一次導入？

**設計方向**：
- 冪等：以上傳文件的 hash 或任務 ID 為鍵。
- 狀態機：`uploaded → parsing → validating → importing → completed / failed`。
- 部分恢復：按行級事務處理，失敗時記錄已導入行號，支持斷點續傳。
- 審計：記錄導入任務 ID、文件名、行數、成功數、失敗數、操作人、時間、錯誤文件引用。

**為什麼這樣設計**
- 文件 hash 冪等可以防止用戶重複上傳同一文件，也可以區分不同文件。
- 行級事務讓部分恢復成為可能，不需要從頭重新導入大文件。
- 詳細審計讓運維與客服可以追溯每次導入的細節。

---

#### 場景 3：設計一個權限審批系統

**這個場景在考什麼**
狀態機、fail-closed、防繞過。

**背景**：管理員可以給用戶授權敏感操作權限。授權操作本身需要審批。

**問題**：
- 如何保證審批通過後才真正授權？
- 如果審批服務掛了，系統應該怎麼表現？
- 如何防止繞過審批直接授權？

**設計方向**：
- 狀態機：`pending_approval → approved → applied / rejected`。
- fail-closed：審批服務掛了時，新授權申請掛起，不允許自動通過。
- 防繞過：所有權限變更必須經過審批服務落賬，授權服務只讀取已審批的賬本；繞過審批的寫入會因賬本缺失而被回滾或拒絕。

**為什麼這樣設計**
- 狀態機確保授權只能從已審批狀態進入生效狀態。
- fail-closed 防止審批服務故障時產生未經授權的權限變更。
- 授權服務只讀審批賬本，確保沒有後門可以繞過。

---

#### 場景 4：設計一個 CI/CD 發布閘門

**這個場景在考什麼**
verifier theater、fail-closed、審計。

**背景**：每次代碼合併後要跑測試、靜態檢查、性能回歸，通過後才能發布。

**問題**：
- 如何防止「測試沒牙」導致任何提交都放行？
- 如果測試框架本身壞了，應該發布還是攔截？
- 如何審計每一次發布決策？

**設計方向**：
- behavior case：測試用例直接調用被測代碼的真實函數，而不是只檢查退出碼。
- fail-closed：測試框架壞了 = 無法證明安全，禁止發布。
- 審計：記錄每次發布的 commit、測試結果、發布人、時間、通過的閘門。

**為什麼這樣設計**
- behavior case 確保測試真的能判別好壞，避免 verifier theater。
- 測試框架壞了時 fail-closed，因為無法證明程式碼安全。
- 審計讓每次發布都可追溯，出事後可以回放決策過程。

---

#### 場景 5：設計一個分佈式任務調度系統

**這個場景在考什麼**
分散式鎖、冪等、心跳、審計。

**背景**：系統有 10 個 worker 節點，需要調度定時任務。任務不能重複執行。

**問題**：
- 如何保證同一個任務在同一時間只被一個 worker 執行？
- worker 執行到一半掛了怎麼辦？
- 任務執行結果如何審計？

**設計方向**：
- 分散式鎖 + 冪等鍵：以 `<job_name>:<schedule_time>` 為鍵，配合 Redis Redlock 或資料庫樂觀鎖。
- 心跳與超時：worker 定期更新心跳，調度器發現超時後重新調度。
- 審計：任務調度日誌記錄 job ID、worker ID、開始時間、結束時間、結果、重試次數。

**為什麼這樣設計**
- 冪等鍵確保同一時間點的同一任務不會被多個 worker 同時執行。
- 心跳機制讓系統能發現 worker 掛掉並重新調度，避免任務永遠卡住。
- 審計日誌讓任務執行歷史可追蹤，方便除錯與監控。

---
---

## 生產就緒缺口清單

下面這組問題常被用來判斷一個 loop 是否真能上線。對每個問題，我們給出當前實現的對應點與仍然存在的缺口。

> 2026-08-09 起，下列缺口已有對應設計文件，狀態從「未設計」改為「已設計，核心已實作」：`docs/design/loop-production-readiness-index.md`。

### 1. loop 到底讀了什麼原始輸入？
- **對應**：權威輸入是 `LoopCard`（`packages/server/src/loop/state/loop-card-store.ts`），具體是 `card.loop.handoff.task`；裝配層 `packages/server/src/loop/contract/intent-contract.ts` 把它轉成 `IntentContract`；最終 prompt 由 `packages/server/src/loop/assembly/runtime-input.ts` 的 `assembleRuntimeInput` 生成，混入 memory packet、人工反饋、子任務簡報。
- **缺口**：沒有未授權外部輸入；還行。

### 2. 什麼任務邊界防止 scope creep？
- **對應**：`IntentContract` 的 `outcome`、`success_criteria`、`constraints`、`budget`、`stop_rules`；planner 生成的 `TaskPlan.subtasks` 每輪只做一個；`packages/server/src/loop/policy/arbiter.ts` 攔下硬閘門與 high-risk 動作。
- **缺口**：direct 模式下工作區本身無硬性邊界，模型仍可能改到任務外的文件。

### 3. loop 把狀態寫在哪裡？
- **對應**：`RunLedgerStore` → `~/.yep-anywhere/loops/runs/<runId>.jsonl`；`RunStateStore` → `~/.yep-anywhere/loops/state/<loopId>.json`；artifacts → `~/.yep-anywhere/loops/artifacts/<runId>/`；worktree 策略時實際文件在 `~/.yep-anywhere/github-workspaces/...`。
- **缺口**：狀態位置清晰。

### 4. 每一次 run 是怎麼隔離的？
- **對應**：`runId` 唯一；每 run 獨立賬本與 artifact 目錄；同 loop 串行（`activeByLoop`）；worktree 策略每 run 獨立 branch/worktree。
- **缺口**：direct 策略直接改用戶原目錄，隔離最弱。

### 5. 誰獨立驗證輸出？
- **對應**：`packages/server/src/loop/verification/verify-run.ts` 的 verifier chain；`SubprocessStrategy` 跑命令；`ContractCriteriaStrategy` 檢查 workspace 文件是否滿足 success_criteria；`packages/server/src/loop/policy/arbiter.ts` 獨立於執行器做工具調用裁決；`InteractionAgentStrategy` 產生 Playwright 驗證腳本；Verifier Agent 作為 L4 Judge。
- **缺口**：executor 空產出仍可能被 static 結果誤判為 complete；L4 輸入上限與 collector/judge 成本優化尚未實作。設計見 `docs/design/loop-empty-output-detection-design.md` 與 `docs/design/loop-verifier-extension-design.md`。

### 6. 成本、重試、超時限制各是什麼？
- **對應**：budget（max_turns / max_time_minutes / max_tokens / max_retries）在 `control-plane.ts` 的 `exhaustedFields` 檢查；重試退避 `packages/server/src/loop/control-plane/retry-backoff.ts`（1min × 2^(n-1)，封頂 5min）；verifier 子進程默認 120s；單輪無固定硬超時是既定決策，由 idle watchdog 與 `adapter_policy.timeout_seconds` 治理。
- **缺口**：token 預算只記錄與檢查，沒有 turn 前預檢與執行中成本熔斷。設計見 `docs/design/loop-token-quota-breaker-design.md`。

### 7. 哪一步明確需要人工批准？
- **對應**：硬閘門命中 → `policy_blocked` → `needs_human`；judgment `requires_human: true`（merge gate、inconclusive escalate 等）；`budget_limited` 需調用 `POST /api/runs/:id/budget` 補充預算；`POST /api/runs/:id/decision` 發 approve/request_changes。
- **缺口**：批准點清晰。

### 8. 失敗的 run 要怎麼回滾或丟棄？
- **對應**：worktree 策略下，只要沒人工 approve，branch/worktree 在 `~/.yep-anywhere/github-workspaces/...`，可直接丟棄；direct 策略每輪有 `diff-turnN.patch` 證據，可人工 revert；`LoopCardStore.archiveLoop` 可歸檔整個 loop。
- **缺口**：**direct 模式沒有自動回滾**；**目前沒有用戶級「丟棄某一次 run」的 API**，只能歸檔整個 loop 或手動刪文件。

### 結論
這套 loop 目前是「有人工兜底的可審計自動化工具」，還不是無人值守的生產系統。要上線，最優先要麼禁用 direct 模式、要麼補自動 revert，其次要補一個丟棄/重置單次 run 的操作入口。這些決策已定稿，見 `docs/design/loop-run-rollback-discard-design.md` 與 `docs/design/loop-direct-workspace-boundary-design.md`。

---

## 附錄：術語表與延伸閱讀

### 術語表

| 術語 | 解釋 |
|---|---|
| 冪等（idempotent） | 同一操作執行多次與一次效果相同；靠可持久化、帶時效的鍵實現。 |
| fail-closed | 故障時默認倒向更嚴格的一側。 |
| verifier theater | 形式上有驗證、實質上沒判別力的狀態。 |
| 殼子 | 定義 / 接口在，運行時無真實行為。 |
| 賬本（ledger） | append-only 的事實記錄，只存引用不存大對象。 |
| 決策賬本 | 回答「為什麼這麼決定」的賬本。 |
| 投影（projection） | 從一種形態確定性轉換成另一種形態（合約 → prompt、策略檔 → 運行時權限）。 |
| 單寫者 | 一種文件只有一個寫入口，其餘都是讀者。 |
| 原子寫 | 先寫臨時文件再 rename，讀者永遠看不到半份文件。 |
| 容錯加載 | 壞文件備份後從空開始，壞行跳過，服務不崩、痕跡保留。 |
| maker / checker | 執行者與驗證者，必須分離。 |
| 硬閘門 | bypass 下也一律升級人工的七類動作：merge/deploy/delete/publish/bill/notify/close。 |
| bypass | 自批准模式，承諾「本地、可回滾、可審計」，每次自批准落賬。 |
| golden case | 從歷史失敗衍生的回歸用例，expect=fail 如實入集，修復後人工翻轉 pass。 |
| behavior case | 直接調用被測子系統真實函數的評測用例（有牙的）。 |
| run_state | run 狀態機的磁盤快照（按 loop 存儲，注意歸屬）。 |
| pending / 待觸發隊列 | 忙時排隊的觸發請求（純記憶體、每 loop 一條）。 |
| CRDAL | 元認知共調節 agent 架構——獨立 agent 讀軌跡給戰略反饋，CMU 實證優於自評。 |

### 延伸閱讀

- `E:/projects/loop/docs/學習指南.md`：本指南的基礎教材。
- `E:/projects/loop/docs/loop-engineering/總覽.md`：概念權威。
- `E:/projects/loop/docs/spec/06-項目規定.md`：51 條偏差登記，本專案最濃縮的工程決策史。
- `E:/projects/loop/docs/loop-engineering/interview/面試問題.md`：57 題自測 + 實現實戰追問。
- `E:/projects/vibecodingByYourPhone-main/packages/server/src/loop/`：本專案全部實現。

---

> 寫在最後：Loop Engineering 的工程化思想不是 TypeScript 專屬。狀態機、冪等、fail-closed、審計、真測試，這些是任何長期運行的軟體系統都需要回答的問題。無論你寫 Java、Go 還是 Python，本質都是同一套計算機思想在不同語言和框架裡的投影。讀到這裡，請回到第 9 章的 Day 1 任務，動手打開代碼。記住一句話：**這個項目的每一行「多餘的代碼」，背後都是出錯、並發、重啟、自欺中的一種。** 能認出是哪一種，你就讀懂了。
