import {
  type RelayServerCompatibilityMetadata,
  isValidRelayUsername,
} from "@yep-anywhere/shared";
import type { WebSocket } from "ws";
import type { UsernameRegistry } from "./registry.js";

export type RegistrationResult =
  | "registered"
  | "username_taken"
  | "invalid_username";

export type ConnectionResult =
  | {
      status: "connected";
      serverWs: WebSocket;
      server: ActiveRelayServer | null;
    }
  | { status: "server_offline" }
  | { status: "unknown_username" };

export type CloseResult =
  | { kind: "waiting_server_closed"; server: ActiveRelayServer | null }
  | {
      kind: "pair_disconnected";
      initiator: "server" | "client";
      server: ActiveRelayServer | null;
    }
  | { kind: "none" };

interface Pair {
  server: WebSocket;
  client: WebSocket;
}

export interface ActiveRelayServer extends RelayServerCompatibilityMetadata {
  username: string;
  installId: string;
  connectedAt: string;
  state: "waiting" | "paired";
}

interface SummaryBucket<T> {
  value: T | null;
  count: number;
}

export interface ActiveRelayServerSummary {
  appVersions: SummaryBucket<string>[];
  resumeProtocolVersions: SummaryBucket<number>[];
  renderProtocolVersions: SummaryBucket<number>[];
  capabilities: Array<{ capability: string; count: number }>;
}

/**
 * Manages WebSocket connections for the relay.
 *
 * Responsibilities:
 * - Track waiting server connections (one per username)
 * - Match clients to waiting servers
 * - Forward messages between paired connections
 * - Clean up on disconnect
 */
export class ConnectionManager {
  /** Waiting server connections by username */
  private waiting = new Map<string, WebSocket>();
  /** Active server/client pairs */
  private pairs = new Set<Pair>();
  /** Lookup from WebSocket to its pair (for forwarding) */
  private pairLookup = new Map<WebSocket, Pair>();
  /** Active server connections keyed by the server WebSocket. */
  private activeServers = new Map<WebSocket, ActiveRelayServer>();
  /** Registry for username validation */
  private registry: UsernameRegistry;

  constructor(registry: UsernameRegistry) {
    this.registry = registry;
  }

  /**
   * Register a server's waiting connection.
   *
   * @param ws - The WebSocket connection
   * @param username - Username to register
   * @param installId - Installation ID for ownership verification
   * @returns Registration result
   */
  registerServer(
    ws: WebSocket,
    username: string,
    installId: string,
    metadata: RelayServerCompatibilityMetadata = {},
  ): RegistrationResult {
    // Validate username format
    if (!isValidRelayUsername(username)) {
      return "invalid_username";
    }

    // Check registry (persistent ownership)
    if (!this.registry.canRegister(username, installId)) {
      return "username_taken";
    }

    // Register in persistent storage
    if (!this.registry.register(username, installId)) {
      return "username_taken";
    }

    // Close existing waiting connection for this username (same installId reconnecting)
    const existingWaiting = this.waiting.get(username);
    if (existingWaiting) {
      this.activeServers.delete(existingWaiting);
      try {
        existingWaiting.close(1000, "Replaced by new connection");
      } catch {
        // Ignore close errors
      }
    }

    // Store as waiting connection
    this.waiting.set(username, ws);
    this.activeServers.set(ws, {
      username,
      installId,
      connectedAt: new Date().toISOString(),
      state: "waiting",
      appVersion: metadata.appVersion,
      resumeProtocolVersion: metadata.resumeProtocolVersion,
      renderProtocolVersion: metadata.renderProtocolVersion,
      capabilities: metadata.capabilities
        ? [...metadata.capabilities]
        : undefined,
    });

    return "registered";
  }

  /**
   * Connect a client to a waiting server.
   *
   * @param ws - The client WebSocket connection
   * @param username - Username to connect to
   * @returns Connection result with server WebSocket on success
   */
  connectClient(ws: WebSocket, username: string): ConnectionResult {
    // Check if username is registered at all
    if (!this.registry.isRegistered(username)) {
      return { status: "unknown_username" };
    }

    // Check if server is currently online (has a waiting connection)
    const serverWs = this.waiting.get(username);
    if (!serverWs) {
      return { status: "server_offline" };
    }

    // Remove from waiting map (server is now paired)
    this.waiting.delete(username);
    const serverInfo = this.activeServers.get(serverWs);
    if (serverInfo) {
      serverInfo.state = "paired";
    }

    // Create pair
    const pair: Pair = { server: serverWs, client: ws };
    this.pairs.add(pair);
    this.pairLookup.set(serverWs, pair);
    this.pairLookup.set(ws, pair);

    // Update last seen for the username
    this.registry.updateLastSeen(username);

    return { status: "connected", serverWs, server: serverInfo ?? null };
  }

