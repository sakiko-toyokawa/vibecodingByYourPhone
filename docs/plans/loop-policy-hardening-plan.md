# Loop Policy Hardening Plan

> 狀態：執行中；P1、P2、P3、P5 已完成，P4 已做 collector 可讀改進，
> P6 已有 publish/draft-pr route 與測試，P7 已加 verifier JSON repair +
> corrective retry
> 觸發：`github-aihub-full-20260810141141` 真實 GitHub loop 跑通後暴露
> 的 policy 誤判、evidence 讀取、handoff 一致性和 GitHub PR lane 問題。

## 背景

本次真實 loop 已跑通完整鏈路：

```text
loop: github-aihub-full-20260810141141
run:  run-20260810T070611Z-0aa79800
state: complete
```

agent 找到 `JSONResponse` 未 import 的 bug、完成本地修復與 commit、產生
PR-ready summary，也產出了 `runtime-events`、`permission-events`、
`machine-state`、`turn-handoff`、collector/judgment/verifier report。

但同一次 loop 也暴露了幾個需要修復的流程問題：

1. PowerShell 區塊內的分號被當成頂層命令分隔符，`Stop-Process` cleanup
   被誤判成 high-risk，造成一次不必要的 `needs_human`。
2. run 最終 `complete`，但 ledger 仍帶 `failure_tags: ["policy_error"]`，
   會污染 learning / failure-pattern。
3. collector / policy reviewer 無法可靠讀取 server 側 artifacts。
4. `human-report.md` 和 handoff 在終態後仍引用 `needs_human` 與前一個
   turn 的 artifacts。
5. `github_prompt` 目前止步於 local commit + PR-ready summary，沒有實際
   push / PR lane。

## 已修復

`classify.ts` 的命令分段已從裸 regex split 改為 shell-aware scanner：

- 識別 PowerShell wrapper，只對 PowerShell 追蹤 `{}`、`()`、`[]` 深度。
- 引號內的分隔符不再切段。
- `2>&1` 中的 `&` 不再被當成背景運算子。
- 保留 Bash 原有複合命令切段語意。

P1 已修：

- `review_or_policy` 高風險升級不再自動掛 `policy_error`；只有真正 hard
  gate 或 adapter permission error 才歸因。
- 人工 approve / resume 後，最終 complete run 不會再把這次 reviewable
  escalation 當成失敗模式。

P3 已修：

- `classify.ts` 接收 Codex `commandActions` 結構化提示。
- 確定性硬閘門 / 黑名單檢查之後，`read` / `listFiles` / `search` 才可將
  命令降為 low；`unknown` 不降級。

P2 已修：

- OS temp 被視為允許的 scratch 寫入根，不再當成 workspace 外高風險寫入。
- 硬閘門與 high-risk 黑名單仍先執行，temp allow 不會放開破壞性命令。

P4 已做：

- collector input bundle 帶入 artifacts 絕對目錄。
- collector session 增加該 run artifacts 目錄的 `Read/Glob/Grep` allow
  rule，並在 prompt 禁止用 Bash 列 server 目錄。

P5 已修：

- human-report 的執行結果狀態改用 `runStateRecord.state`，不再讀前一輪
  ledger entry 的舊 `final_status`。
- refs 改引用當前 judgment / run state，不再引用 needs_human 舊 artifacts。

新增回歸測試覆蓋：

```text
powershell semicolons inside blocks are not top-level separators
top-level Stop-Process is still high risk
Codex commandActions only downgrade after deterministic checks
review_or_policy high-risk escalation does not auto-tag policy_error
```

驗證：

```powershell
pnpm exec tsx --test packages/server/src/loop/policy/classify.test.ts
pnpm exec tsx --test packages/server/src/loop/policy/arbiter.test.ts packages/server/src/loop/policy/approval-hook.test.ts packages/server/src/loop/policy/classify.test.ts
pnpm exec tsc --noEmit -p packages/server/tsconfig.json
pnpm exec biome check packages/server/src/loop/policy/classify.ts packages/server/src/loop/policy/classify.test.ts
```

## 修復項目

### P1. Policy escalation 不應在人工批准後仍記為失敗

問題：

- policy 將 benign `%TEMP%` diagnostic 升到 `needs_human`。
- 人工批准後 run 繼續並 `complete`。
- 但最終 ledger 仍寫 `failure_tags: ["policy_error"]`。

修法：

- 只有未批准、被 deny、或 run 因此終止時，才歸因 `policy_error`。
- 人工 approve / resume 後，應把該 escalation 記為
  `human_override` 或只保留 audit，不進入 failure tags。
- 補測試：`policy_blocked -> needs_human -> approve -> complete` 的最終
  ledger 不帶 `policy_error`。

### P2. 明確定義 runtime scratch / temp 目錄

問題：

- agent 用 `$env:TEMP` 放 `PYTHONPYCACHEPREFIX` 和 import diagnostic。
- 目前被視為 workspace 外寫入，容易誤升級。

