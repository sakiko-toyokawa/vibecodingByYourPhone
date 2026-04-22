# Direct LAN Connection via Relay-Assisted Discovery

## Problem

The relay server is in Europe. Users in the US or Australia add 150-300ms round-trip latency to every streamed chunk and tool approval tap. When the user's phone and dev machine are on the same LAN, this is entirely unnecessary.

## Goal

When the client and server are on the same network, establish a direct WebSocket connection with near-zero latency. Fall back to the relay transparently when direct connection fails.

## Why Not WebRTC?

WebRTC is the obvious "direct P2P from a web page" technology, but:

- **Server-side complexity**: Browsers have native WebRTC, but Node.js needs `node-datachannel` or similar native addons. Cross-platform native compilation is painful for an npm-distributed package.
- **Protocol weight**: ICE + DTLS + SCTP state machines for what's fundamentally "send JSON over a pipe."
- **Overkill**: We don't need NAT hole-punching across the internet — we're targeting same-network scenarios where direct IP connectivity already exists.

## Why Not mDNS / Local Discovery Alone?

- **Mixed content**: The remote client is served over HTTPS from the relay. Browsers block `ws://192.168.x.x:3400` as insecure mixed content. No way around this without a valid TLS cert.
- **No bootstrap**: The client is loaded from the relay site and has no mechanism to discover local servers without an existing channel.

## Design: sslip-Style DNS + Wildcard Cert + Relay Discovery

### DNS

Wildcard DNS for `*.direct.yepanywhere.com` that embeds the target IP in the subdomain, similar to sslip.io:

```
192-168-1-5.direct.yepanywhere.com  →  192.168.1.5
10-0-0-42.direct.yepanywhere.com    →  10.0.0.42
```

Public DNS records pointing to private IPs is valid and widely used (Plex does this with `*.plex.direct`).

### TLS Certificate

A wildcard TLS cert for `*.direct.yepanywhere.com` solves the mixed content problem. The cert exists purely to satisfy the browser's HTTPS requirement — actual security comes from SRP auth + NaCl encryption (same as relay connections).

**Distribution**: The cert cannot be committed to the repo (grounds for revocation). Instead, distribute via the relay's authenticated channel:

1. Server connects to relay and authenticates (existing flow)
2. Server requests the wildcard cert + key over the authenticated channel
3. Relay serves it from a secure store
4. Server caches it locally, uses it for the HTTPS listener
5. Relay rotates the cert periodically; servers pick up the new one on reconnect

**Security tradeoff**: Any authenticated server gets the wildcard private key, so a malicious user could theoretically impersonate any `*.direct.yepanywhere.com` host on the same LAN. This is acceptable because:
- The TLS layer is browser ceremony, not the trust boundary
- The real auth is SRP — a fake server fails the SRP handshake
- The real encryption is NaCl — even if TLS were compromised, messages are E2E encrypted

### Connection Flow

```
1. Client connects to relay (existing SRP-authenticated flow)
2. Server advertises its local IP(s) to relay during registration
3. Relay tells client: "server is also available at 192.168.1.5:3400"
4. Client races two connections in parallel:
   a. Relay path (already connected)
   b. Direct path: wss://192-168-1-5.direct.yepanywhere.com:3400
      - Full SRP handshake over the direct WebSocket
      - NaCl encryption established (same as relay)
5. If direct connection succeeds → use it as primary, keep relay as fallback
6. If direct connection fails (timeout, different network) → stay on relay
7. If direct connection drops later → seamlessly fall back to relay
```

### Server-Side Changes

- **HTTPS listener**: Server starts an additional HTTPS server using the wildcard cert, alongside the existing HTTP server (local/Tailscale connections don't need the cert).
- **IP advertisement**: Server reports its local network IP(s) to the relay during registration.
- **Cert management**: Fetch cert from relay on startup, cache locally, refresh on reconnect.

### Client-Side Changes

- **Parallel connection attempt**: On relay connect, if server advertises local IPs, attempt direct `wss://` connection.
- **Transport racing**: Both connections attempt SRP auth. First to succeed becomes primary.
- **Seamless fallback**: If direct transport drops, fall back to relay without interrupting the session. Connection manager already handles reconnects.

### What This Enables

- **Same-network**: Phone on WiFi + dev machine on same LAN → direct connection, ~1ms latency
- **Different network**: Phone on cellular → relay connection, same as today
- **Transparent**: User doesn't configure anything. It just gets faster when they're home.

## Alternatives Considered

| Approach | Verdict |
|----------|---------|
| WebRTC data channels | Server-side native dependency, protocol complexity |
| mDNS/Bonjour discovery | Mixed content blocks it, no bootstrap mechanism |
| Per-server ACME certs (DNS-01) | Correct but heavy: needs DNS API, ACME client, renewal logic, LE rate limits |
| More relay locations | Solves latency for everyone, but doesn't help same-network case. Complementary — do both. |

## Open Questions

- **Port**: Should the HTTPS/direct listener use the same port as the main server, or a separate port? Same port means the server needs to detect TLS vs plain connections, or always use TLS locally too.
- **Multiple IPs**: Server may have multiple local IPs (WiFi + Ethernet, Docker bridge, etc.). Advertise all and let client try each?
- **Cert TTL**: How often to rotate the wildcard cert? Short TTL limits exposure but increases relay traffic. 30-90 days (matching LE cert lifetime) seems reasonable.
- **IPv6**: Should `*.direct.yepanywhere.com` also support IPv6 link-local addresses?
