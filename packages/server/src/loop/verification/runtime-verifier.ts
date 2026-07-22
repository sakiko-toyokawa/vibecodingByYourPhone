/**
 * Runtime verification segment (单测 / smoke).
 *
 * Command selection order: the LoopCard's explicit
 * `loop.verification.commands.runtime` (phase-1 extension field) wins;
 * otherwise probe the workspace package.json scripts.
 */

import type { LoopCard } from "@yep-anywhere/shared";
import { detectRuntimeCommands } from "./detect-commands.js";

export function selectRuntimeCommands(
  card: LoopCard,
  workspacePath: string,
): Promise<string[]> {
  const explicit = card.loop.verification.commands?.runtime;
  if (explicit !== undefined) {
    return Promise.resolve(explicit);
  }
  return detectRuntimeCommands(workspacePath);
}
