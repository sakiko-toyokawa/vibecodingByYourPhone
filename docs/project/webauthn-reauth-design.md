# WebAuthn Re-authentication Layer

## Problem

Browser extensions are the primary realistic attack surface for Yep Anywhere relay connections. Extensions can:

- Read localStorage (where SRP session keys are stored)
- Intercept fetch/XHR and WebSocket traffic
- Access cookies (even HttpOnly, with `cookies` permission)
- Keylog password entry
- Make same-origin requests with ambient credentials

A malicious or compromised extension could steal an SRP session key, connect to the server through the relay, and gain full access to Claude agents with file system and shell access.

Current mitigations (strong CSP, SRP zero-knowledge auth, NaCl E2E encryption) protect against XSS and relay-level snooping, but not against in-browser extension-level threats.

## Threat Model

**Attacker:** Malicious browser extension on desktop, with broad permissions (storage, cookies, webRequest).

**What they can steal:** SRP session key from localStorage, allowing them to establish an authenticated, encrypted connection to the server through the relay.

**What they get:** Full access — read all session history (code, secrets, terminal output), send messages, approve tool use (file writes, shell commands, git operations).

**What they cannot do:** Produce a WebAuthn assertion. Private keys are hardware-bound (Secure Enclave, TPM, or external security key). The browser mediates the ceremony at OS level; extensions cannot extract or forge credentials.

**Scope:** Desktop browsers only. Mobile browsers do not support extensions, so mobile relay access is not affected.

## Design

### Overview

An opt-in WebAuthn layer on top of existing SRP authentication. SRP continues to handle identity and encryption. WebAuthn provides periodic physical-presence proof that an extension cannot forge.

When enabled, the **server** gates all data flow (not just writes — reads too) behind fresh WebAuthn verification. A stolen SRP session key yields an encrypted tunnel to nowhere until the real user touches their fingerprint reader.

### Session States

```
SRP valid + WebAuthn fresh       → full access
SRP valid + WebAuthn stale       → connection held open, no data flows
SRP valid + WebAuthn not enrolled → full access (legacy behavior)
```

"Stale" means `now - lastVerified > reauthInterval`. The server stops sending any messages (including session history, streaming output, status updates) until re-verification succeeds. The client shows a lock screen.

This is critical: **read access is not safe either**. Session history contains code, secrets, terminal output. A stale session must be fully starved, not degraded to read-only.

### Why the Server Controls This

The relay is a dumb encrypted pipe and must stay that way. The server (dev machine) is what's at risk — it runs Claude with file and shell access. The server:

- Stores WebAuthn public keys
- Generates challenges
- Verifies assertions
- Enforces the re-auth interval
- Gates data flow

All WebAuthn ceremony traffic flows through the existing SRP-encrypted relay connection. The relay sees only encrypted bytes.

### WebAuthn Relying Party

For relay connections, the RP origin is `yepanywhere.com` (the relay). This is correct because:

- `navigator.credentials.create/get()` runs in the browser against the page origin
- The server receives and verifies the signed assertion, but doesn't need to be the RP
- Server-side verification checks the signature and challenge match, not the origin
- One credential enrollment works for all hosts accessed through the relay

For direct connections (LAN/Tailscale), this feature is not prioritized — the threat model is weaker on trusted networks.

### Per-Host Configuration

Each host (server) independently controls its WebAuthn requirements. Since multiple hosts are accessed through the same relay, each host stores its own:

- Whether WebAuthn is required for this connection
- The public key and credential ID
- The re-auth interval
- The last verification timestamp

The client stores a lightweight flag per host indicating WebAuthn is enrolled (to show correct UI), but the server is authoritative.

## Protocol

### New SRP Message Types

```typescript
// Server → Client: demand re-verification
type SrpWebAuthnChallenge = {
  type: "webauthn_challenge";
  challenge: string;          // base64, 32 random bytes
  credentialId: string;       // base64, which credential to use
  rpId: string;               // "yepanywhere.com"
  timeout: number;            // ms, suggested timeout for ceremony
};

// Client → Server: signed assertion
type SrpWebAuthnResponse = {
  type: "webauthn_response";
  credentialId: string;       // base64
  authenticatorData: string;  // base64
  clientDataJSON: string;     // base64
  signature: string;          // base64
};

// Server → Client: verification result
type SrpWebAuthnResult = {
  type: "webauthn_result";
  success: boolean;
  nextChallengeAt?: string;   // ISO timestamp, when next re-auth is needed
};
```

### Registration Flow (One-Time Setup)

```
1. User checks "Enable biometric verification" on login screen
2. Client calls navigator.credentials.create({
     publicKey: {
       rp: { id: "yepanywhere.com", name: "Yep Anywhere" },
       user: { id: <hostId>, name: <username>, displayName: <hostDisplayName> },
       challenge: <from server>,
       pubKeyCredParams: [
         { alg: -7,  type: "public-key" },  // ES256
         { alg: -257, type: "public-key" }   // RS256
       ],
       authenticatorSelection: {
         authenticatorAttachment: "platform",  // built-in (Touch ID, Windows Hello)
         userVerification: "required"
       }
     }
   })
3. Client sends credential public key + ID to server (encrypted, through relay)
4. Server stores in remote-sessions.json alongside the SRP session
5. Server begins enforcing re-auth interval for this session
```

### Re-authentication Flow

