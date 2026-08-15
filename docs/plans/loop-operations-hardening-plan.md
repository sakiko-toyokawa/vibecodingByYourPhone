# Loop 運營硬化計劃（生產數據驅動的架構問題清單）

> 本文檔的結論全部來自 2026-08-13 對本機生產數據（`~/.yep-anywhere/loops/`：
> 26 個 github_prompt loop、其 run 狀態、artifact、relation/maintenance store）
> 的逐項審計，以及 `benchmarks/loop-runtime-eval/` 的歷史真實運行日誌。
> 與 `docs/plans/multi-turn-agentic-loop-refactor-plan.md`（解決 run 內部死鎖）
> 互為姊妹篇：那份修「run 怎麼活」，這份修「run 之上怎麼養」。

## 0. 背景

多輪重構（working state、子任務推進、驗證分流、人工閘門多輪語義）已在生產驗證：
`github-adk-pr-maintenance` run（2026-08-13）首次在真實 provider 下正確填寫
`working-state.json` 並推進子任務。單 run 內臟接近落地後，生產數據暴露的
下一層問題全部在 **run 之上**：人工閘門的 SLA、主體級目標錨點、成本遙測、
事件觸發運營化、終態善後、存儲耐久。

生產賬本（26 個 github loop）：complete 8、needs_human 2、budget_limited 3、
failed 3、discarded 3、paused 1、active 1、從未運行 3。PR 成果：
open-multi-agent#490（**merged**）、rtk-ai/rtk#3550（open）、
CopilotKit/CopilotKit#6478（draft，2026-08-13 發布）。

---

## 問題 1：人工閘門是沒有流控的瓶頸

**證據**：審計時同時有 4 個人工事項積壓（deepseek run 的重複 PR 決策 24h、
aihub-full 的發布批准 48h、agent-audit 的失敗复核 12h、restore-pr 的預算補充）；
另有 paused 15 天的 run（yeswilltest, 2026-07-29 泊入至今）。

**根因**：`needs_human` / `pr_pending_approval` / `budget_limited` / `paused`
是無時間語義的停車場。控制面設計了完善的人讀原因（human_reasons），
但沒有設計「人一直不來」的路徑：無超時、無催辦、無降級（N 天未決自動
abandon）、無優先級排序、無批量處理視圖。人工注意力是系統唯一不擴展的
資源，而設計對它的消耗無界。

**修復方向**：
- pending 事項加 `entered_at` 起算的 SLA：超時先催辦（notification），再超時
  按 card 配置的降級策略處置（auto-abandon / auto-approve-low-risk / 保持）。
- UI 提供跨 loop 的統一待辦隊列（目前已有 run-decision-required 事件，
  缺聚合視圖與排序）。
- 統計埋點：人工決策的平均響應時長進 ledger，作為後續自動化降級的依據。

## 問題 2：業務目標沒有主體級錨點——三個狀態機各說各話

**證據**：`restore-pr-google-adk`（budget_limited）與
`github-adk-pr-maintenance`（active）同時對付同一個 PR google/adk-python#6713，
互不知情；2026-08-12 二十分鐘內創建 3 個任務文本幾乎相同的 maintainer loop；
run `complete` ≠ PR 發布（aihub-full complete 兩天，PR 仍在
pr_pending_approval）≠ PR 合併（oma-490 是三態唯一收斂樣本）。

**根因**：run 狀態機、relation/maintenance store、GitHub 現實是三套割裂的
成功定義。relation 本應是主體級錨點，但建 loop 時不查重、run 啟動時不認領、
完成後不驅動下一步。「PR 合併」這個真正的業務終點沒有狀態機對它負責到底。

**修復方向**：
- 建 github loop 時按 repository/issue 查重既有 relation/maintenance target，
  UI 提示「已有 loop 覆蓋此主體」。
- run 完成（或 per-turn PR-PUBLISH 命中）後自動銜接：relation 進入
  awaiting_feedback 的同時註冊/喚醒對應 maintenance target，
  不需要人工再建維護 loop。
- 「loop 成功率」指標改以主體終態（merged/closed）計，不以 run complete 計。

## 問題 3：成本治理是擺設——遙測層斷裂使預算層失效

**證據**：所有近期 run 的 `used_tokens` 全為 0（codex/deepseek 系 adapter
不上報 usage），`max_tokens` 也全為 0（無限）；歷史真實運行單輪實測
25–33k tokens（claude），十輪 run 耗時 41.6 分鐘無任何成本攔截；
phase7 驗收項 `verifier_cost_ratio ≤ 0.30` 從未有實測值。

**根因**：預算系統的 token 維度依賴 adapter 的 usage 遙測，而該遙測在
主力 provider 橋上結構性缺失。預算強制力 = 遙測完整性。再疊加「無硬超時
（2026-07-27 決策）+ 4 分鐘心跳無限續命 + idle watchdog 靠部署者自配」，
失控 run 的成本無上限。

**修復方向**：
- codex 橋從 session jsonl / app-server 事件提取 token 用量（文件已在本地，
  不需要 provider API 支持）；無法提取時在 ledger 明寫 unavailable 而非 0。
- server 配置給 `turnIdleTimeoutMs` 出廠默認值（如 10 分鐘），而非依賴部署者。
- 補測 phase7 的 verifier_cost_ratio 並把結果納入回歸。

## 問題 4：觸發層建好了但沒運營化

