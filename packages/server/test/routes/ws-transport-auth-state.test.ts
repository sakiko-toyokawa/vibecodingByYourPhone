import { describe, expect, it } from "vitest";
import { createConnectionState } from "../../src/routes/ws-relay-handlers.js";
import {
  hasEstablishedSrpTransport,
  isSrpProofPending,
  isTrustedWithoutSrpTransport,
  shouldMarkInternalWsAuthenticated,
} from "../../src/routes/ws-transport-auth.js";

describe("WebSocket Transport Auth State Helpers", () => {
  it("starts unauthenticated with no established SRP transport", () => {
    const connState = createConnectionState();

    expect(hasEstablishedSrpTransport(connState)).toBe(false);
    expect(isSrpProofPending(connState)).toBe(false);
  });

  it("treats srp_waiting_proof as proof pending", () => {
    const connState = createConnectionState();
    connState.authState = "srp_waiting_proof";

    expect(isSrpProofPending(connState)).toBe(true);
    expect(hasEstablishedSrpTransport(connState)).toBe(false);
  });

  it("does not treat authenticated-without-key as SRP established", () => {
    const connState = createConnectionState();
    connState.authState = "authenticated";
    connState.sessionKey = null;

    expect(hasEstablishedSrpTransport(connState)).toBe(false);
  });

  it("treats authenticated-with-key as SRP established", () => {
    const connState = createConnectionState();
    connState.authState = "authenticated";
    connState.sessionKey = new Uint8Array(32);

    expect(hasEstablishedSrpTransport(connState)).toBe(true);
  });

  it("marks trusted local policy as trusted without SRP transport", () => {
    const connState = createConnectionState();
    connState.connectionPolicy = "local_cookie_trusted";
    connState.authState = "authenticated";

    expect(isTrustedWithoutSrpTransport(connState)).toBe(true);
    expect(shouldMarkInternalWsAuthenticated(connState)).toBe(true);
  });

  it("does not mark srp_required policy without key as WS-internal-authenticated", () => {
    const connState = createConnectionState();
    connState.connectionPolicy = "srp_required";
    connState.authState = "authenticated";
    connState.sessionKey = null;

    expect(isTrustedWithoutSrpTransport(connState)).toBe(false);
    expect(shouldMarkInternalWsAuthenticated(connState)).toBe(false);
  });

  it("marks srp_required with key as WS-internal-authenticated", () => {
    const connState = createConnectionState();
    connState.connectionPolicy = "srp_required";
    connState.authState = "authenticated";
    connState.sessionKey = new Uint8Array(32);

    expect(shouldMarkInternalWsAuthenticated(connState)).toBe(true);
  });
});
