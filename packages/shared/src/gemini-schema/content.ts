/**
 * Content block schemas for Gemini CLI output.
 *
 * Gemini uses a different content format than Claude/Codex,
 * with parts containing text, function calls, or function responses.
 */

import { z } from "zod";

/**
 * Text part content.
 */
export const GeminiTextPartSchema = z.object({
  text: z.string(),
});

export type GeminiTextPart = z.infer<typeof GeminiTextPartSchema>;

/**
 * Function call part (tool use).
 */
export const GeminiFunctionCallPartSchema = z.object({
  functionCall: z.object({
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
});

export type GeminiFunctionCallPart = z.infer<
  typeof GeminiFunctionCallPartSchema
>;

/**
 * Function response part (tool result).
 */
export const GeminiFunctionResponsePartSchema = z.object({
  functionResponse: z.object({
    name: z.string(),
    response: z.unknown(),
  }),
});

export type GeminiFunctionResponsePart = z.infer<
  typeof GeminiFunctionResponsePartSchema
>;

/**
 * Inline data part (for images, etc).
 */
export const GeminiInlineDataPartSchema = z.object({
  inlineData: z.object({
    mimeType: z.string(),
    data: z.string(), // base64 encoded
  }),
});

export type GeminiInlineDataPart = z.infer<typeof GeminiInlineDataPartSchema>;

/**
 * Union of all part types.
 */
export const GeminiPartSchema = z.union([
  GeminiTextPartSchema,
  GeminiFunctionCallPartSchema,
  GeminiFunctionResponsePartSchema,
  GeminiInlineDataPartSchema,
]);

export type GeminiPart = z.infer<typeof GeminiPartSchema>;

/**
 * Content - array of parts.
 */
export const GeminiContentSchema = z.object({
  role: z.enum(["user", "model"]),
  parts: z.array(GeminiPartSchema),
});

export type GeminiContent = z.infer<typeof GeminiContentSchema>;
