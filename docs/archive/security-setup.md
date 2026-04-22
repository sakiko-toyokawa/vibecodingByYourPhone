# Security Setup

## Overview

claude-anywhere runs as a service on a trusted machine (e.g., Mac Mini) and accepts requests that can execute code via Claude. Security is critical—an exposed endpoint could allow arbitrary code execution.

Our approach layers three defenses:

1. **Network isolation** — Expose via Tailscale serve
2. **CORS + custom header** — Block cross-origin requests from malicious sites
3. **Bearer token** — Explicit authentication for all requests

## 1. Network Isolation via Tailscale Serve

The server listens only on localhost. We use `tailscale serve` to expose it on the Tailscale network, providing network-level isolation without binding to specific interfaces.

### Implementation

The server binds to localhost only (default behavior). Tailscale serve acts as a reverse proxy, exposing the local port on the Tailscale network with automatic HTTPS.

```bash
# Start the dev server with Tailscale exposure
pnpm dev-tailscale
```

This runs `tailscale serve --bg 5555` before starting the dev server. The app is then accessible at:
- `http://localhost:5555` (local)
- `https://your-machine.tailnet.ts.net` (Tailscale network)

To stop Tailscale serve:
```bash
tailscale serve off
```

### Why This Works

- Server stays on localhost—no direct network exposure
- Tailscale serve proxies requests from the tailnet to localhost
- Only devices on your tailnet can reach the Tailscale hostname
- Tailnet membership requires authentication via your identity provider
- Connections are encrypted via WireGuard
- Automatic HTTPS with valid Let's Encrypt certificates

## 2. CORS + Custom Header

Even with Tailscale binding, a malicious website could attempt cross-origin requests from your browser (which *is* on the tailnet). We block this with strict CORS and a required custom header.

### The Attack Vector

```javascript
// On evil.com, while you're browsing
fetch('http://100.68.42.15:3000/api/session/start', {
  method: 'POST',
  body: JSON.stringify({ prompt: 'rm -rf /', mode: 'bypassPermissions' })
})
```

The browser can reach that IP. Without protection, the request fires.

### Implementation

```typescript
// packages/server/src/middleware/security.ts

import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";

// Allow localhost (dev) and any *.ts.net (Tailscale)
const isAllowedOrigin = (origin: string): boolean => {
  if (!origin) return false;
  if (origin.startsWith("http://localhost:")) return true;
  if (origin.endsWith(".ts.net")) return true;
  return false;
};

export const corsMiddleware = cors({
  origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "DELETE"],
  allowHeaders: ["Content-Type", "Authorization", "X-Claude-Anywhere"],
});

// Only require header on mutating requests (SSE uses native EventSource which can't send headers)
export const requireCustomHeader: MiddlewareHandler = async (c, next) => {
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    if (c.req.header("X-Claude-Anywhere") !== "true") {
      return c.json({ error: "Missing required header" }, 403);
    }
  }
  await next();
};
```

### Why Custom Header Works

1. Browser wants to send custom header cross-origin
2. Browser must send preflight OPTIONS request first
3. Preflight fails CORS check (origin not allowed)
4. Actual request never sent

Simple requests (no custom headers) could bypass preflight, but the header requirement forces it.

## 3. Bearer Token

Defense in depth. Even if CORS/header checks had a bug, requests still need a valid token.

### Configuration

```bash
# .env (not committed)
CLAUDE_ANYWHERE_TOKEN=your-random-secret-here

# Generate a good token:
# openssl rand -base64 32
```

### Implementation

```typescript
// src/server/middleware/security.ts

export const requireAuth: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header('Authorization')
  const expected = `Bearer ${process.env.CLAUDE_ANYWHERE_TOKEN}`
  
  if (!authHeader || authHeader !== expected) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  await next()
}
```

### Client Usage

```typescript
// src/client/api.ts

const API_TOKEN = import.meta.env.VITE_API_TOKEN

export async function apiRequest(path: string, options: RequestInit = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_TOKEN}`,
      'X-Claude-Anywhere': 'true',
    },
  })
}
```

### Native App

The native app stores the token after initial pairing (QR code, manual entry, or magic link). Token is sent with all requests and SSE connections.

## Middleware Stack

```typescript
// src/server/index.ts

import { Hono } from 'hono'
import { corsMiddleware, requireCustomHeader, requireAuth } from './middleware/security'

const app = new Hono()

// Apply to all API routes
app.use('/api/*', corsMiddleware)
app.use('/api/*', requireCustomHeader)
app.use('/api/*', requireAuth)

// SSE endpoint also needs auth (via query param or header)
app.use('/sse/*', requireAuth)
```

## SSE Authentication

SSE (EventSource) doesn't support custom headers natively. Options:

### Option A: Token in URL (simpler)
```typescript
const eventSource = new EventSource(`/sse/session/${id}?token=${API_TOKEN}`)
```

Server validates query param. Slightly less clean but works everywhere.

### Option B: Polyfill with fetch
```typescript
// Use a fetch-based SSE library that supports headers
import { fetchEventSource } from '@microsoft/fetch-event-source'

fetchEventSource(`/sse/session/${id}`, {
  headers: {
    'Authorization': `Bearer ${API_TOKEN}`,
    'X-Claude-Anywhere': 'true',
  },
})
```

## Checklist

- [x] Server exposed via `tailscale serve` (localhost only binding)
- [x] CORS configured to allow localhost and *.ts.net origins
- [x] `X-Claude-Anywhere` header required on mutating API routes (POST/PUT/DELETE)
- [ ] Bearer token required on all API routes
- [ ] SSE endpoint authenticates via query param or header
- [ ] Token stored in `.env`, not committed
- [x] Client includes required headers
- [ ] Native app stores token after pairing

## Future Considerations

- **Token rotation** — Add endpoint to generate new token, invalidate old
- **Tailscale ACLs** — Restrict which tailnet devices can access the service
- **Audit logging** — Log all requests with device/IP for debugging
- **Rate limiting** — Prevent runaway requests (probably overkill for personal use)
