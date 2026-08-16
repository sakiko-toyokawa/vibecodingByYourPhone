# Loop 閉環全流程圖（含邊界條件）

> 2026-08-15，對應代碼版本：閉環中心化（`87527a7`）+ relation 人工出口
> （`ff979e4`）+ ISSUE-PROPOSAL 閘門（`4a4303d`、`0b1cf57`）之後。
> 單寫者紀律：run 狀態機 = ControlPlane；relation 狀態機 = RelationLifecycleService；
> 起 run 唯一出口 = trigger-dispatcher。

```mermaid
flowchart TD
  subgraph TRIG["觸發層：五入口 → 單出口"]
    CRON["cron 定時<br/>CronScheduler"]
    WH["GitHub webhook<br/>白名單 4 類事件 + delivery 去重"]
    POLL["RelationPoller 每 5min 補盲<br/>行內評論 / 對話區評論 / reviews / CI / head_moved"]
    HTTP["HTTP 管理口<br/>POST /loops/:id/runs"]
    TQ[("trigger queue<br/>queue.jsonl")]
    DISP["drainPendingTriggers<br/>★ 唯一起 run 出口"]
    CRON --> TQ
    WH --> TQ
    POLL --> TQ
    HTTP --> TQ
    TQ -->|"loop 空閒才放行<br/>paused 拒絕"| DISP
  end

  subgraph RUN["run 執行環：turn-loop 編排"]
    START["startRun<br/>activeByLoop 去重"]
    ASM["裝配 runtime-input<br/>prompt / 預算 / 策略投影 / relation 注入"]
    EXEC["executor turn<br/>agent session 獨立進程"]
    ART[/"runtime-events.jsonl<br/>+ stdout + 決策賬本<br/>（append-only + checksum）"/]
    VER["分層驗證 L1-L4<br/>static → subprocess → collector → agent judge"]
    JUDGE{"聚合裁決<br/>failed &gt; unverified &gt; inconclusive &gt; passed"}
    DECIDE{"control-plane decide<br/>純函數，模型不可越過"}
    DONE["complete"]
    PARK["needs_human 掛起<br/>（非終態！）"]
    RETRY["retry backoff 後開新 turn"]
    FAIL["failed / budget_limited 終態"]

    START --> ASM --> EXEC --> ART
    EXEC --> VER --> JUDGE --> DECIDE
    DECIDE -->|"passed"| DONE
    DECIDE -->|"可重試且 retries &lt; max_retries"| RETRY --> ASM
    DECIDE -->|"inconclusive / escalate / 需人工"| PARK
    DECIDE -->|"超限或死循環指紋重複 ×N"| FAIL
  end

  subgraph HUMAN["人工閘門：run 級"]
    PEND["/runs/pending 隊列<br/>HumanSlaQueuePage / 審批卡片"]
    APPROVE["approve<br/>→ continueRun 斷點續跑"]
    REJECT["reject → 終止並釋放"]
    REQCH["request_changes<br/>→ 帶反饋進下一輪"]
    SLA["SLA 三段式<br/>reminder → abandon / auto_approve_low_risk"]
    PEND --> APPROVE & REJECT & REQCH
    PEND -.->|"人一直不來"| SLA
  end

  subgraph REL["relation 閉環：RelationLifecycleService 單寫者"]
    PPA["pr_pending_approval<br/>（人工閘門）"]
    PUBPR["approve-pr<br/>gh 發 draft PR"]
    PUBISSUE["approve-issue<br/>gh issue create<br/>或 comment #N（查重改道）"]
    AR["awaiting_review"]
    AF["awaiting_feedback"]
    FIX["fixing"]
    RNH["needs_human"]
    TERM["merged / closed 終態<br/>（冪等，不再輪詢）"]
    PPA -->|"人工批准"| PUBPR --> AR
    PPA -->|"人工批准（issue 提案）"| PUBISSUE --> AF
    AR -->|"PR 不再 draft"| AF
    AF -->|"新反饋且 repair_count &lt; 3"| FIX
    AF -->|"repair_count 達 3"| RNH
    FIX -->|"run complete 回寫"| AF
    FIX -->|"run failed / run 掛起同步"| RNH
    RNH -->|"resolve=retry<br/>重置 repair 預算"| AF
    RNH -->|"resolve=close<br/>（dismissed，不復活）"| TERM
    AF & AR -->|"poller/webhook 檢測到 merged/closed"| TERM
  end

  DISP --> START
  DONE -->|"有 PR-PUBLISH 塊"| PPA
  DONE -->|"有 ISSUE-PROPOSAL 塊（兜底也識別）"| PPA
  PARK -->|"relation 同步 needs_human"| RNH
  PARK --> PEND
  APPROVE -->|"relation 轉回"| FIX
  FIX -->|"enqueue 新觸發"| TQ
  TERM -.->|"dismissed 除外：PR 重開可復活"| AF
```

## 邊界條件速查（全部確定性，無一依賴模型自覺）

| 層 | 邊界 | 行為 |
|---|---|---|
| 觸發 | loop 已有活躍 run / paused | 觸發留在隊列或被拒，不並發 |
| turn | `max_turns` / `max_time_minutes` / `max_retries` | 先到先停 → budget_limited 或 failed |
| turn | token 預算硬頂 | 超頂即 budget_limited，不可逾越 |
| 執行 | blocker fingerprint 重複 N 次 | 強制 failed（死循環熔斷） |
| 執行 | turn 空轉 10min（idle watchdog） | 標記 stagnation，升級人工 |
| 驗證 | 任一層 failed | 整體 failed（fail-closed） |
| 驗證 | judge 輸出非法 JSON | Zod 閘門攔截 → 重試一次 → inconclusive |
| 驗證 | inconclusive | 無自動路徑，只能 needs_human |
| 人工 | needs_human 掛起 | run 停在原地；relation 同步 needs_human（不假活） |
| 人工 | SLA 超時 | reminder → 按策略 abandoned / auto_approve_low_risk |
| relation | `repair_count ≥ 3` | 停止自動修復，轉 needs_human 等 resolve |
| relation | 終態（merged/closed） | poller 冪等跳過，不重複記日誌 |
| relation | 人工 dismissed | 即使 PR 重開也不復活（與 GitHub 側 close 區分） |
| 發布 | PR / issue / comment | 一律人工閘門批准後 server 執行，agent 無直達通道 |
| 提案 | publish_mode 漏配 | PR 塊、issue 塊都嘗試解析，提案不丟 |
| 恢復 | server 重啟 | 在飛 run 轉 needs_human 確認後斷點續跑 |
