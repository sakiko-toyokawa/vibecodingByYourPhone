/** Small checksum helpers shared by state, ledger, and artifact stores. */

import { createHash } from "node:crypto";

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function checksumOfJson(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
}