修法：

- 在 contract security level 中增加 `scratch_roots` 或
  `allowed_temp_dirs`。
- `workspace_write` 的 native sandbox 與 policy 同時允許
  `%TEMP%` / 系統 temp，但仍禁止 `/etc`、其他 user 目錄。
- classifier 能識別 `Join-Path $env:TEMP ...`、`$env:TEMP` 和
  `PYTHONPYCACHEPREFIX`，不再當 unknown。

### P3. 用結構化 command metadata 取代脆弱 regex

問題：

- 即使本次修了 PowerShell block，整體仍是以字符串 regex 為主的黑名單。
- 未來的 shell 語法、引號、here-string、command substitution 仍可能誤判。

修法：

- Codex approval request 已提供 `commandActions` /
  `proposedExecpolicyAmendment`，應優先使用結構化分類。
- regex / state machine 只作為 fallback。
- 新增 parser corpus：引號、`{}`、`$()`、`@()`、`2>&1`、here-string、
  PowerShell `if/else`、Bash compound。

### P4. Collector / reviewer 可讀 server artifacts

問題：

- collector 的 read-only plan session 讀 `C:\Users\admin\.yep-anywhere`
  被 policy 拒絕。
- 最後 collector 只能直接看 workspace，證據鏈較弱。

修法：

- 為 collector / policy reviewer 增加 read-only roots：
  `dataDir/artifacts/<runId>`、`dataDir/github-workspaces/...`。
- 寫入仍保持 hard gate。
- 或新增 read-only artifact API，讓 collector 經 server 讀取。
- 補 full-chain 測試：collector 能讀到 manifest / stdout / handoff。

### P5. 終態 handoff / human-report 一致性

問題：

- run 最終 `complete`，但 `human-report.md` 仍寫
  `turn 6 / needs_human`，並引用 turn5 artifacts。

修法：

- terminal transition 完成後重寫 handoff / human-report，使用最終
  `run_state`、`last_judgment`、collector report。
- 新增一致性 validator：
  - `run_state.state == complete`
  - handoff 引用的 judgment == `last_judgment`
  - handoff 不引用 needs_human 階段的舊 artifacts。

### P6. GitHub PR lane

問題：

- `github_prompt` 目前只到 local commit + PR-ready summary。
- 若要真正模擬 GitHub 流程，還需要一個人工或 publish lane。

修法：

- 保留 agent 不得直接 `gh pr create` / `git push` 的 hard gate。
- 提供明確的 `POST /api/github/publish/draft-pr` 流程：
  - run 產出 repository、branch、title、body、cwd。
  - 人工 approve 後才建立 draft PR。
- 補 route 測試與真實 PAT 整合測試。

### P7. Verifier Agent JSON 輸出 recovery

問題：

- `github-agent-pr-practice-20260811` 的 turn 3 verifier agent 回覆 prose，
  不是 JSON；現行 parse 只做單次降級 inconclusive + escalate，造成不必要
  的 `needs_human` 與最終 `verification_error` 殘留。

修法：

- `parse.ts` 增加常見 malformed JSON repair：先嘗試 fenced block / object
  slice，再移除 trailing comma，最後才進入 Zod。
- `run-verifier-agent.ts` 改成最多兩次 attempt：第一次輸出無效時，把
  Zod validation error 與原始輸出帶回 corrective prompt，重新生成一次。
- retry 輸出獨立落盤為 `verifier-agent-output-*-retry1.log`，兩次都失敗時
  才回 `inconclusive + escalate`。
- 測試覆蓋 prose 輸出觸發 retry、retry 成功、retry 仍失敗保留兩次證據。

參考：Pi / LLM structured output 常見 recovery pattern 是
`parse -> validate -> repair -> retry with validation error`，不是第一次
失敗就直接把控制面推到人工。

## 執行順序

1. P1：修 failure tag 歸因，避免污染 learning。
2. P3：先接入 Codex `commandActions` 結構化分類，降低 parser 誤判。
3. P2：把 temp / scratch 路徑寫進 contract 與 sandbox projection。
4. P4：修 collector / reviewer artifact 讀取。
5. P5：修 terminal handoff 一致性。
6. P6：補 GitHub publish lane，讓 loop 可以在人工核准後真正開 PR。
7. P7：verifier agent JSON 輸出先 repair / retry，再考慮人工。

## 驗收標準

- 用本次 `run-20260810T070611Z-0aa79800` 的實際 tool input 做 regression，
  diagnostic 指令應分類為 medium，不進 `needs_human`。
- 人工批准後的 complete run 不再帶 `policy_error` failure tag。
- 完整 loop 產出的 handoff / human-report 與 final state 一致。
- collector / reviewer 可以讀取 server 側 artifacts。
- 如啟用 GitHub publish lane，人工 approve 後能用 PAT 建立 draft PR。
- policy 相關 unit tests、typecheck、biome check 全部通過。