**證據**：25/26 個 github loop 為 manual 觸發；adk 維護 loop 任務寫
"long-term" 卻是一次性 manual run——維護者下週留言時沒有任何東西叫醒它；
webhook 管線（5088375）與 wake_policy（targets.json 有 github_comment）
均已實現，但生產上無一次事件驅動喚醒記錄。

**根因**：系統價值主張（無人值守長期維護）依賴觸發層，但觸發層的運營閉環
（webhook endpoint 註冊、PAT scope、cron 配置、事件到 maintenance target
的路由）從未落地。引擎造好了，沒裝點火器。

**修復方向**：
- relation 進入 awaiting_feedback 時自動在 GitHub 註冊 webhook（或提供
  輪询 fallback：maintenance target 定期拉取 comments/reviews）。
- UI 在建維護類 loop 時引導選擇 wake 方式（webhook / cron poll）。
- 端到端驗收：評論測試 PR → loop 自動醒來修復，跑通才算完成
  （`benchmarks/loop-runtime-eval/run-github-pr-maintenance-flow.ts` 已備好腳手架）。

## 問題 5：機器狀態信任 LLM 自報，無交叉驗證

**證據**：working-state.json 是 executor 自報通道（fail-open 設計，
multi-turn 重構 F1）。ADK run 這次填對了，但 server 對 `clone_path` 是否存在、
`issue_number` 是否仍 open、`branch` 是否真建全盤接受。一次幻覺的
clone_path 會讓後續所有輪在錯誤目錄「繼續」——新的故障模式。
對照組：2026-08-07 interaction agent 的 Playwright JSON 自報就無法解析
（inconclusive 收場），證明自報通道的失败率非零。

**修復方向**：
- 消費端加廉價確定性驗證：clone_path 目錄存在且 `git remote get-url origin`
  與 repository 匹配，才啟用「禁止重搜」鎖定與驗證目標切換；不匹配則降級
  為提示並記錄 failure pattern。
- working_state 寫盤前跑 zod 以外的語義校驗（issue 狀態經 gh 快查），
  校驗失敗不阻塞但標注 unverified。

## 問題 6：終態沒有善後語義

**證據**：discard 的 rollback 失敗（"no diff evidence available for direct
rollback"——diff 取證目錄錯位的老問題外溢）；兩個 run 啟動 6 秒 failed
（基礎設施錯誤與任務失敗同詞彙）；3 個 loop 建了從未運行；paused 15 天
無人問津；`loops.json.corrupt-1786431810409`（2026-08-11 單文件 JSON
存儲損壞的實例）。

**根因**：run/loop 生命週期的出口側缺乏設計：無標準化 postmortem、無可靠
資源回收（worktree/clone 殘留、fork 分支）、無 loop 級 GC、存儲層單文件
JSON 的並發寫耐久性到頂。

**修復方向**：
- discard/failed 的標準善後：清理 run worktree、可選刪除 fork 分支、
  生成 postmortem artifact（含失敗归因 failure_tags）。
- loop 級歸檔/GC 策略（archived 標誌已存在但無消費者）。
- loops.json 遷移到與 targets.json 相同的 store 模式或加寫入鎖；
  corrupt 自動恢復已有先例，需補監控告警。

## 問題 7：基準設施不閉環

**證據**：phase7 結果（2026-08-08）只有性能微指標（state log p95 ✓），
「4 個 full-chain 場景真實完成」無記錄；benchmark 默認 mock supervisor；
全部手動執行無 CI；歷史上 3 次 github 真實 run 掛起 25+ 分鐘才由
harness 超時殺掉（watchdog 未配）。

**修復方向**：
- 把「一次真實 github loop E2E」做成可重複腳本（小任務、watchdog 必配、
  硬頂輪次），納入回歸；產出存檔為基準樣本。
- benchmark 冒煙進 CI（至少 mock 層 + artifact 完整性斷言）。

---

## 被生產數據證明正確的決策（不要回退）

1. **hard gate 升級真判斷**：deepseek run 的重複 PR #6461 檢查攔下了
   一次可能的外交事故；`publishDraftPr` 的 verified-identity 檢查攔下了
   executor 的邮箱笔误提交（zhapodanshushu@）——fail-closed 在該硬的地方是硬的。
2. **working state 通道**：首次生產使用即被真實 LLM 正確填寫，
   子任務推進首次在生產跑通（ADK run, 2026-08-13）。
3. **relation/maintenance store 雙層持久**：targets.json 落盤正確
   （relation API 數據與磁盤一致）。
4. **四層反死循環防禦**（blocker/output/diff hash + 預算硬頂）：
   i-will-test-the-ui 的 discovery 死循環是被 blocker fingerprint 機制
   逼停的，而非無限空轉。

## 優先級路線圖

| 序 | 問題 | 理由 |
|---|---|---|
| P0 | #4 觸發運營化 | 直接決定在跑的 adk 維護 loop 下週死不死；價值主張的咽喉 |
| P0 | #1 人工閘門 SLA | 積壓已在發酵（本次審計親手清了 2 件） |
| P1 | #3 成本遙測 | 無成本可見性就不敢放大自動化 |
| P1 | #2 主體級錨點 | 消除重複 loop / 目標漂移，讓 PR 合併成為唯一成功定義 |
| P2 | #5 自報交叉驗證 | 新故障模式的預防，廉價 |
| P2 | #6 終態善後 + #7 基準閉環 | 運營衛生與回歸基礎設施 |

每個 P0/P1 項目的具體實現方案在動工前另立任務書（參照
`multi-turn-agentic-loop-refactor-plan.md` 的格式：因果證據 → 修改點
（file:line）→ 測試 → 驗收）。
