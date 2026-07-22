# /login Flow for Yep Anywhere

## Problem
- `/login` is a CLI-only command, not available through the SDK
- When auth expires (401), users are stuck if they can't SSH to the server
- Need to support re-authentication from the Yep Anywhere UI

## Solution Overview
Use tmux to run an interactive Claude CLI session, send `/login`, capture the OAuth URL, and relay it to the user.

## Prerequisites
- tmux must be installed on the server
- Detection if tmux is not available → show error message with instructions

## Verified Flow (from manual testing)

The `/login` command is interactive:
1. Send `/login` + Enter
2. Shows menu: select `1` for "Claude account with subscription"
3. CLI outputs OAuth URL (long, spans multiple lines)
4. CLI prompts: "Paste code here if prompted >"
5. User visits URL in browser, authorizes, gets redirected with auth code
6. User pastes auth code back into CLI
7. Auth completes

**Note:** This is NOT a device flow with a short code. It's a full OAuth redirect where the user must copy a long authorization code from the browser callback URL.

## Flow Diagram

```
User sends "/login"
        ↓
Server intercepts (doesn't send to SDK)
        ↓
Check if tmux is installed
        ↓ (no)                    ↓ (yes)
Show error:                  Start tmux session
"tmux not installed"         `tmux new-session -d -s yep-login 'claude'`
                                    ↓
                             Send `/login` + Enter
                             `tmux send-keys -t yep-login '/login' Enter`
                                    ↓
                             Wait ~2s, send '1' to select Claude account
                             `tmux send-keys -t yep-login '1'`
                                    ↓
                             Poll tmux output for URL
                             `tmux capture-pane -t yep-login -p`
                             Parse URL from "https://claude.ai/oauth/..."
                                    ↓
                             Emit SSE event: { eventType: "login-required", url }
                                    ↓
                             Client shows LoginModal
                             - Displays URL (clickable link)
                             - Text input for auth code
                             - "Submit Code" button
                             - "Cancel" button
                                    ↓
                             User visits URL, authorizes in browser
                             Browser redirects with code in URL
                             User copies code from URL
                                    ↓
                             User pastes code in modal, clicks Submit
                                    ↓
                             Server sends code to tmux session
                             `tmux send-keys -t yep-login 'AUTH_CODE' Enter`
                                    ↓
                             Poll for success/failure in output
                                    ↓
                             Cleanup tmux session
                             `tmux kill-session -t yep-login`
                                    ↓
                             Emit success/failure event
                                    ↓
                             Client dismisses modal
```

## Implementation Phases

### Phase 1: Server-side tmux login service
- [ ] Create `packages/server/src/auth/claude-login.ts`
  - `checkTmuxAvailable(): Promise<boolean>`
  - `startLoginFlow(): Promise<{ url: string, code: string } | { error: string }>`
  - `checkLoginComplete(): Promise<boolean>`
  - `cleanup(): void`
- [ ] Add unit tests with mocked tmux commands

### Phase 2: API endpoint for login flow
- [ ] Add routes to handle login flow (could be in main API or maintenance)
  - `POST /api/claude-login/start` - starts flow, returns URL/code
  - `GET /api/claude-login/status` - checks if auth succeeded
  - `POST /api/claude-login/cancel` - cleanup if user cancels
- [ ] Or: emit as SSE events on session stream

### Phase 3: Intercept /login in message handling
- [ ] In session message handler, check if message starts with `/login`
- [ ] If so, don't send to SDK, trigger login flow instead
- [ ] Emit SSE event to client with URL/code

### Phase 4: Client LoginModal component
- [ ] Create `packages/client/src/components/LoginModal.tsx`
  - Shows URL as clickable link
  - Shows code prominently
  - "Done" button to check completion
  - "Cancel" button to abort
  - Loading state while checking
- [ ] Add CSS styles

### Phase 5: Wire up client to handle login events
- [ ] Handle `login-required` SSE event in useSession or SessionPage
- [ ] Show/hide LoginModal based on state
- [ ] Handle success/failure responses

### Phase 6: Error handling and edge cases
- [ ] tmux not installed → clear error message
- [ ] Login times out → cleanup and show error
- [ ] User cancels → cleanup tmux session
- [ ] Already logged in → show "already authenticated" message
- [ ] Multiple concurrent login attempts → prevent/queue

## Tmux Commands Reference

```bash
# Check if tmux is installed
which tmux

# Start detached session running claude
tmux new-session -d -s yep-login 'claude'

# Send /login command
tmux send-keys -t yep-login '/login' Enter

# Wait, then select option 1 (Claude account)
sleep 2
tmux send-keys -t yep-login '1'

# Capture pane output
tmux capture-pane -t yep-login -p

# Kill session
tmux kill-session -t yep-login

# Check if session exists
tmux has-session -t yep-login 2>/dev/null && echo "exists"
```

## Parsing Login Output

The actual output (verified) looks like:
```
 Browser didn't open? Use the url below to sign in:

https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=http
s%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Ases
sions%3Aclaude_code&code_challenge=rFABFSUC0j0lEHfEi2b4cUW3AMEPJ9DmOPcWbEpIwBU&code_challenge_method=S256&state=ein23Aey36O0sjh
11tC-ZiAQgScPyCU96pEmOrbAF8Y


 Paste code here if prompted >
```

**Key observations:**
- URL starts with `https://claude.ai/oauth/authorize`
- URL spans multiple lines due to terminal width
- Need to reconstruct URL by joining lines (no spaces between them)
- Prompt "Paste code here if prompted >" indicates ready for code input
- No ANSI escape codes in the URL portion (plain text)

## Open Questions

1. Should login be per-session or global? (Probably global since it's the same server)
2. What if user is already logged in? Check credentials first?
3. Timeout duration for login flow? (5 minutes?)
4. Should we show auth status somewhere in the UI proactively?

## Testing

- Manual testing with real tmux
- Mock tmux commands for unit tests
- E2E test would need tmux available
