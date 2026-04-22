# WebSocket Auth State Model

This document defines the server-side auth model for WebSocket connections in a way that keeps HTTP/cookie trust separate from SRP transport key state.

## Core Concepts

Three different concerns are tracked independently:

1. **HTTP auth context (upgrade request context)**
- Example: `authenticatedViaSession` from cookie middleware.
- Answers: did the HTTP upgrade request already have a valid session cookie?

2. **WebSocket admission policy (`connectionPolicy`)**
- `local_unrestricted`
- `local_cookie_trusted`
- `srp_required`
- Answers: does this connection require SRP transport auth?
- Source: `packages/server/src/routes/ws-auth-policy.ts`

3. **SRP transport auth state (`authState` + `sessionKey`)**
- `authState`: `unauthenticated` | `srp_waiting_proof` | `authenticated`
- `sessionKey`: present only after SRP success/resume success
- Answers: has an SRP transport key actually been established?
- Source: `packages/server/src/routes/ws-transport-auth.ts`

Related enforcement flag:
- `requiresEncryptedMessages`: true only for SRP-established connections.

## Canonical Scenarios

| Scenario | Entry path | `connectionPolicy` | Initial `authState` | `sessionKey` | `requiresEncryptedMessages` |
|---|---|---|---|---|---|
| Localhost/LAN, remote access disabled | `createWsRelayRoutes` | `local_unrestricted` | `authenticated` | none | false |
| Localhost/LAN, remote access enabled, valid session cookie | `createWsRelayRoutes` | `local_cookie_trusted` | `authenticated` | none | false |
| Localhost/LAN, remote access enabled, no cookie | `createWsRelayRoutes` | `srp_required` | `unauthenticated` | none | false |
| Direct encrypted WS (SecureConnection, no relay) | `createWsRelayRoutes` | `srp_required` | `unauthenticated` | after SRP | true after SRP |
| Relay encrypted WS | `createAcceptRelayConnection` | `srp_required` | `unauthenticated` | after SRP | true after SRP |
| `AUTH_DISABLED=true` dev mode | `createWsRelayRoutes` | derived only from remote-access + cookie, not bypass | depends on policy | depends on SRP | depends on SRP |

Notes:
- Relay always starts `srp_required` (`packages/server/src/routes/ws-relay.ts`).
- Local trusted paths set `authState = "authenticated"` without SRP key only when policy is trusted.
- `AUTH_DISABLED` middleware bypass is not treated as SRP-established transport auth.

## SRP Required Flow

For `connectionPolicy = "srp_required"`:

1. Start: `authState = "unauthenticated"`, `sessionKey = null`
2. `srp_hello` accepted:
- `authState = "srp_waiting_proof"`
3. `srp_proof` success or `srp_resume` success:
- `authState = "authenticated"`
- `sessionKey = <32-byte key>`
- `requiresEncryptedMessages = true`
4. Post-auth message rules:
- Plaintext rejected (`4005`)
- Encrypted envelopes required

## Trusted Local Flow (No SRP Required)

For `local_unrestricted` or `local_cookie_trusted`:

1. Open connection:
- `authState = "authenticated"`
- `sessionKey = null`
- `requiresEncryptedMessages = false`
2. Plaintext request/subscribe/upload messages are allowed.
3. Connection is treated as internally authenticated for routed app requests via `shouldMarkInternalWsAuthenticated(...)`.

## Invariants

1. `hasEstablishedSrpTransport(...)` is true only when:
- `authState === "authenticated"` and `sessionKey != null`

2. Trusted local auth (`local_*`) is distinct from SRP transport auth:
- Trusted local may be authenticated with no key.
- SRP-established auth always has a key.

3. Replay protections for two-phase resume are preserved:
- `srp_resume_init` issues server nonce challenge.
- `srp_resume` proof is challenge-bound and one-time.

## Key Code References

- Policy derivation: `packages/server/src/routes/ws-auth-policy.ts`
- Transport auth helpers: `packages/server/src/routes/ws-transport-auth.ts`
- Direct + relay entry points: `packages/server/src/routes/ws-relay.ts`
- SRP handshake/resume handlers: `packages/server/src/routes/ws-srp-handlers.ts`
- Transport auth message policy checks: `packages/server/src/routes/ws-transport-message-auth.ts`
- Frame decode + dispatch: `packages/server/src/routes/ws-message-router.ts`