  /**
   * Forward data from one WebSocket to its pair.
   * Preserves frame type (text vs binary) by using the isBinary flag.
   *
   * @param ws - Source WebSocket
   * @param data - Data to forward (Buffer from ws library)
   * @param isBinary - Whether the data was received as a binary frame
   */
  forward(ws: WebSocket, data: Buffer, isBinary: boolean): void {
    const pair = this.pairLookup.get(ws);
    if (!pair) {
      return; // Not paired, ignore
    }

    // Determine the other end
    const target = pair.server === ws ? pair.client : pair.server;

    try {
      // Use the isBinary flag to preserve frame type
      target.send(data, { binary: isBinary });
    } catch {
      // Ignore send errors (connection may have closed)
    }
  }

  /**
   * Handle WebSocket close event.
   * Cleans up waiting/paired state and closes the other end if paired.
   *
   * @param ws - The WebSocket that closed
   * @param username - Username associated with this connection (if known)
   * @returns true if a pair was disconnected, false otherwise
   */
  handleClose(ws: WebSocket, username?: string): CloseResult {
    // Check if this was a waiting connection
    if (username) {
      const waitingWs = this.waiting.get(username);
      if (waitingWs === ws) {
        const serverInfo = this.activeServers.get(ws) ?? null;
        this.waiting.delete(username);
        this.activeServers.delete(ws);
        return { kind: "waiting_server_closed", server: serverInfo };
      }
    }

    // Check if this was part of a pair
    const pair = this.pairLookup.get(ws);
    if (pair) {
      const serverInfo = this.activeServers.get(pair.server) ?? null;
      this.pairs.delete(pair);
      this.pairLookup.delete(pair.server);
      this.pairLookup.delete(pair.client);
      this.activeServers.delete(pair.server);

      // Close the other end
      const other = pair.server === ws ? pair.client : pair.server;
      try {
        other.close(1000, "Peer disconnected");
      } catch {
        // Ignore close errors
      }
      return {
        kind: "pair_disconnected",
        initiator: pair.server === ws ? "server" : "client",
        server: serverInfo,
      };
    }
    return { kind: "none" };
  }

  /**
   * Check if a WebSocket is currently paired.
   */
  isPaired(ws: WebSocket): boolean {
    return this.pairLookup.has(ws);
  }

  /**
   * Check if a WebSocket is waiting for a client.
   */
  isWaitingWs(ws: WebSocket): boolean {
    for (const waitingWs of this.waiting.values()) {
      if (waitingWs === ws) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a username has a server waiting for a client.
   */
  isWaiting(username: string): boolean {
    return this.waiting.has(username);
  }

  /**
   * Get the number of waiting connections.
   */
  getWaitingCount(): number {
    return this.waiting.size;
  }

  /**
   * Get the number of active pairs.
   */
  getPairCount(): number {
    return this.pairs.size;
  }

  /**
   * Get all waiting usernames (for debugging/admin).
   */
  getWaitingUsernames(): string[] {
    return Array.from(this.waiting.keys());
  }

  /**
   * Get all active server registrations, including paired connections.
   */
  getActiveServers(): ActiveRelayServer[] {
    return Array.from(this.activeServers.values()).sort((a, b) =>
      a.username.localeCompare(b.username),
    );
  }

  /**
   * Summarize active server compatibility metadata for observability.
   */
  getActiveServerSummary(): ActiveRelayServerSummary {
    const activeServers = this.getActiveServers();
    return {
      appVersions: summarizeOptionalValues(
        activeServers,
        (server) => server.appVersion ?? null,
      ),
      resumeProtocolVersions: summarizeOptionalValues(
        activeServers,
        (server) => server.resumeProtocolVersion ?? null,
      ),
      renderProtocolVersions: summarizeOptionalValues(
        activeServers,
        (server) => server.renderProtocolVersion ?? null,
      ),
      capabilities: summarizeCapabilities(activeServers),
    };
  }
}

function summarizeOptionalValues<T extends string | number>(
  activeServers: ActiveRelayServer[],
  getValue: (server: ActiveRelayServer) => T | null,
): SummaryBucket<T>[] {
  const counts = new Map<T | null, number>();
  for (const server of activeServers) {
    const value = getValue(server);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      if (typeof a.value === "number" && typeof b.value === "number") {
        return a.value - b.value;
      }
      return String(a.value).localeCompare(String(b.value));
    });
}

function summarizeCapabilities(
  activeServers: ActiveRelayServer[],
): Array<{ capability: string; count: number }> {
  const counts = new Map<string, number>();
  for (const server of activeServers) {
    for (const capability of new Set(server.capabilities ?? [])) {
      counts.set(capability, (counts.get(capability) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([capability, count]) => ({ capability, count }))
    .sort((a, b) =>
      b.count === a.count
        ? a.capability.localeCompare(b.capability)
        : b.count - a.count,
    );
}
