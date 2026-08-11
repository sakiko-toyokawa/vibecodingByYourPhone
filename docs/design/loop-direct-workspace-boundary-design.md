# Loop Direct 工作區邊界設計

> 狀態：已實作（2026-08-09）
> 日期：2026-08-09
> 優先順序：P0

## 一、背景與現狀

`workspace.strategy` 有 `worktree` 與 `direct` 兩種。worktree 已提供 run 級隔離；direct 直接操作使用者原始目錄，雖然 policy 對 Bash 有寫目標偵測，但並非完整 sandbox，模型仍可能改到任務外檔案。

## 二、設計決策

### 2.1 Direct 預設唯讀

- 沒有明確 mutation policy 的 direct loop 只能在 `plan` / read-only 模式執行。
- 需要在 direct 模式下寫檔案的 loop 必須宣告 `policy.profile`，且該 profile 內含 `allow_direct_mutations: true`。
- worktree 仍是 mutating loop 的預設策略；direct mutation 是明確 opt-in。

### 2.2 任務內寫入 allowlist

- 從 `IntentContract.target.files` 產生 direct 模式的工作區寫入 allowlist。
- `target.files` 未明確列出時，不允許 direct mutation。
- policy approval hook 對 allowlist 外的 workspace write / edit / bash 寫目標回傳 `policy_error`。
- 允許相對路徑與目錄前綴；不允許 `..` 逸出 workspace root。

### 2.3 Bash 二道防線

- 保留現有 `classify.ts` 對重定向、`tee`、`cp`、`mv`、`sed -i`、`node -e` 等寫目標的偵測。
- direct mutation allowlist 與 Bash 寫目標同時成立才允許自批准。
- 任一檢查無法判斷時升級人工，不靜默放行。

## 三、介面與資料流

```text
IntentContract.target.files
  -> assembly resolveDirectWriteAllowlist
  -> policy approval hook
  -> executor write / edit / bash
  -> outside allowlist => policy_blocked
```

## 四、邊界與失敗模式

- direct loop 沒有 mutation policy：run 在 assembly 階段 fail-closed。
- target 解析不出 allowlist：不允許寫入。
- 工具回報的相對路徑有 `..`：拒絕。
- Bash 寫目標無法解析：升級人工。
- 使用者仍想用 direct mutation：必須明確設定 `allow_direct_mutations`，且 UI 標示風險。

## 五、驗收標準

- direct read-only run 完全不能寫 workspace。
- direct mutation 只允許 `target.files` 內檔案與目錄。
- allowlist 外 Edit / Write / Bash 寫入均產生 policy evidence。
- worktree loop 不受此 allowlist 限制，維持既有 merge gate。
