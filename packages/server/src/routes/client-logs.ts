import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";

const MAX_ENTRIES_PER_REQUEST = 500;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface LogEntry {
  id?: number;
  timestamp: number;
  level: string;
  prefix: string;
  message: string;
}

interface ClientLogsBody {
  entries: LogEntry[];
  deviceId?: string;
}

export interface ClientLogsRoutesOptions {
  dataDir: string;
}

export function createClientLogsRoutes(options: ClientLogsRoutesOptions): Hono {
  const app = new Hono();
  const logsDir = join(options.dataDir, "logs", "client-logs");
  let dirCreated = false;

  function ensureDir(): void {
    if (!dirCreated) {
      mkdirSync(logsDir, { recursive: true });
      dirCreated = true;
    }
  }

  app.post("/", async (c) => {
    let body: ClientLogsBody;
    try {
      body = await c.req.json<ClientLogsBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!Array.isArray(body.entries) || body.entries.length === 0) {
      return c.json({ error: "entries must be a non-empty array" }, 400);
    }

    const entries = body.entries.slice(0, MAX_ENTRIES_PER_REQUEST);

    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    let filename: string;
    if (body.deviceId && UUID_REGEX.test(body.deviceId)) {
      filename = `client-${date}-${body.deviceId}.jsonl`;
    } else {
      const random = Math.random().toString(36).slice(2, 8);
      filename = `client-${date}-${random}.jsonl`;
    }

    ensureDir();

    const lines = entries.map((entry) =>
      JSON.stringify({
        ...entry,
        _receivedAt: Date.now(),
      }),
    );

    appendFileSync(join(logsDir, filename), `${lines.join("\n")}\n`);

    return c.json({ received: entries.length });
  });

  return app;
}
