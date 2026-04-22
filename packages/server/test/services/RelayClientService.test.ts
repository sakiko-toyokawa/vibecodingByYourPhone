import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Create the mock class and instances array in hoisted scope
// Using a simple callback-based event emitter to avoid import issues
const { MockWebSocket, MockWebSocketInstances } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  const instances: MockWebSocket[] = [];

  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    sentMessages: string[] = [];
    OPEN = MockWebSocket.OPEN;
    private listeners: Map<string, Listener[]> = new Map();

    constructor(public url: string) {
      instances.push(this);
      // Simulate async connection
      setTimeout(() => {
        this.readyState = MockWebSocket.OPEN;
        this.callListeners("open");
      }, 0);
    }

    on(event: string, listener: Listener): void {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
    }

    private callListeners(event: string, ...args: unknown[]): void {
      const list = this.listeners.get(event) ?? [];
      for (const listener of list) {
        listener(...args);
      }
    }

    send(data: string): void {
      this.sentMessages.push(data);
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED;
      this.callListeners("close");
    }

    removeAllListeners(): void {
      this.listeners.clear();
    }

    // Test helpers
    simulateMessage(data: string | Buffer): void {
      this.callListeners("message", data);
    }

    simulateError(error: Error): void {
      this.callListeners("error", error);
    }

    simulateClose(): void {
      this.readyState = MockWebSocket.CLOSED;
      this.callListeners("close");
    }
  }

  return { MockWebSocket, MockWebSocketInstances: instances };
});

// Mock the ws module
vi.mock("ws", () => {
  return {
    WebSocket: MockWebSocket,
  };
});

// Import after mock setup
import { RelayClientService } from "../../src/services/RelayClientService.js";

