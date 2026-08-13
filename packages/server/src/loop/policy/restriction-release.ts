import { isDeepStrictEqual } from "node:util";
import type { PendingToolCall } from "@yep-anywhere/shared";

export const RESTRICTION_RELEASE_BEGIN = "<<<RESTRICTION-RELEASE>>>";
export const RESTRICTION_RELEASE_END = "<<<END-RESTRICTION-RELEASE>>>";

export type ApprovedToolCall = PendingToolCall;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function parseObject(raw: string): Record<string, unknown> | null {
  const candidates = [raw];
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    candidates.push(objectMatch[0]);
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function inputSummary(input: unknown): string {
  if (input && typeof input === "object" && "command" in input) {
    const command = (input as { command?: unknown }).command;
    if (typeof command === "string" && command.trim().length > 0) {
      return command.trim().length > 400
        ? `${command.trim().slice(0, 400)}...`
        : command.trim();
    }
  }
  const serialized = JSON.stringify(input ?? {});
  return serialized.length > 400
    ? `${serialized.slice(0, 400)}...`
    : serialized;
}

/**
 * Extract the structured one-shot restriction release request from a turn's
 * final report. Returns null when the agent did not produce a valid block.
 */
export function extractRestrictionRelease(
  finalText: string,
): ApprovedToolCall | null {
  const start = finalText.indexOf(RESTRICTION_RELEASE_BEGIN);
  if (start === -1) {
    return null;
  }
  const contentStart = start + RESTRICTION_RELEASE_BEGIN.length;
  const end = finalText.indexOf(RESTRICTION_RELEASE_END, contentStart);
  if (end === -1) {
    return null;
  }
  const object = parseObject(finalText.slice(contentStart, end).trim());
  if (!object) {
    return null;
  }
  const tool = nonEmptyString(object.tool);
  const input = object.input;
  if (!tool || input === null || typeof input !== "object") {
    return null;
  }
  const reason = nonEmptyString(object.reason) ?? undefined;
  return {
    tool,
    input,
    summary: inputSummary(input),
    ...(reason ? { reason } : {}),
  };
}

/** Exact tool + input comparison used to consume a one-shot approval. */
export function isSameToolCall(
  left: Pick<ApprovedToolCall, "tool" | "input">,
  right: Pick<ApprovedToolCall, "tool" | "input">,
): boolean {
  return left.tool === right.tool && isDeepStrictEqual(left.input, right.input);
}

/** Human-readable command summary for approval cards. */
export function formatApprovedToolCall(
  toolCall: Pick<ApprovedToolCall, "tool" | "summary" | "input">,
): string {
  return toolCall.summary?.trim()
    ? toolCall.summary.trim()
    : `${toolCall.tool} ${JSON.stringify(toolCall.input)}`;
}
