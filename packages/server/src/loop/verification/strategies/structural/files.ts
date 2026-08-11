import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  "target",
  ".venv",
  "venv",
  "__pycache__",
]);

/** Recursively find files matching a predicate, bounded for safety. */
export async function findFiles(
  root: string,
  predicate: (filePath: string) => boolean,
  maxFiles = 5000,
): Promise<string[]> {
  const results: string[] = [];
  const stack = [root];
  while (stack.length > 0 && results.length < maxFiles) {
    const current = stack.pop();
    if (!current) continue;
    let entries: Dirent[] = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          stack.push(full);
        }
      } else if (entry.isFile() && predicate(full)) {
        results.push(full);
      }
    }
  }
  return results;
}
