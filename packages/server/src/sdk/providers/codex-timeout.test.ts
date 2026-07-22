import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AdapterError } from "../adapter-error.js";
import { CodexAppServerClient, resolveRequestTimeoutMs } from "./codex.js";

/**
 * Loop phase-1 acceptance (05-分阶段计划.md 验收 4): a hung app-server must
 * not leave JSON-RPC requests dangling forever — the request fails within
 * the configured timeout with the unified `timeout` error code, the pending
 * table does not leak, and the child process is cleaned up.
 *
 * The fake app-server is a node fixture script that accepts stdio but never
 * writes a single JSON-RPC frame back (hung server), plus an echo fixture
 * that answers requests (normal-path regression guard).
 */

const REQUEST_TIMEOUT_MS = 250;

let fixtureDir: string;
let hangingFixture: string;
let echoFixture: string;

before(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "codex-fake-app-server-"));
  hangingFixture = join(fixtureDir, "hanging.js");
  // Reads stdin (so writes never block) but never responds — a hung server.
  writeFileSync(hangingFixture, "process.stdin.resume();\n");
  echoFixture = join(fixtureDir, "echo.js");
  writeFileSync(
    echoFixture,
    `let b = "";
process.stdin.on("data", (c) => {
  b += c;
  let i;
  while ((i = b.indexOf("\\n")) >= 0) {
    const line = b.slice(0, i);
    b = b.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { ok: true } }) + "\\n");
    }
  }
});
`,
  );
});

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function makeClient(script: string, timeoutMs = REQUEST_TIMEOUT_MS) {
  // "node" (via PATH) instead of process.execPath: the client's spawn uses
  // shell:true on Windows, where an unquoted path with spaces would break.
  return new (class extends CodexAppServerClient {
    protected override getAppServerArgs(): string[] {
      return [script];
    }
  })("node", process.cwd(), { ...process.env }, timeoutMs);
}

test("hung app-server: request rejects with AdapterError code=timeout within the configured timeout", async () => {
  const client = makeClient(hangingFixture);
  await client.connect();
  const pid = client.pid;
  assert.ok(pid, "app-server child should have a pid");

  // A consumer waiting on notifications must receive the terminal error
  // notification (same shape as the process-exit fallback path).
  const terminalNotification = client.nextNotification();

  const startedAt = Date.now();
  await assert.rejects(
    client.request("thread/start", { cwd: process.cwd() }),
    (error: unknown) => {
      assert.ok(error instanceof AdapterError, "must be an AdapterError");
      assert.equal((error as AdapterError).code, "timeout");
      return true;
    },
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed >= REQUEST_TIMEOUT_MS - 50,
    `rejected too early (${elapsed}ms < ${REQUEST_TIMEOUT_MS}ms)`,
  );
  assert.ok(
    elapsed < REQUEST_TIMEOUT_MS + 5000,
    `rejected too late (${elapsed}ms)`,
  );

  // pendingRequests must not leak the timed-out request.
  assert.equal(client.pendingRequestCount, 0);

  // Terminal error notification for consumers (error + willRetry: false).
  const notification = await terminalNotification;
  assert.equal(notification.method, "error");
  const params = notification.params as {
    error?: { message?: string };
    willRetry?: boolean;
  };
  assert.match(params.error?.message ?? "", /timed out/);
  assert.equal(params.willRetry, false);

  // The hung child process is terminated (poll the OS pid).
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) {
    try {
      process.kill(pid as number, 0);
    } catch {
      alive = false;
    }
    if (alive) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(alive, false, "hung app-server child must be cleaned up");
});

test("responsive app-server: normal request/response path is unchanged", async () => {
  const client = makeClient(echoFixture, 5000);
  await client.connect();
  try {
    const result = await client.request<{ ok: boolean }>("initialize", {
      clientInfo: { name: "test", version: "0" },
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(client.pendingRequestCount, 0);
  } finally {
    client.close();
  }
  assert.equal(client.isAlive(), false);
});

test("request timeout resolution: config > env > 60s default", () => {
  const ENV_KEY = "YEP_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS";
  const previous = process.env[ENV_KEY];
  try {
    delete process.env[ENV_KEY];
    assert.equal(resolveRequestTimeoutMs(undefined), 60_000);

    process.env[ENV_KEY] = "12345";
    assert.equal(resolveRequestTimeoutMs(undefined), 12_345);

    // per-instance config wins over env
    assert.equal(resolveRequestTimeoutMs(500), 500);

    // invalid values fall through
    process.env[ENV_KEY] = "not-a-number";
    assert.equal(resolveRequestTimeoutMs(undefined), 60_000);
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = previous;
    }
  }
});
