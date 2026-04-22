import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createRelayTelemetryRecorder } from "../src/telemetry.js";

describe("Relay telemetry", () => {
  const tempDirs: string[] = [];
  const today = new Date().toISOString().slice(0, 10);

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes append-only structured events to jsonl", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-telemetry-"));
    tempDirs.push(dir);
    const telemetry = createRelayTelemetryRecorder(
      {
        enabled: true,
        eventsDir: dir,
        nodeId: "relay-test",
        sampleIntervalMs: 60_000,
      },
      pino({ level: "silent" }),
    );

    telemetry.record({
      event: "server_register",
      username: "alice",
      installId: "install-1",
      appVersion: "1.2.3",
      resumeProtocolVersion: 2,
      capabilities: ["git-status"],
    });
    telemetry.record({
      event: "client_connect_success",
      username: "alice",
      installId: "install-1",
    });

    await telemetry.close();

    const content = readFileSync(join(dir, `${today}.ndjson`), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({
      event: "server_register",
      relayNodeId: "relay-test",
      username: "alice",
      installId: "install-1",
      appVersion: "1.2.3",
      resumeProtocolVersion: 2,
      capabilities: ["git-status"],
    });
    expect(content[1]).toMatchObject({
      event: "client_connect_success",
      relayNodeId: "relay-test",
      username: "alice",
      installId: "install-1",
    });
  });

  it("records periodic connection samples", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-telemetry-"));
    tempDirs.push(dir);
    const telemetry = createRelayTelemetryRecorder(
      {
        enabled: true,
        eventsDir: dir,
        nodeId: "relay-test",
        sampleIntervalMs: 20,
      },
      pino({ level: "silent" }),
    );

    telemetry.startSampling(() => ({
      waiting: 3,
      pairs: 2,
      registered: 5,
      activeServers: 5,
    }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    await telemetry.close();

    const content = readFileSync(join(dir, `${today}.ndjson`), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(
      content.some(
        (event) =>
          event.event === "connection_sample" &&
          event.waiting === 3 &&
          event.pairs === 2 &&
          event.registered === 5 &&
          event.activeServers === 5,
      ),
    ).toBe(true);
  });

  it("reports the current daily file in telemetry status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-telemetry-"));
    tempDirs.push(dir);
    const telemetry = createRelayTelemetryRecorder(
      {
        enabled: true,
        eventsDir: dir,
        nodeId: "relay-test",
        sampleIntervalMs: 60_000,
      },
      pino({ level: "silent" }),
    );

    telemetry.record({
      event: "client_connect_error",
      username: "alice",
      reason: "server_offline",
    });

    expect(telemetry.getStatus()).toMatchObject({
      enabled: true,
      eventsDir: dir,
      currentDate: today,
      currentFilePath: join(dir, `${today}.ndjson`),
      nodeId: "relay-test",
      sampleIntervalMs: 60_000,
    });

    await telemetry.close();
  });
});
