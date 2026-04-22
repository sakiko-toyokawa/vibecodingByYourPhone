import { describe, expect, it, vi } from "vitest";
import { SecureConnection } from "../SecureConnection";
import { WebSocketConnection } from "../WebSocketConnection";

describe("connection reconnect subscription cleanup", () => {
  it("WebSocketConnection.reconnect closes existing stream subscriptions", async () => {
    const conn = new WebSocketConnection() as unknown as {
      protocol: {
        rejectAllPending: ReturnType<typeof vi.fn>;
        notifySubscriptionsClosed: ReturnType<typeof vi.fn>;
      };
      ws: {
        onclose: ((event: CloseEvent) => void) | null;
        onerror: ((event: Event) => void) | null;
        onmessage: ((event: MessageEvent) => void) | null;
        close: ReturnType<typeof vi.fn>;
      } | null;
      ensureConnected: ReturnType<typeof vi.fn>;
      reconnect: () => Promise<void>;
    };

    const rejectAllPending = vi.fn();
    const notifySubscriptionsClosed = vi.fn();
    const close = vi.fn();
    const ensureConnected = vi.fn().mockResolvedValue(undefined);

    conn.protocol = { rejectAllPending, notifySubscriptionsClosed };
    conn.ws = {
      onclose: () => {},
      onerror: () => {},
      onmessage: () => {},
      close,
    };
    conn.ensureConnected = ensureConnected;

    await conn.reconnect();

    expect(rejectAllPending).toHaveBeenCalledTimes(1);
    expect(notifySubscriptionsClosed).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(ensureConnected).toHaveBeenCalledTimes(1);
  });

  it("SecureConnection.forceReconnect closes existing stream subscriptions", async () => {
    const conn = new SecureConnection(
      "ws://localhost:3400/api/ws",
      "test-user",
      "test-password",
    ) as unknown as {
      protocol: {
        rejectAllPending: ReturnType<typeof vi.fn>;
        notifySubscriptionsClosed: ReturnType<typeof vi.fn>;
      };
      ws: {
        onclose: ((event: CloseEvent) => void) | null;
        onerror: ((event: Event) => void) | null;
        onmessage: ((event: MessageEvent) => void) | null;
        close: ReturnType<typeof vi.fn>;
      } | null;
      ensureConnected: ReturnType<typeof vi.fn>;
      forceReconnect: () => Promise<void>;
    };

    const rejectAllPending = vi.fn();
    const notifySubscriptionsClosed = vi.fn();
    const close = vi.fn();
    const ensureConnected = vi.fn().mockResolvedValue(undefined);

    conn.protocol = { rejectAllPending, notifySubscriptionsClosed };
    conn.ws = {
      onclose: () => {},
      onerror: () => {},
      onmessage: () => {},
      close,
    };
    conn.ensureConnected = ensureConnected;

    await conn.forceReconnect();

    expect(rejectAllPending).toHaveBeenCalledTimes(1);
    expect(notifySubscriptionsClosed).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(ensureConnected).toHaveBeenCalledTimes(1);
  });
});
