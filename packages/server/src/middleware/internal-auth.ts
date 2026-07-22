/**
 * Symbol used to mark requests as pre-authenticated from trusted internal WS
 * sources (SRP tunnel or trusted local websocket policy).
 *
 * The auth middleware checks for this symbol and skips local password auth.
 * Using a Symbol ensures this cannot be forged by external HTTP clients.
 */
export const WS_INTERNAL_AUTHENTICATED = Symbol("ws-internal-authenticated");
