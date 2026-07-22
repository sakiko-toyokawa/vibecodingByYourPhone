/**
 * WebSocket admission/auth policy is distinct from SRP transport key state.
 *
 * - Policy answers: "What level of auth is required for this connection?"
 * - SRP transport state answers: "Has this connection established an SRP key?"
 */

export type WsConnectionPolicy =
  | "local_unrestricted"
  | "local_cookie_trusted"
  | "srp_required";

export interface WsConnectionPolicyInput {
  remoteAccessEnabled: boolean;
  hasSessionCookieAuth: boolean;
  isRelayConnection: boolean;
  isLoopbackConnection: boolean;
}

/**
 * Derive websocket admission policy from connection context.
 *
 * This intentionally does not look at generic auth bypass flags. For direct
 * connections, only explicit session-cookie auth is treated as trusted when
 * remote access is enabled.
 */
export function deriveWsConnectionPolicy(
  input: WsConnectionPolicyInput,
): WsConnectionPolicy {
  if (input.isRelayConnection) {
    return "srp_required";
  }

  if (!input.remoteAccessEnabled) {
    return "local_unrestricted";
  }

  if (input.hasSessionCookieAuth) {
    return "local_cookie_trusted";
  }

  if (input.isLoopbackConnection) {
    return "local_unrestricted";
  }

  return "srp_required";
}

export function isPolicyTrustedWithoutSrp(policy: WsConnectionPolicy): boolean {
  return policy === "local_unrestricted" || policy === "local_cookie_trusted";
}

export function isPolicySrpRequired(policy: WsConnectionPolicy): boolean {
  return policy === "srp_required";
}