describe("RelayClientService", () => {
  let service: RelayClientService;
  let mockOnRelayConnection: ReturnType<typeof vi.fn>;
  let mockOnStatusChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocketInstances.length = 0;
    service = new RelayClientService();
    mockOnRelayConnection = vi.fn();
    mockOnStatusChange = vi.fn();
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("start", () => {
    it("connects to relay and registers", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
        onStatusChange: mockOnStatusChange,
      });

      // Should be connecting
      expect(service.getState().status).toBe("connecting");
      expect(mockOnStatusChange).toHaveBeenCalledWith("connecting");

      // Wait for WebSocket connection
      await vi.advanceTimersByTimeAsync(10);

      // Should have sent registration message
      expect(MockWebSocketInstances.length).toBe(1);
      const ws = MockWebSocketInstances[0];
      expect(ws.sentMessages.length).toBe(1);
      expect(JSON.parse(ws.sentMessages[0])).toEqual({
        type: "server_register",
        username: "testuser",
        installId: "install-123",
      });

      // Status should be registering
      expect(service.getState().status).toBe("registering");
    });

    it("includes optional compatibility metadata in registration", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        appVersion: "1.2.3",
        resumeProtocolVersion: 2,
        renderProtocolVersion: 1,
        capabilities: ["git-status", "deviceBridge"],
        onRelayConnection: mockOnRelayConnection,
      });

      await vi.advanceTimersByTimeAsync(10);

      const ws = MockWebSocketInstances[0];
      expect(JSON.parse(ws.sentMessages[0])).toEqual({
        type: "server_register",
        username: "testuser",
        installId: "install-123",
        appVersion: "1.2.3",
        resumeProtocolVersion: 2,
        renderProtocolVersion: 1,
        capabilities: ["git-status", "deviceBridge"],
      });
    });

    it("transitions to waiting on server_registered response", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
        onStatusChange: mockOnStatusChange,
      });

      await vi.advanceTimersByTimeAsync(10);

      const ws = MockWebSocketInstances[0];
      ws.simulateMessage(JSON.stringify({ type: "server_registered" }));

      expect(service.getState().status).toBe("waiting");
      expect(mockOnStatusChange).toHaveBeenCalledWith("waiting");
    });

    it("stops previous connection when starting again", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
      });

      await vi.advanceTimersByTimeAsync(10);

      const firstWs = MockWebSocketInstances[0];

      // Start again with different URL
      service.start({
        relayUrl: "wss://relay2.example.com/ws",
        username: "testuser2",
        installId: "install-456",
        onRelayConnection: mockOnRelayConnection,
      });

      expect(firstWs.readyState).toBe(MockWebSocket.CLOSED);
    });
  });

  describe("stop", () => {
    it("closes connection and sets status to disconnected", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
        onStatusChange: mockOnStatusChange,
      });

      await vi.advanceTimersByTimeAsync(10);

      const ws = MockWebSocketInstances[0];
      ws.simulateMessage(JSON.stringify({ type: "server_registered" }));

      expect(service.getState().status).toBe("waiting");

      service.stop();

      expect(service.getState().status).toBe("disconnected");
      expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    });

    it("clears pending reconnect timer", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
      });

      await vi.advanceTimersByTimeAsync(10);

      const ws = MockWebSocketInstances[0];
      ws.simulateClose();

      // Reconnect should be scheduled
      const instanceCount = MockWebSocketInstances.length;

      service.stop();

      // Advance time past backoff delay
      await vi.advanceTimersByTimeAsync(5000);

      // No new connections should have been created
      expect(MockWebSocketInstances.length).toBe(instanceCount);
    });
  });

  describe("rejection handling", () => {
    it("handles username_taken rejection", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "taken-user",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
        onStatusChange: mockOnStatusChange,
      });

      await vi.advanceTimersByTimeAsync(10);

      const ws = MockWebSocketInstances[0];
      ws.simulateMessage(
        JSON.stringify({ type: "server_rejected", reason: "username_taken" }),
      );

      const state = service.getState();
      expect(state.status).toBe("rejected");
      expect(state.error).toContain("taken-user");
      expect(state.error).toContain("already registered");

      // Should not attempt to reconnect
      await vi.advanceTimersByTimeAsync(120000);
      expect(MockWebSocketInstances.length).toBe(1);
    });

    it("handles invalid_username rejection", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "bad!user",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
        onStatusChange: mockOnStatusChange,
      });

      await vi.advanceTimersByTimeAsync(10);

      const ws = MockWebSocketInstances[0];
      ws.simulateMessage(
        JSON.stringify({ type: "server_rejected", reason: "invalid_username" }),
      );

      const state = service.getState();
      expect(state.status).toBe("rejected");
      expect(state.error).toContain("Invalid username format");
    });
  });

  describe("connection claiming", () => {
    it("detects claim on non-JSON message (SRP init)", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
        onStatusChange: mockOnStatusChange,
      });

      await vi.advanceTimersByTimeAsync(10);

      const ws = MockWebSocketInstances[0];
      ws.simulateMessage(JSON.stringify({ type: "server_registered" }));

      expect(service.getState().status).toBe("waiting");

      // Simulate SRP init message from phone (first message after pairing)
      const srpInit = JSON.stringify({
        type: "srp_hello",
        identity: "testuser",
        A: "some-ephemeral-key",
      });
      ws.simulateMessage(srpInit);

      // Should have called onRelayConnection with the WebSocket, first message, and isBinary flag
      expect(mockOnRelayConnection).toHaveBeenCalledTimes(1);
      expect(mockOnRelayConnection).toHaveBeenCalledWith(ws, srpInit, false);

      // Should have opened a new waiting connection
      await vi.advanceTimersByTimeAsync(10);
      expect(MockWebSocketInstances.length).toBe(2);
    });

    it("detects claim on unknown message type", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
      });

      await vi.advanceTimersByTimeAsync(10);

      const ws = MockWebSocketInstances[0];
      ws.simulateMessage(JSON.stringify({ type: "server_registered" }));

      // Any message that's not a relay protocol message indicates claim
      const unknownMsg = JSON.stringify({ type: "some_random_type" });
      ws.simulateMessage(unknownMsg);

      expect(mockOnRelayConnection).toHaveBeenCalledWith(ws, unknownMsg, false);
    });
  });

  describe("exponential backoff", () => {
    it("reconnects with increasing delays", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
        onStatusChange: mockOnStatusChange,
      });

      await vi.advanceTimersByTimeAsync(10);

      // Close the first connection
      const ws1 = MockWebSocketInstances[0];
      ws1.simulateClose();

      expect(service.getState().reconnectAttempts).toBe(1);

      // First reconnect after 1s
      await vi.advanceTimersByTimeAsync(1000);
      expect(MockWebSocketInstances.length).toBe(2);

      // Close again
      const ws2 = MockWebSocketInstances[1];
      ws2.simulateClose();

      expect(service.getState().reconnectAttempts).toBe(2);

      // Second reconnect after 2s (1s * 2^1)
      await vi.advanceTimersByTimeAsync(1000);
      expect(MockWebSocketInstances.length).toBe(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(MockWebSocketInstances.length).toBe(3);
    });

    it("caps backoff at 60 seconds", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
      });

      await vi.advanceTimersByTimeAsync(10);

      // Simulate many disconnects to reach max backoff
      for (let i = 0; i < 10; i++) {
        const ws = MockWebSocketInstances[MockWebSocketInstances.length - 1];
        ws.simulateClose();
        // Advance time to trigger reconnect
        await vi.advanceTimersByTimeAsync(60000);
        await vi.advanceTimersByTimeAsync(10); // Allow connection to open
      }

      // After 10 disconnects, delay should be capped at 60s
      // 1s * 2^9 = 512s > 60s, so should be 60s
      const lastInstance = MockWebSocketInstances.length;
      const ws = MockWebSocketInstances[lastInstance - 1];
      ws.simulateClose();

      // Should reconnect after max 60s
      await vi.advanceTimersByTimeAsync(60001);
      expect(MockWebSocketInstances.length).toBe(lastInstance + 1);
    });

    it("resets backoff on successful registration", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
      });

      await vi.advanceTimersByTimeAsync(10);

      // Disconnect a few times
      for (let i = 0; i < 3; i++) {
        const ws = MockWebSocketInstances[MockWebSocketInstances.length - 1];
        ws.simulateClose();
        await vi.advanceTimersByTimeAsync(10000); // Advance past backoff
        await vi.advanceTimersByTimeAsync(10);
      }

      // Successfully register
      const ws = MockWebSocketInstances[MockWebSocketInstances.length - 1];
      ws.simulateMessage(JSON.stringify({ type: "server_registered" }));

      expect(service.getState().reconnectAttempts).toBe(0);
    });
  });

  describe("isEnabled", () => {
    it("returns false when not started", () => {
      expect(service.isEnabled()).toBe(false);
    });

    it("returns true when started", () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
      });

      expect(service.isEnabled()).toBe(true);
    });

    it("returns false after stop", () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
      });

      service.stop();

      expect(service.isEnabled()).toBe(false);
    });
  });

  describe("updateRelayUrl", () => {
    it("does nothing if not configured", () => {
      service.updateRelayUrl("wss://new.example.com/ws");
      expect(service.isEnabled()).toBe(false);
    });

    it("reconnects to new URL", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
      });

      await vi.advanceTimersByTimeAsync(10);

      service.updateRelayUrl("wss://new-relay.example.com/ws");

      await vi.advanceTimersByTimeAsync(10);

      const lastWs = MockWebSocketInstances[MockWebSocketInstances.length - 1];
      expect(lastWs.url).toBe("wss://new-relay.example.com/ws");
    });
  });

  describe("updateUsername", () => {
    it("does nothing if not configured", () => {
      service.updateUsername("newuser");
      expect(service.isEnabled()).toBe(false);
    });

    it("reconnects with new username", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
      });

      await vi.advanceTimersByTimeAsync(10);

      service.updateUsername("newuser");

      await vi.advanceTimersByTimeAsync(10);

      const lastWs = MockWebSocketInstances[MockWebSocketInstances.length - 1];
      expect(JSON.parse(lastWs.sentMessages[0]).username).toBe("newuser");
    });
  });
});
