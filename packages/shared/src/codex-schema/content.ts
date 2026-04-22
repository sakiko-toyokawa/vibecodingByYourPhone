/**
 * Content block schemas for Codex messages.
 *
 * Codex uses a similar content block format to Claude,
 * with text, tool_use, and tool_result blocks.
 */

import { z } from "zod";

/**
 * Text content block.
 */
export const CodexTextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export type CodexTextContent = z.infer<typeof CodexTextContentSchema>;

/**
 * Tool use content block (function call).
 */
export const CodexToolUseContentSchema = z.object({
  type: z.literal("function_call"),
  id: z.string(),
  name: z.string(),
  arguments: z.string(), // JSON string of arguments
});

export type CodexToolUseContent = z.infer<typeof CodexToolUseContentSchema>;

/**
 * Tool result content block.
 */
export const CodexToolResultContentSchema = z.object({
  type: z.literal("function_call_output"),
  call_id: z.string(),
  output: z.string(),
});

export type CodexToolResultContent = z.infer<
  typeof CodexToolResultContentSchema
>;

/**
 * Reasoning content block (thinking/chain-of-thought).
 * Codex may encrypt reasoning content.
 */
export const CodexReasoningContentSchema = z.object({
  type: z.literal("reasoning"),
  id: z.string().optional(),
  summary: z
    .array(
      z.object({
        type: z.literal("summary_text"),
        text: z.string(),
      }),
    )
    .optional(),
  // Encrypted reasoning content
  encrypted: z.boolean().optional(),
});

export type CodexReasoningContent = z.infer<typeof CodexReasoningContentSchema>;

/**
 * Union of all content block types.
 */
export const CodexContentBlockSchema = z.discriminatedUnion("type", [
  CodexTextContentSchema,
  CodexToolUseContentSchema,
  CodexToolResultContentSchema,
  CodexReasoningContentSchema,
]);

export type CodexContentBlock = z.infer<typeof CodexContentBlockSchema>;

/**
 * Message content - can be a string or array of content blocks.
 */
export const CodexMessageContentSchema = z.union([
  z.string(),
  z.array(CodexContentBlockSchema),
]);

export type CodexMessageContent = z.infer<typeof CodexMessageContentSchema>;
