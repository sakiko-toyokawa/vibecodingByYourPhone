/**
 * ACP Proof of Concept - Phase 0
 *
 * Tests the Agent Client Protocol with Gemini CLI.
 * No tool handlers - just validates the protocol works.
 *
 * Run: npx tsx packages/server/src/sdk/providers/acp/poc.ts
 */

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  type Agent,
  type Client,
  ClientSideConnection,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  ndJsonStream,
} from "@agentclientprotocol/sdk";

async function main() {
  console.log("[poc] Starting ACP proof of concept...");

  // Spawn Gemini with ACP mode
  const proc = spawn("gemini", ["--experimental-acp"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stderr?.on("data", (d: Buffer) =>
    console.error("[stderr]", d.toString().trim()),
  );

  proc.on("error", (err) => {
    console.error("[error] Failed to spawn gemini:", err.message);
    process.exit(1);
  });

  proc.on("exit", (code, signal) => {
    console.log("[exit] gemini exited with code", code, "signal", signal);
  });

  // Create the NDJSON stream for ACP
  if (!proc.stdin || !proc.stdout) {
    throw new Error("Failed to get stdin/stdout from spawned process");
  }
  const stream = ndJsonStream(
    Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
  );

  // Create client handlers for session updates
  const createClient = (_agent: Agent): Client => ({
    sessionUpdate: async (params: SessionNotification) => {
      console.log("[session/update]", JSON.stringify(params, null, 2));
    },
    requestPermission: async (
      params: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> => {
      console.log("[permission/request]", JSON.stringify(params, null, 2));
      // For PoC, always cancel - we're not implementing tools yet
      return { outcome: { outcome: "cancelled" } };
    },
  });

  const connection = new ClientSideConnection(createClient, stream);

  try {
    // Initialize the connection
    const initResult = await connection.initialize({
      protocolVersion: 1,
      clientInfo: {
        name: "yepanywhere-poc",
        version: "0.0.1",
      },
      clientCapabilities: {},
    });
    console.log("[init]", JSON.stringify(initResult, null, 2));

    // Create a new session
    const sessionResult = await connection.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });
    console.log("[session]", sessionResult.sessionId);

    // Send a simple prompt
    console.log('[prompt] Sending "What is 2 + 2?"...');
    const promptResult = await connection.prompt({
      sessionId: sessionResult.sessionId,
      prompt: [{ type: "text", text: "What is 2 + 2?" }],
    });
    console.log("[response]", JSON.stringify(promptResult, null, 2));
  } catch (err) {
    console.error("[error]", err);
  } finally {
    proc.kill();
    console.log("[poc] Done.");
  }
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
