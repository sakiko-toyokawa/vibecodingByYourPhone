# Loop Sandbox Security Architecture

> 狀態：已實作核心（2026-08-10）
> 日期：2026-08-10

## 一、決策

Loop 的安全模型不再以「命令正則 + 風險分級」當主體。主體改成：

```text
IntentContract.security_level
  -> runtime native permission / sandbox
  -> policy arbiter（allow / deny / hard_gate）
  -> independent review agent（review_or_policy）
  -> audit + post-run verifier
```

Agent 仍舊是黑箱 runtime；外層控制面只負責把合約投影成原生權限、在邊界處
裁決、並在需要時交給獨立審查。控制面不替 agent 決定它要做什麼。

## 二、合約安全等級到原生投影

| security_level | PermissionMode | Codex sandbox | Policy hook approval |
|---|---|---|---|
| `read_only` | `plan` | `read-only` | `untrusted`（hook 存在時） |
| `workspace_write` | `default` | `workspace-write` | `untrusted`（hook 存在時） |
| `full_access` | `bypassPermissions` | `danger-full-access` | `untrusted`（hook 存在時） |

Claude bridge 沒有 OS sandbox，`sandbox` 如實記為 `none`，工作區邊界由
`canUseTool` policy hook、worktree/direct allowlist 和 post-run verifier
共同保證。Codex bridge 保留原生 sandbox，但 policy hook 存在時使用
`untrusted`，確保 file/command 動作仍會發 approval request 到 loop
arbiter，而不是被原生模式自動放行。

## 三、Policy arbiter 的角色

`classify.ts` 只負責把工具調用分類成 low / medium / high / critical 與
硬閘門，不再試圖完整理解每個 shell 命令。默認未命中黑名單的命令為
medium，本機、可回滾、工作區內動作可自批准；只有硬閘門、工作區越界寫、
明確高風險黑名單才會升級。

本機 `git branch -D` 是 managed workspace 內的分支清理，不是 delete 硬閘門；
外部/不可逆刪除仍保留硬閘門。

## 四、獨立審查

`review_or_policy` 命中時，approval hook 啟動一個獨立 read-only session：

- 全新 session，不帶 maker transcript。
- plan mode，Read/Grep/Glob 可用；Edit/Write/Bash 直接 deny。
- 輸入只含 contract、工具調用摘要、workspace 路徑；token/secret 會被遮罩。
- 輸出嚴格 JSON，解析失敗視為 `hard_gate`。
- allow 仍要落 `bypass_used` 審計；deny 直接拒絕；hard_gate 升級人工。
- reviewer 不可用或失敗時 fail-closed，回到 hard_gate。

## 五、不變式

1. 合約安全等級是權限投影的源頭，policy 不能獨立繞過它。
2. 原生 sandbox 是最後一道 OS 邊界，但不是唯一安全層。
3. 獨立審查是「不信任 maker 自評」的擴充，不是讓 maker 自己確認自己。
4. 所有 allow/hard_gate 都寫決策賬本；deny 寫 permission events。
5. post-run verifier 繼續用 diff、runtime events、permission events 檢查
   實際副作用。

## 六、相關實作

- `packages/server/src/loop/assembly/runtime-permission.ts`
- `packages/server/src/loop/policy/reviewer.ts`
- `packages/server/src/loop/policy/arbiter.ts`
- `packages/server/src/loop/policy/approval-hook.ts`
- `packages/server/src/sdk/providers/codex.ts`
