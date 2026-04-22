import { z } from "zod";
import { BaseEntrySchema } from "./BaseEntrySchema.js";

export const ProgressEntrySchema = BaseEntrySchema.extend({
  // discriminator
  type: z.literal("progress"),

  // required
  data: z.record(z.string(), z.unknown()),
  toolUseID: z.string(),
  parentToolUseID: z.string(),

  // optional
  slug: z.string().optional(),
  agentId: z.string().optional(),
});

export type ProgressEntry = z.infer<typeof ProgressEntrySchema>;
