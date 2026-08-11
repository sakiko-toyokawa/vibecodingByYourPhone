# Loop Verifier 擴展設計

> 狀態：核心已實作（2026-08-09）：L4 輸入上限、structural plugin 介面、Python/Rust checker、review.judge_only
> 日期：2026-08-09
> 優先順序：P2

## 一、背景與現狀

Verifier 已具備 static / runtime / rule / structural / interaction / review 六段。structural 目前以 TypeScript 為主，review 是 collector + Verifier Agent 兩次 LLM 調用，L4 輸入包還沒有明確上限。

## 二、設計決策

### 2.1 Structural Checker 插件介面

- 定義 checker 介面，輸入為 workspace、target files、artifacts，輸出統一 `CheckerOutcome`。
- TypeScript checker 是 v1 唯一必須支援 checker。
- Python / Rust 以插件規格定義，不承諾 v1 實作；未實作語言維持 `inconclusive + escalate`。

### 2.2 L4 輸入包上限

- 文字證據預設上限 64,000 chars。
- 超過上限時用 artifact ref / sha256 取代原始內容，並在 prompt 中標示 `truncated`。
- diff 與 report 依重要性排序：需求、judgment、L1-L3 report、diff、stdout。

### 2.3 Collector 與 Judge 合併

- 短期維持 collector + judge 兩次 LLM 調用，不改既有 review 行為。
- 設計 `judge_only` 模式：由 Verifier Agent 一次完成證據採集與 verdict，collector 僅在 judge 不可用時 fallback。
- `judge_only` 預設關閉；只有 benchmark 證明成本與品質不劣化後才切為預設。

### 2.4 Adversarial Sample 累積

- Verifier Agent 產生的 adversarial risk 進入 `failure-pattern` 賬本。
- 以 `adversarial:` 前綴保留目前標記，不另造 schema。
- 累積樣本後可設計 regression eval，但不在 v1 承諾。

## 三、介面與資料流

```text
StructuralStrategy
  -> checker plugin registry
  -> TypeScriptChecker (v1)
  -> Python/Rust plugin (future)

ReviewStrategy
  -> collector + judge (default)
  -> judge_only (opt-in)
```

## 四、邊界與失敗模式

- 無適用 checker：不 vacuous pass。
- L4 輸入過大：截斷後仍可驗證，但 evidence 保留完整 artifact。
- judge 輸出無效：維持 `inconclusive + escalate`。
- judge_only 與 collector 同時可用：優先 judge_only；judge 失敗才 fallback collector。

## 五、驗收標準

- TypeScript structural 行為不變。
- 新增 checker plugin 不需改 aggregate / control-plane。
- L4 輸入超過上限時不會爆 token，且 artifact 仍可追溯。
- `judge_only` 在 benchmark 中可對比 collector + judge 的成本與品質。
