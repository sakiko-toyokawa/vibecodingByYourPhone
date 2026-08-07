import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function rmWithRetry(dataDir: string, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await rm(dataDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        i === attempts - 1 ||
        (error as NodeJS.ErrnoException).code !== "ENOTEMPTY"
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (i + 1)));
    }
  }
}

export async function withTempDataDir<T>(
  fn: (dataDir: string) => Promise<T>,
): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-loop-bench-"));
  try {
    return await fn(dataDir);
  } finally {
    await rmWithRetry(dataDir);
  }
}
