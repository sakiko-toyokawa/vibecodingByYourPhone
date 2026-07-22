import {
  type WsConnectionPolicy,
  isPolicyTrustedWithoutSrp,
} from "./ws-auth-policy.js";

/**
 * Minimal auth shape required for transport-level websocket auth checks.
 */
export interface WsTransportAuthState {
  authState: "unauthenticated" | "srp_waiting_proof" | "authenticated";
  sessionKey: Uint8Array | null;
  connectionPolicy: WsConnectionPolicy;
}

/**
 * True only when SRP transport authentication completed and key exists.
 */
export function hasEstablishedSrpTransport(
  connState: Pick<WsTransportAuthState, "authState" | "sessionKey">,
): connState is Pick<WsTransportAuthState, "authState" | "sessionKey"> & {
  authState: "authenticated";
  sessionKey: Uint8Array;
} {
  return connState.authState === "authenticated" && !!connState.sessionKey;
}

/**
 * True while SRP challenge was issued and proof is pending.
 */
export function isSrpProofPending(
  connState: Pick<WsTransportAuthState, "authState">,
): boolean {
  return connState.authState === "srp_waiting_proof";
}

/**
 * True when the connection was trusted by local websocket policy and does not
 * require SRP transport keys.
 */
export function isTrustedWithoutSrpTransport(
  connState: Pick<WsTransportAuthState, "connectionPolicy" | "authState">,
): boolean {
  return (
    isPolicyTrustedWithoutSrp(connState.connectionPolicy) &&
    connState.authState === "authenticated"
  );
}

/**
 * True when the connection can issue internal app requests via websocket relay.
 */
export function shouldMarkInternalWsAuthenticated(
  connState: Pick<
    WsTransportAuthState,
    "connectionPolicy" | "authState" | "sessionKey"
  >,
): boolean {
  return (
    hasEstablishedSrpTransport(connState) ||
    isTrustedWithoutSrpTransport(connState)
  );
}
