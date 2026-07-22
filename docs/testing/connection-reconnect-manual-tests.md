# Connection Reconnect Manual Test Checklist

Run through these scenarios on a real phone before releases that touch connection logic.

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| T1 | Server restart (local) | View session → restart server | Orange bar briefly, session recovers, single reconnect in console |
| T2 | Server restart (relay) | Phone via relay → restart server | Orange bar, reconnects after server up, no login redirect |
| T3 | Phone sleep 15s | Phone → lock screen 15s → unlock | Single reconnect, session catches up |
| T4 | Network toggle | Relay → airplane 5s → off | Reconnects with backoff |
| T5 | Half-open socket | Relay → kill TCP (not clean close) | Stale detection at 45s, then reconnect |
| T6 | No login redirect | Relay on /projects → kill server | Stays on /projects, orange bar |
| T7 | Auth failure | Change password → reconnect fails | Shows login form, no infinite loop |
