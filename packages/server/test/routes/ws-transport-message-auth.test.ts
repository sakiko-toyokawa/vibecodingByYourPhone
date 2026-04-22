import { MIN_BINARY_ENVELOPE_LENGTH } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import { deriveTransportKey, encrypt } from "../../src/crypto/index.js";
import { createConnectionState } from "../../src/routes/ws-relay-handlers.js";
import {
  isBinaryEncryptedEnvelope,
  parseApplicationClientMessage,
  rejectPlaintextBinaryWhenEncryptedRequired,
} from "../../src/routes/ws-transport-message-auth.js";

function createMockWs() {
  return {
    close: vi.fn<(code?: number, reason?: string) => void>(),
    send: vi.fn(),
  };
}

describe("WebSocket Transport Message Auth Helpers", () => {
  it("does not treat pre-auth bytes as encrypted envelope", () => {
    const connState = createConnectionState();
    const bytes = new Uint8Array(25);
    bytes[0] = 0x01;

    expect(isBinaryEncryptedEnvelope(bytes, connState)).toBe(false);
  });

  it("treats authenticated SRP transport bytes with envelope prefix as encrypted", () => {
    const connState = createConnectionState();
    connState.authState = "authenticated";
    connState.sessionKey = new Uint8Array(32);
    const bytes = new Uint8Array(MIN_BINARY_ENVELOPE_LENGTH);
    bytes[0] = 0x01;

    expect(isBinaryEncryptedEnvelope(bytes, connState)).toBe(true);
  });

  it("rejects plaintext binary when encrypted messages are required", () => {
    const connState = createConnectionState();
    connState.authState = "authenticated";
    connState.sessionKey = new Uint8Array(32);
    connState.requiresEncryptedMessages = true;
    const ws = createMockWs();

    const rejected = rejectPlaintextBinaryWhenEncryptedRequired(
      ws,
      connState,
      true,
    );

    expect(rejected).toBe(true);
    expect(ws.close).toHaveBeenCalledWith(4005, "Encrypted message required");
  });

  it("rejects plaintext application message when SRP policy requires auth", () => {
    const connState = createConnectionState();
    const ws = createMockWs();
    const parsed = { type: "ping", id: "p1" };

    const msg = parseApplicationClientMessage(ws, connState, true, parsed);

    expect(msg).toBeNull();
    expect(ws.close).toHaveBeenCalledWith(4001, "Authentication required");
  });

  it("accepts plaintext application message when SRP is not required", () => {
    const connState = createConnectionState();
    const ws = createMockWs();
    const parsed = { type: "ping", id: "p2" };

    const msg = parseApplicationClientMessage(ws, connState, false, parsed);

    expect(msg).toEqual(parsed);
    expect(ws.close).not.toHaveBeenCalled();
  });

  it("decrypts legacy encrypted JSON envelope when SRP transport is established", () => {
    const connState = createConnectionState();
    connState.authState = "authenticated";
    connState.sessionKey = new Uint8Array(32).fill(7);
    connState.requiresEncryptedMessages = true;
    const ws = createMockWs();
    const plaintext = JSON.stringify({
      seq: 0,
      msg: { type: "ping", id: "p3" },
    });
    const { nonce, ciphertext } = encrypt(plaintext, connState.sessionKey);
    const envelope = { type: "encrypted", nonce, ciphertext };

    const msg = parseApplicationClientMessage(ws, connState, true, envelope);

    expect(msg).toEqual({ type: "ping", id: "p3" });
    expect(ws.close).not.toHaveBeenCalled();
  });

  it("rejects replayed encrypted JSON sequence", () => {
    const connState = createConnectionState();
    connState.authState = "authenticated";
    connState.sessionKey = new Uint8Array(32).fill(7);
    connState.requiresEncryptedMessages = true;
    const ws = createMockWs();

    const p0 = JSON.stringify({ seq: 0, msg: { type: "ping", id: "p3" } });
    const p1 = JSON.stringify({ seq: 1, msg: { type: "ping", id: "p4" } });
    const e0 = encrypt(p0, connState.sessionKey);
    const e1 = encrypt(p1, connState.sessionKey);

    expect(
      parseApplicationClientMessage(ws, connState, true, {
        type: "encrypted",
        nonce: e0.nonce,
        ciphertext: e0.ciphertext,
      }),
    ).toEqual({ type: "ping", id: "p3" });

    expect(
      parseApplicationClientMessage(ws, connState, true, {
        type: "encrypted",
        nonce: e1.nonce,
        ciphertext: e1.ciphertext,
      }),
    ).toEqual({ type: "ping", id: "p4" });

    expect(
      parseApplicationClientMessage(ws, connState, true, {
        type: "encrypted",
        nonce: e0.nonce,
        ciphertext: e0.ciphertext,
      }),
    ).toBeNull();
    expect(ws.close).toHaveBeenCalledWith(4004, "Replay detected");
  });

  it("accepts legacy base-key encrypted envelope and downgrades connection key mode", () => {
    const connState = createConnectionState();
    connState.authState = "authenticated";
    connState.baseSessionKey = new Uint8Array(32).fill(9);
    connState.sessionKey = deriveTransportKey(
      connState.baseSessionKey,
      Buffer.from(new Uint8Array(24).fill(3)).toString("base64"),
    );
    connState.requiresEncryptedMessages = true;
    const ws = createMockWs();

    // Simulate an older client that still encrypts using the long-lived base key.
    const plaintext = JSON.stringify({
      type: "client_capabilities",
      formats: [1, 2, 3],
    });
    const envelope = encrypt(plaintext, connState.baseSessionKey);

    const msg = parseApplicationClientMessage(ws, connState, true, {
      type: "encrypted",
      nonce: envelope.nonce,
      ciphertext: envelope.ciphertext,
    });

    expect(msg).toEqual({ type: "client_capabilities", formats: [1, 2, 3] });
    expect(connState.usingLegacyTrafficKey).toBe(true);
    expect(connState.sessionKey).toEqual(connState.baseSessionKey);
    expect(ws.close).not.toHaveBeenCalled();
  });
});
