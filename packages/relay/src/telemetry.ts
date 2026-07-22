import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "pino";

export interface RelayTelemetryConfig {
  enabled: boolean;
  eventsDir: string;
  nodeId: string;
  sampleIntervalMs: number;
}

export interface RelayTelemetryStatus {
  enabled: boolean;
  eventsDir: string | null;
  currentDate: string | null;
  currentFilePath: string | null;
  nodeId: string | null;
  sampleIntervalMs: number | null;
}

export interface RelayConnectionSnapshot {
  waiting: number;
  pairs: number;
  registered: number;
  activeServers: number;
}

interface RelayTelemetryEventBase {
  timestamp: string;
  relayNodeId: string;
}

interface ServerCompatibilityFields {
  installId?: string;
  appVersion?: string;
  resumeProtocolVersion?: number;
  renderProtocolVersion?: number;
  capabilities?: string[];
}

export type RelayTelemetryEvent =
  | (RelayTelemetryEventBase &
      ServerCompatibilityFields & {
        event: "server_register";
        username: string;
      })
  | (RelayTelemetryEventBase &
      Pick<ServerCompatibilityFields, "installId"> & {
        event: "server_disconnect";
        username: string;
        connectionState: "waiting" | "paired";
        closeCode: number;
        closeReason: string;
      })
  | (RelayTelemetryEventBase &
      ServerCompatibilityFields & {
        event: "client_connect_success";
        username: string;
      })
  | (RelayTelemetryEventBase & {
      event: "client_connect_error";
      username: string;
      reason: "server_offline" | "unknown_username";
    })
  | (RelayTelemetryEventBase & {
      event: "pair_disconnected";
      username: string;
      initiator: "server" | "client";
      closeCode: number;
      closeReason: string;
    })
  | (RelayTelemetryEventBase &
      RelayConnectionSnapshot & {
        event: "connection_sample";
      });

type RelayTelemetryEventInput =
  | (ServerCompatibilityFields & {
      event: "server_register";
      username: string;
    })
  | (Pick<ServerCompatibilityFields, "installId"> & {
      event: "server_disconnect";
      username: string;
      connectionState: "waiting" | "paired";
      closeCode: number;
      closeReason: string;
    })
  | (ServerCompatibilityFields & {
      event: "client_connect_success";
      username: string;
    })
  | {
      event: "client_connect_error";
      username: string;
      reason: "server_offline" | "unknown_username";
    }
  | {
      event: "pair_disconnected";
      username: string;
      initiator: "server" | "client";
      closeCode: number;
      closeReason: string;
    }
  | (RelayConnectionSnapshot & {
      event: "connection_sample";
    });

export interface RelayTelemetryRecorder {
  record(event: RelayTelemetryEventInput): void;
  startSampling(getSnapshot: () => RelayConnectionSnapshot): void;
  getStatus(): RelayTelemetryStatus;
  close(): Promise<void>;
}

function getUtcDate(ts: Date): string {
  return ts.toISOString().slice(0, 10);
}

class JsonlRelayTelemetryRecorder implements RelayTelemetryRecorder {
  private currentDate = "";
  private currentFilePath = "";
  private stream: fs.WriteStream | null = null;
  private sampleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: RelayTelemetryConfig,
    private readonly logger: Logger,
  ) {
    fs.mkdirSync(config.eventsDir, { recursive: true });
  }

  private getStream(now: Date): fs.WriteStream {
    const date = getUtcDate(now);
    if (this.stream && this.currentDate === date) {
      return this.stream;
    }

    this.stream?.end();
    this.currentDate = date;
    this.currentFilePath = path.join(this.config.eventsDir, `${date}.ndjson`);
    this.stream = fs.createWriteStream(this.currentFilePath, { flags: "a" });
    this.stream.on("error", (error) => {
      this.logger.error({ error }, "Relay telemetry stream error");
    });
    return this.stream;
  }

  record(event: RelayTelemetryEventInput): void {
    const now = new Date();
    const line = JSON.stringify({
      timestamp: now.toISOString(),
      relayNodeId: this.config.nodeId,
      ...event,
    });

    try {
      const stream = this.getStream(now);
      stream.write(`${line}\n`);
    } catch (error) {
      this.logger.error({ error }, "Failed to write relay telemetry event");
    }
  }

  startSampling(getSnapshot: () => RelayConnectionSnapshot): void {
    if (this.sampleTimer) {
      return;
    }

    this.sampleTimer = setInterval(() => {
      this.record({
        event: "connection_sample",
        ...getSnapshot(),
      });
    }, this.config.sampleIntervalMs);
    this.sampleTimer.unref?.();
  }

  getStatus(): RelayTelemetryStatus {
    return {
      enabled: true,
      eventsDir: this.config.eventsDir,
      currentDate: this.currentDate || null,
      currentFilePath: this.currentFilePath || null,
      nodeId: this.config.nodeId,
      sampleIntervalMs: this.config.sampleIntervalMs,
    };
  }

  async close(): Promise<void> {
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }

    if (!this.stream) {
      return;
    }

    const stream = this.stream;
    this.stream = null;
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
  }
}

class DisabledRelayTelemetryRecorder implements RelayTelemetryRecorder {
  record(): void {}

  startSampling(): void {}

  getStatus(): RelayTelemetryStatus {
    return {
      enabled: false,
      eventsDir: null,
      currentDate: null,
      currentFilePath: null,
      nodeId: null,
      sampleIntervalMs: null,
    };
  }

  async close(): Promise<void> {}
}

export function createRelayTelemetryRecorder(
  config: RelayTelemetryConfig,
  logger: Logger,
): RelayTelemetryRecorder {
  if (!config.enabled) {
    return new DisabledRelayTelemetryRecorder();
  }
  return new JsonlRelayTelemetryRecorder(config, logger);
}
