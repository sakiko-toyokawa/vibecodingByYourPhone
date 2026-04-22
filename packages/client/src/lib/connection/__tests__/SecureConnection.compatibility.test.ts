// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { SecureConnection } from "../SecureConnection";
import {
  decrypt,
  decryptBinaryEnvelope,
  encrypt,
  generateRandomKey,
} from "../nacl-wrapper";

function nonceBase64(fill: number): string {
  const bytes = new Uint8Array(24).fill(fill);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

describe("SecureConnection legacy protocol compatibility", () => {
  it("uses legacy JSON encrypted envelopes when server omits transport nonce", async () => {
    const conn = new SecureConnection(
      "ws://localhost:3400/api/ws",
      "test-user",
      "test-password",
    ) as unknown as {
      ws: { readyState: number; send: ReturnType<typeof vi.fn> };
      srpSession: {
        verifyServer: (m2: string) => Promise<boolean>;
        getSessionKey: () => Uint8Array;
      };
      sessionKey: Uint8Array;
      useLegacyProtocolMode: boolean;
      send: (msg: { type: "ping"; id: string }) => void;
      handleSrpVerify: (
        data: string,
        resolve: () => void,
        reject: (err: Error) => void,
      ) => Promise<void>;
    };

    const send = vi.fn();
    conn.ws = { readyState: 1, send };
    conn.srpSession = {
      verifyServer: vi.fn().mockResolvedValue(true),
      getSessionKey: vi.fn().mockReturnValue(generateRandomKey()),
    };

    const resolve = vi.fn();
    const reject = vi.fn();
    await conn.handleSrpVerify(
      JSON.stringify({
        type: "srp_verify",
        M2: "abc123",
        sessionId: "sess-1",
      }),
      resolve,
      reject,
    );

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();
    expect(conn.useLegacyProtocolMode).toBe(true);
    // Legacy mode skips client_capabilities; verify regular requests use JSON envelope.
    expect(send).toHaveBeenCalledTimes(0);
    conn.send({ type: "ping", id: "legacy-ping" });
    expect(send).toHaveBeenCalledTimes(1);

    const sent = send.mock.calls[0]?.[0];
    expect(typeof sent).toBe("string");
    const envelope = JSON.parse(sent as string) as {
      type: string;
      nonce: string;
      ciphertext: string;
    };
    expect(envelope.type).toBe("encrypted");

    const plaintext = decrypt(
      envelope.nonce,
      envelope.ciphertext,
      conn.sessionKey,
    );
    expect(plaintext).not.toBeNull();
    const parsed = JSON.parse(plaintext ?? "{}") as {
      type: string;
      id: string;
    };
    expect(parsed.type).toBe("ping");
    expect(parsed.id).toBe("legacy-ping");
    expect("seq" in parsed).toBe(false);
  });

  it("uses sequenced binary encrypted envelopes on modern servers", async () => {
    const conn = new SecureConnection(
      "ws://localhost:3400/api/ws",
      "test-user",
      "test-password",
    ) as unknown as {
      ws: { readyState: number; send: ReturnType<typeof vi.fn> };
      srpSession: {
        verifyServer: (m2: string) => Promise<boolean>;
        getSessionKey: () => Uint8Array;
      };
      sessionKey: Uint8Array;
      useLegacyProtocolMode: boolean;
      handleSrpVerify: (
        data: string,
        resolve: () => void,
        reject: (err: Error) => void,
      ) => Promise<void>;
    };

    const send = vi.fn();
    conn.ws = { readyState: 1, send };
    conn.srpSession = {
      verifyServer: vi.fn().mockResolvedValue(true),
      getSessionKey: vi.fn().mockReturnValue(generateRandomKey()),
    };

    const resolve = vi.fn();
    const reject = vi.fn();
    await conn.handleSrpVerify(
      JSON.stringify({
        type: "srp_verify",
        M2: "abc123",
        sessionId: "sess-1",
        transportNonce: nonceBase64(9),
      }),
      resolve,
      reject,
    );

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();
    expect(conn.useLegacyProtocolMode).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);

    const sent = send.mock.calls[0]?.[0];
    expect(sent).toBeInstanceOf(ArrayBuffer);
    const plaintext = decryptBinaryEnvelope(
      sent as ArrayBuffer,
      conn.sessionKey,
    );
    expect(plaintext).not.toBeNull();
    const parsed = JSON.parse(plaintext ?? "{}") as {
      seq: number;
      msg: { type: string };
    };
    expect(parsed.seq).toBe(0);
    expect(parsed.msg.type).toBe("client_capabilities");
  });

  it("accepts legacy unsequenced encrypted responses in legacy mode", async () => {
    const conn = new SecureConnection(
      "ws://localhost:3400/api/ws",
      "test-user",
      "test-password",
    ) as unknown as {
      ws: { close: ReturnType<typeof vi.fn> };
      sessionKey: Uint8Array;
      useLegacyProtocolMode: boolean;
      protocol: { routeMessage: ReturnType<typeof vi.fn> };
      handleMessage: (data: unknown) => Promise<void>;
    };

    conn.ws = { close: vi.fn() };
    const key = generateRandomKey();
    conn.sessionKey = key;
    conn.useLegacyProtocolMode = true;
    conn.protocol = { routeMessage: vi.fn() };

    const msg = { type: "pong", id: "legacy-1" };
    const encrypted = encrypt(JSON.stringify(msg), key);
    await conn.handleMessage(
      JSON.stringify({
        type: "encrypted",
        nonce: encrypted.nonce,
        ciphertext: encrypted.ciphertext,
      }),
    );

    expect(conn.protocol.routeMessage).toHaveBeenCalledWith(msg);
    expect(conn.ws.close).not.toHaveBeenCalled();
  });
});
