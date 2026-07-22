import { closeCodexCorrelationDebugLogger } from "./codex/correlationDebugLogger.js";
import type { DeviceBridgeService } from "./device/DeviceBridgeService.js";

interface ShutdownSupervisor {
  getAllProcesses(): Array<{
    sessionId: string;
    abort(): Promise<void>;
  }>;
}

let supervisorForShutdown: ShutdownSupervisor | null = null;
let deviceBridgeForShutdown: DeviceBridgeService | null = null;
let isShuttingDown = false;

export function setSupervisorForShutdown(
  supervisor: ShutdownSupervisor | null,
): void {
  supervisorForShutdown = supervisor;
}

export function setDeviceBridgeForShutdown(
  deviceBridge: DeviceBridgeService | null,
): void {
  deviceBridgeForShutdown = deviceBridge;
}

export async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    console.log(`[Shutdown] Already shutting down, ignoring ${signal}`);
    return;
  }
  isShuttingDown = true;

  console.log(`[Shutdown] Received ${signal}, cleaning up...`);

  if (supervisorForShutdown) {
    const processes = supervisorForShutdown.getAllProcesses();
    if (processes.length > 0) {
      console.log(
        `[Shutdown] Aborting ${processes.length} active session(s)...`,
      );
      await Promise.all(
        processes.map(async (p) => {
          try {
            await p.abort();
            console.log(`[Shutdown] Aborted session ${p.sessionId}`);
          } catch (error) {
            console.error(
              `[Shutdown] Error aborting session ${p.sessionId}:`,
              error,
            );
          }
        }),
      );
    }
  }

  if (deviceBridgeForShutdown) {
    try {
      await deviceBridgeForShutdown.shutdown();
      console.log("[Shutdown] Device bridge shut down");
    } catch (error) {
      console.error("[Shutdown] Error shutting down emulator bridge:", error);
    }
  }

  closeCodexCorrelationDebugLogger();
  console.log("[Shutdown] Cleanup complete, exiting");
  process.exit(0);
}

export function registerShutdownHandlers(): void {
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

export function registerUnhandledRejectionHandler(): void {
  process.on("unhandledRejection", (reason) => {
    const message =
      reason instanceof Error ? reason.message : String(reason ?? "unknown");
    const stack = reason instanceof Error ? reason.stack : undefined;

    const isTransportError =
      message.includes("ProcessTransport is not ready") ||
      message.includes("not ready for writing");

    if (isTransportError) {
      console.warn(
        `[unhandledRejection] SDK transport error (session process likely died): ${message}`,
      );
      return;
    }

    console.error(`[unhandledRejection] ${message}`);
    if (stack) {
      console.error(stack);
    }
    process.exit(1);
  });
}
