# Loop 生產就緒設計索引

> 狀態：設計定稿，核心已實作（2026-08-09）
> 日期：2026-08-09

## 目的

這份索引串起 Loop 從「有人工兜底的可審計自動化工具」走向「可安全上線」所需補齊的設計缺口。每份文件都以現有 schema 與 backend 實作為事實源，先鎖定決策，後續實作不需要再猜。

## 缺口總覽

| 編號 | 缺口 | 優先順序 | 設計文件 |
|---|---|---|---|
| D1 | Run 回滾 / 丟棄合約 | P0 | `loop-run-rollback-discard-design.md` |
| D2 | Direct 工作區邊界 | P0 | `loop-direct-workspace-boundary-design.md` |
| D3 | Executor 空產出偵測 | P0 | `loop-empty-output-detection-design.md` |
| D4 | Restart 防護 | P1 | `loop-restart-protection-design.md` |
| D5 | Token / Provider 成本熔斷 | P1 | `loop-token-quota-breaker-design.md` |
| D6 | Trigger 擴展 | P1 | `loop-trigger-expansion-design.md` |
| D7 | Verifier 擴展 | P2 | `loop-verifier-extension-design.md` |
| D8 | Sandbox 原生權限 + 獨立審查 | P0 | `loop-sandbox-security-architecture.md` |

## 依賴關係

- D1 與 D2 共用 workspace 安全語義：D2 決定 direct 模式何時可寫，D1 決定寫入如何被 run 級回滾。
- D3 影響 verifier aggregate 與 control-plane 的 `complete` 判定，應先於任何新 retry 成本設計。
- D4 依賴 run state 與 restart recovery；設計上不能破壞 D1 的 discarded 終態。
- D5 與 D3 共用 `ExecutionOutcome`，不另造重複的用量模型。
- D6 只新增 trigger 面，不改變 run 內部狀態機。
- D7 是 verifier 品質與成本設計，與 D3 的證據口徑互補。
- D8 把合約安全等級投影為原生 sandbox/permission，並把 review_or_policy
  交由獨立 read-only reviewer；它不改變狀態機，只取代 classify 作為主安全層。

## 回寫範圍

- `docs/plans/loop-spec-gap-fix-plan.md`：backlog 改為指向各設計文件，移除已過時描述。
- `docs/loop-engineering-java-interview-guide.md`：生產就緒缺口清單更新為「已有設計，核心已實作」。
- `docs/design/layered-verifier-design.md`：修正 `interaction / review` 已非 placeholder 的現況。

## 實作順序建議

1. D1 + D2：先定 workspace 安全契約，才能安全推出 run 級回滾。
2. D3：補上驗證層空產出訊號，避免錯誤 `complete`。
3. D4：避免開發者重啟服務時無意中斷 active run。
4. D5：補成本熔斷。
5. D6：擴展 trigger。
6. D7：最後做 verifier 擴展與成本優化。