```
1. Server timer fires: session.lastVerified + reauthInterval < now
2. Server sends SrpWebAuthnChallenge (encrypted, through relay)
3. Server stops sending any other messages to this session
4. Client shows lock screen: "Touch ID required to continue"
5. Client calls navigator.credentials.get({
     publicKey: {
       challenge: <from server>,
       rpId: "yepanywhere.com",
       allowCredentials: [{ id: <credentialId>, type: "public-key" }],
       userVerification: "required"
     }
   })
6. Client sends SrpWebAuthnResponse (encrypted, through relay)
7. Server verifies signature against stored public key
8. Server updates lastVerified, resumes data flow
9. Server sends SrpWebAuthnResult with nextChallengeAt
```

### Initial Authentication

On connection (after SRP completes), if the session has WebAuthn enrolled:

```
1. SRP handshake completes → encrypted tunnel established
2. Server immediately sends SrpWebAuthnChallenge (no data flows yet)
3. Client performs WebAuthn ceremony
4. Server verifies → data begins flowing
```

This means a stolen SRP session key never gets any data, even on first connect.

## UI

### Login Screen

```
┌──────────────────────────────────┐
│ [host selector: dev-machine ▾]   │
│                                  │
│ Password: [••••••••••]           │
│                                  │
│ [x] Remember session             │
│ [ ] Enable biometric verification│
│     └─ Re-verify every [15m ▾]  │
│                                  │
│         [Connect]                │
└──────────────────────────────────┘
```

First time the checkbox is checked → triggers WebAuthn registration.

After enrollment:

```
│ [x] Require biometric (Touch ID) │
│     └─ Re-verify every [15m ▾]  │
│     [Remove biometric ×]         │
```

Re-verify intervals: 15 min, 30 min, 1 hour, 4 hours.

### Lock Screen (Re-auth Required)

```
┌──────────────────────────────────┐
│                                  │
│         🔒 Session Locked        │
│                                  │
│   Touch ID required to continue  │
│                                  │
│       [Verify Identity]          │
│                                  │
│  Agent is still running.         │
│  Your session will resume after  │
│  verification.                   │
│                                  │
└──────────────────────────────────┘
```

The agent keeps running server-side. Only the data stream to this client is gated.

## Storage

### Server-Side (remote-sessions.json)

```json
{
  "sessions": {
    "sid_abc123": {
      "sessionId": "sid_abc123",
      "username": "alice",
      "sessionKey": "base64...",
      "createdAt": "2026-02-09T...",
      "lastUsed": "2026-02-09T...",
      "webauthn": {
        "credentialId": "base64...",
        "publicKey": "base64...",
        "algorithm": -7,
        "reauthInterval": 900,
        "lastVerified": "2026-02-09T...",
        "enrolledAt": "2026-02-09T..."
      }
    }
  }
}
```

### Client-Side (SavedHost in localStorage)

```json
{
  "id": "host-uuid",
  "displayName": "dev-machine",
  "mode": "relay",
  "srpUsername": "alice",
  "session": { "sessionId": "...", "sessionKey": "..." },
  "webauthn": {
    "enrolled": true,
    "reauthInterval": 900
  }
}
```

The client only stores a flag and the interval (for UI). The credential ID and public key live server-side. The server is authoritative for enforcement.

## Security Properties

| Property | Provided by |
|----------|-------------|
| Identity verification | SRP (zero-knowledge password proof) |
| Transport encryption | NaCl secretbox (from SRP session key) |
| Physical presence proof | WebAuthn (hardware-bound key) |
| Replay protection | Per-challenge random nonce |
| Extension resistance | WebAuthn (OS-mediated, not accessible to extensions) |
| Relay blindness | E2E encryption (relay sees only ciphertext) |

**What a stolen SRP key gets an attacker (with WebAuthn enabled):**
An encrypted connection that receives no data and can send no commands. The server holds the tunnel open but starves it until a WebAuthn assertion is produced — which requires physical access to the enrolled device's biometric sensor or security key.

## Scope & Non-Goals

**In scope:**
- Relay connections (`yepanywhere.com`) on desktop browsers
- Opt-in per-host enrollment
- Periodic time-based re-verification
- Platform authenticators (Touch ID, Windows Hello) and roaming authenticators (YubiKey)

**Not in scope (for now):**
- Direct LAN/Tailscale connections (lower threat, trusted network)
- Mobile browsers (no extension threat)
- TOTP/authenticator app (WebAuthn is stronger and more seamless)
- Replacing SRP (WebAuthn is additive, not a replacement)
- Relay-side enforcement (relay stays dumb)

## Implementation Sequence

1. **Shared types** — Add WebAuthn message types to `packages/shared/src/crypto/srp-types.ts`
2. **Server: credential storage** — Extend `RemoteSessionService` to store WebAuthn credentials
3. **Server: challenge/verify** — Add WebAuthn challenge generation and assertion verification (use `@simplewebauthn/server`)
4. **Server: session gating** — Modify `ws-relay-handlers.ts` to gate data flow on WebAuthn freshness
5. **Client: registration** — Add WebAuthn enrollment UI to relay login page
6. **Client: re-auth** — Add lock screen component and `navigator.credentials.get()` flow
7. **Client: host storage** — Extend `SavedHost` with WebAuthn enrollment flag
8. **Protocol integration** — Wire WebAuthn messages through encrypted relay tunnel

## Dependencies

- `@simplewebauthn/server` (server-side assertion verification)
- `@simplewebauthn/browser` (client-side ceremony helpers, optional — raw WebAuthn API also works)
- No changes to the relay service itself
