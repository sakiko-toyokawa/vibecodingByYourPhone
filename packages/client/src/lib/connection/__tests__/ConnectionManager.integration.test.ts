import { describe, expect, it, vi } from "vitest";
import {
  ConnectionManager,
  type ConnectionState,
  type ReconnectFn,
  type SendPingFn,
} from "../ConnectionManager";
import { WebSocketCloseError } from "../types";
import { MockTimers, MockVisibility } from "./ConnectionSimulator";

/**
 * Integration tests that exercise full scenarios with MockTimers + MockVisibility.
 * These test realistic sequences rather than isolated behaviors.
 */

/** Flush the microtask queue (needed for promise chains in reconnectFn) */
function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

function setup(
  overrides: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    staleThresholdMs?: number;
    staleCheckIntervalMs?: number;
    pongTimeoutMs?: number;
  } = {},
) {
  const timers = new MockTimers();
  const visibility = new MockVisibility();
  const reconnectFn = vi.fn<ReconnectFn>(() => Promise.resolve());
  const sendPing = vi.fn<SendPingFn>();
  const stateLog: Array<{
    state: ConnectionState;
    prev: ConnectionState;
  }> = [];
  const failures: Error[] = [];

  const cm = new ConnectionManager({
    timers,
    visibility,
    jitterFactor: 0,
    ...overrides,
  });

  cm.on("stateChange", (state, prev) => stateLog.push({ state, prev }));
  cm.on("reconnectFailed", (err) => failures.push(err));

  cm.start(reconnectFn, { sendPing });

  return { cm, timers, visibility, reconnectFn, sendPing, stateLog, failures };
}

