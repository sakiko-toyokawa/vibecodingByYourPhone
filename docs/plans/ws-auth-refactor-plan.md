# WebSocket Auth State Separation Refactor Plan

## Summary of findings

- Current coupling is real: `ConnectionState.authState` is overloaded and used for both:
  - connection trust/admission (local trusted paths), and
  - SRP transport key establishment state.
- `createWsRelayRoutes` seeds `connState.authState = "authenticated"` for local/cookie paths, which can conflict conceptually with SRP-only meanings in resume/hello flows.
- Several guards already compensate for this (`&& connState.sessionKey` checks), which is a symptom of model mismatch.
- `handleRequest` always injects the internal SRP auth bypass symbol for app fetch routing, regardless of how the websocket was admitted.
- Coverage for these semantics is mostly e2e; unit-level state transition tests are limited.

## Refactor options

### Option 1 (recommended): Policy + Transport State Split

- Add explicit websocket admission policy (HTTP/cookie/local/relay trust source).
- Keep SRP transport auth state separate (none, waiting proof, established with key).
- Replace implicit checks with named helper guards.

Pros:
- Clear conceptual boundaries.
- Moderate migration cost.
- Works with incremental PR slices.

Cons:
- Some temporary overlap during migration.

Risk:
- Medium-low.

### Option 2: Split message handler into local vs SRP routers

- Separate `handleMessage` into local-trusted and SRP-required routers.
- Keep parser/shared upload routing common.

Pros:
- Highly explicit call paths.

Cons:
- Higher duplication risk.
- Harder to keep behaviors in sync.

Risk:
- Medium.

### Option 3: Dedicated auth state machine object

- Encapsulate all SRP and post-auth transition logic in a dedicated state machine class.

Pros:
- Strong invariants and clarity.

Cons:
- Largest rewrite and migration burden.

Risk:
- Medium-high.

## Recommended design

- Distinct concepts:
  - HTTP auth context: where trust came from (`session_cookie`, `auth_disabled`, etc.).
  - WS admission policy: whether SRP is required for this connection.
  - SRP transport auth state: strictly SRP key negotiation/establishment.
- Preserve two-phase resume replay protection exactly as-is.
- Preserve local cookie-authenticated behavior for non-remote paths.

## File-by-file change plan

- `packages/server/src/routes/ws-relay.ts`
  - Derive an explicit websocket admission policy on open.
  - Stop directly treating generic middleware bypass as SRP transport auth.
- `packages/server/src/routes/ws-relay-handlers.ts`
  - Add helper guards for SRP transport establishment and handshake status.
  - Route auth checks through named helpers instead of raw field checks.
  - Keep replay protection flow untouched.
- `packages/server/src/middleware/auth.ts`
  - Preserve cookie auth behavior; optionally annotate source for explicit downstream reasoning.
- `packages/server/src/middleware/internal-auth.ts`
  - Keep internal symbol-based bypass and type it explicitly for WS internal fetch contexts.
- `packages/server/src/app.ts`
  - No major behavior change; keep middleware ordering and guard assumptions explicit.

## Backward-compatibility analysis

- Direct mode:
  - Continue allowing local websocket behavior when remote auth is not required.
- Relay mode:
  - Continue SRP-required behavior and encrypted transport enforcement.
- `AUTH_DISABLED=true`:
  - Keep test/dev ergonomics while avoiding accidental equivalence with SRP-established state.
- Cookie-authenticated local behavior:
  - Preserve existing trusted local UX; make trust source explicit.

## Test matrix

- Unit:
  - websocket policy derivation matrix
  - SRP transport state helpers and guard semantics
- E2E:
  - direct local with/without cookie
  - remote-enabled SRP hello/proof
  - resume init + resume proof success
  - replayed resume proof rejection
  - reconnect resume flows
- Regression points:
  - `srp_hello`
  - `srp_resume_init`
  - `srp_resume`
  - post-auth plaintext rejection

## Rollout plan (incremental PR slices)

1. PR1 (foundation, no behavior change):
   - Introduce explicit policy/typed helpers.
   - Add unit tests for policy and SRP transport guards.
2. PR2 (behavior routing clarity):
   - Replace remaining implicit auth checks with policy + helper guards in handlers.
3. PR3 (cleanup):
   - Remove transitional compatibility shims and tighten docs/tests.

## Risks and mitigations

- Risk: accidental behavior change in local cookie-trusted path.
  - Mitigation: preserve existing gates and add explicit matrix tests.
- Risk: replay-protection regression.
  - Mitigation: keep nonce challenge and proof binding unchanged; add focused regression tests.
- Risk: migration churn in a large handler file.
  - Mitigation: split into PR slices with no-behavior-change first pass.
