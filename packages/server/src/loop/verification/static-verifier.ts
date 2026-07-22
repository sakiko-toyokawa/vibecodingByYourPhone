/**
 * Static verification segment (lint / typecheck 等确定性检查).
 *
 * Command selection order: the LoopCard's explicit
 * `loop.verification.commands.static` (phase-1 extension field) wins;
 * otherwise probe the workspace package.json scripts.
 */

import type { LoopCard } from "@yep-anywhere/shared";
import { detectStaticCommands } from "./detect-commands.js";

export function selectStaticCommands(
  card: LoopCard,
  workspacePath: string,
): Promise<string[]> {
  const explicit = card.loop.verification.commands?.static;
  if (explicit !== undefined) {
    return Promise.resolve(explicit);
  }
  return detectStaticCommands(workspacePath);
}
