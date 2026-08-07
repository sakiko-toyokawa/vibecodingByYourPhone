/**
 * Maintenance server endpoint tests.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  type MaintenanceServerOptions,
  startMaintenanceServer,
} from "./server.js";

function postReload(port: number): Promise<{
  status: number;
  body: unknown;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/reload", method: "POST" },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: data ? JSON.parse(data) : null,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function startServer(opts: Partial<MaintenanceServerOptions> = {}): {
  stop: () => void;
  port: number;
  waitForPort: Promise<number>;
} {
  let resolvePort: (port: number) => void;
  const waitForPort = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  const { stop, server } = startMaintenanceServer({
    port: 0,
    host: "127.0.0.1",
    onReload: () => {},
    ...opts,
  });
  server.once("listening", () => {
    const addr = server.address();
    resolvePort(typeof addr === "object" && addr ? addr.port : 0);
  });
  return { stop, port: 0, waitForPort };
}

test("POST /reload returns 200 when no active runs checker is provided", async () => {
  const { stop, waitForPort } = startServer();
  const port = await waitForPort;
  try {
    const { status, body } = await postReload(port);
    assert.equal(status, 200);
    assert.equal(
      (body as { message?: string }).message,
      "Server restarting...",
    );
  } finally {
    stop();
  }
});

test("POST /reload returns 409 when active runs exist", async () => {
  const { stop, waitForPort } = startServer({
    hasActiveRuns: async () => true,
  });
  const port = await waitForPort;
  try {
    const { status, body } = await postReload(port);
    assert.equal(status, 409);
    assert.equal((body as { error?: string }).error, "active_loop_runs");
  } finally {
    stop();
  }
});

test("POST /reload returns 200 when active runs checker returns false", async () => {
  const { stop, waitForPort } = startServer({
    hasActiveRuns: async () => false,
  });
  const port = await waitForPort;
  try {
    const { status, body } = await postReload(port);
    assert.equal(status, 200);
    assert.equal(
      (body as { message?: string }).message,
      "Server restarting...",
    );
  } finally {
    stop();
  }
});