describe("ConnectionManager integration", () => {
  it("1. Server restart: connected → close → reconnect after 1s → connected", async () => {
    const { cm, reconnectFn, timers, stateLog } = setup();
    stateLog.length = 0;

    cm.handleClose();
    expect(cm.state).toBe("reconnecting");

    timers.advance(1000);
    await flush();

    cm.markConnected();
    expect(cm.state).toBe("connected");
    expect(cm.reconnectAttempts).toBe(0);
    expect(reconnectFn).toHaveBeenCalledTimes(1);
    expect(stateLog).toEqual([
      { state: "reconnecting", prev: "connected" },
      { state: "connected", prev: "reconnecting" },
    ]);
  });

  it("2. Repeated failures: give up after maxAttempts", async () => {
    const { cm, reconnectFn, timers, failures } = setup({
      maxAttempts: 10,
    });
    reconnectFn.mockRejectedValue(new Error("connection refused"));

    cm.handleClose();

    const delays = [
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000,
    ];
    for (const delay of delays) {
      timers.advance(delay);
      await flush();
    }

    expect(cm.state).toBe("disconnected");
    expect(reconnectFn).toHaveBeenCalledTimes(10);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toMatch(/failed after 10 attempts/);
  });

  it("3. Auth failure: non-retryable error → immediate disconnected, no retry", () => {
    const { cm, reconnectFn, failures } = setup();

    cm.handleError(new WebSocketCloseError(4001, "Authentication required"));

    expect(cm.state).toBe("disconnected");
    expect(reconnectFn).not.toHaveBeenCalled();
    expect(failures).toHaveLength(1);
  });

  it("4. Stale connection: no events for 45s → force reconnect → connected", async () => {
    const { cm, reconnectFn, timers } = setup({
      staleThresholdMs: 45000,
      staleCheckIntervalMs: 10000,
    });

    cm.recordHeartbeat();
    timers.advance(5000);
    cm.recordEvent();

    timers.advance(50000);
    expect(cm.state).toBe("reconnecting");

    timers.advance(1000);
    await flush();

    cm.markConnected();
    expect(cm.state).toBe("connected");
    expect(reconnectFn).toHaveBeenCalledTimes(1);
  });

  it("5. Sleep/wake: visible → hidden → visible → ping → pong timeout → reconnect → connected", async () => {
    const { cm, reconnectFn, sendPing, timers, visibility } = setup({
      pongTimeoutMs: 5000,
    });

    visibility.hide();
    timers.advance(10000);
    visibility.show();

    expect(sendPing).toHaveBeenCalledTimes(1);
    expect(cm.state).toBe("connected"); // still connected, waiting for pong

    // Pong never arrives — timeout triggers reconnect
    timers.advance(5000);
    expect(cm.state).toBe("reconnecting");

    timers.advance(1000);
    await flush();

    cm.markConnected();
    expect(cm.state).toBe("connected");
    expect(reconnectFn).toHaveBeenCalledTimes(1);
  });

  it("6. Tab switch: visible → hidden → visible → ping → pong received → stays connected", () => {
    const { cm, reconnectFn, sendPing, timers, visibility } = setup({
      pongTimeoutMs: 5000,
    });

    visibility.hide();
    timers.advance(2000);
    visibility.show();

    expect(sendPing).toHaveBeenCalledTimes(1);
    cm.receivePong("1"); // pong confirms connection is alive

    timers.advance(5000);
    expect(cm.state).toBe("connected");
    expect(reconnectFn).not.toHaveBeenCalled();
  });

  it("7. No double reconnect: two consumers both call handleClose → only one reconnect", async () => {
    const { cm, reconnectFn, timers } = setup();

    cm.handleClose();
    cm.handleClose(); // second call is no-op (already reconnecting)

    timers.advance(1000);
    await flush();

    expect(reconnectFn).toHaveBeenCalledTimes(1);
    cm.markConnected();
    expect(cm.state).toBe("connected");
  });

  it("8. Backoff reset on success: fail 3 times → succeed → fail again → delay is 1s", async () => {
    const { cm, reconnectFn, timers } = setup();
    let callCount = 0;

    reconnectFn.mockImplementation(async () => {
      callCount++;
      if (callCount <= 3) throw new Error("fail");
    });

    cm.handleClose();

    // Fail 3 times: delays 1s, 2s, 4s
    timers.advance(1000);
    await flush();
    timers.advance(2000);
    await flush();
    timers.advance(4000);
    await flush();

    // Attempt 4 succeeds: delay 8s
    timers.advance(8000);
    await flush();
    cm.markConnected();
    expect(cm.state).toBe("connected");
    expect(cm.reconnectAttempts).toBe(0);
    expect(callCount).toBe(4);

    // New failure — should start backoff from 1s (reset, not 16s)
    reconnectFn.mockImplementation(async () => {
      callCount++;
      throw new Error("fail again");
    });
    cm.handleClose();

    timers.advance(1000); // base delay (reset)
    await flush();

    expect(callCount).toBe(5); // one more call at 1s delay
  });

  it("9. forceReconnect during backoff: waiting for 8s backoff → forceReconnect → reconnects with 1s delay", async () => {
    const { cm, reconnectFn, timers } = setup();
    let callCount = 0;
    reconnectFn.mockImplementation(async () => {
      callCount++;
      if (callCount <= 3) throw new Error("fail");
    });

    cm.handleClose();

    // Fail 3 times to build up backoff
    timers.advance(1000);
    await flush();
    timers.advance(2000);
    await flush();
    timers.advance(4000);
    await flush();

    // Now waiting for 8s backoff
    timers.advance(2000); // only 2s into 8s wait

    // User forces reconnect — resets backoff
    cm.forceReconnect();

    // New attempt at 1s delay (reset)
    timers.advance(1000);
    await flush();

    cm.markConnected();
    expect(cm.state).toBe("connected");
    expect(callCount).toBe(4);
  });

  it("10. No login redirect during reconnecting: state stays 'reconnecting'", () => {
    const { cm } = setup();

    cm.handleClose();

    expect(cm.state).toBe("reconnecting");
    expect(cm.state).not.toBe("disconnected");
  });

  it("11. Reconnect promise dedup: two callers → only one reconnectFn execution", async () => {
    const { cm, reconnectFn, timers } = setup();
    let resolveReconnect: () => void = () => {};
    reconnectFn.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveReconnect = resolve;
        }),
    );

    cm.handleClose();
    timers.advance(1000);

    expect(reconnectFn).toHaveBeenCalledTimes(1);

    // A second close event while in-flight is no-op (already reconnecting)
    cm.handleClose();

    resolveReconnect();
    await flush();

    cm.markConnected();
    expect(cm.state).toBe("connected");
    expect(reconnectFn).toHaveBeenCalledTimes(1);
  });

  it("12. Non-retryable close code: handleClose(4001) → immediate disconnected, no retry", () => {
    const { cm, reconnectFn, failures } = setup();

    cm.handleClose(new WebSocketCloseError(4001, "Authentication required"));

    expect(cm.state).toBe("disconnected");
    expect(reconnectFn).not.toHaveBeenCalled();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(WebSocketCloseError);
  });

  it("events continue to flow during reconnect attempts", async () => {
    const { cm, reconnectFn, timers } = setup({ maxAttempts: 5 });

    const states: ConnectionState[] = [];
    cm.on("stateChange", (s) => states.push(s));

    reconnectFn.mockRejectedValueOnce(new Error("fail"));
    cm.handleClose();
    timers.advance(1000);
    await flush();

    reconnectFn.mockResolvedValueOnce(undefined);
    timers.advance(2000);
    await flush();
    cm.markConnected();

    expect(cm.state).toBe("connected");
    expect(states).toContain("reconnecting");
    expect(states).toContain("connected");
  });

  it("successful reconnectFn transitions to connected without external markConnected", async () => {
    const { cm, reconnectFn, timers } = setup();

    cm.handleClose();
    expect(cm.state).toBe("reconnecting");

    timers.advance(1000);
    await flush();

    // reconnectFn resolved — should auto-transition to connected
    expect(cm.state).toBe("connected");
    expect(reconnectFn).toHaveBeenCalledTimes(1);
    expect(cm.reconnectAttempts).toBe(0);
  });

  it("stop during reconnecting cleans up properly", async () => {
    const { cm, reconnectFn, timers } = setup();
    reconnectFn.mockRejectedValue(new Error("fail"));

    cm.handleClose();
    timers.advance(1000);
    await flush();

    cm.stop();
    expect(cm.state).toBe("disconnected");
    expect(timers.pendingCount).toBe(0);

    timers.advance(100000);
    expect(reconnectFn).toHaveBeenCalledTimes(1);
  });
});
