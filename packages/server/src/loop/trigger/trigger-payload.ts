import { z } from "zod";

/**
 * Trigger queue payload schema. Producers no longer hand-roll string maps;
 * dispatcher and route layers share this single contract so a new trigger
 * type only needs a schema extension.
 */
export const TriggerQueuePayloadSchema = z
  .object({
    relation_id: z.string().min(1).optional(),
    maintenance_id: z.string().min(1).optional(),
    run_id: z.string().min(1).optional(),
    event_type: z.string().min(1).optional(),
    event_types: z.array(z.string().min(1)).optional(),
    repository: z.string().min(1).optional(),
    pr_number: z.number().int().positive().optional(),
    head_sha: z.string().min(1).optional(),
    polled_at: z.string().min(1).optional(),
    comment_id: z.number().int().positive().optional(),
    issue_comment_id: z.number().int().positive().optional(),
    review_id: z.number().int().positive().optional(),
    external_ref: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type TriggerQueuePayload = z.infer<typeof TriggerQueuePayloadSchema>;

export type TriggerPayloadSource =
  | "webhook"
  | "issue"
  | "resume"
  | "cron"
  | "manual";

export class TriggerPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriggerPayloadError";
  }
}

export function parseTriggerPayload(
  source: TriggerPayloadSource,
  payload: Record<string, unknown>,
): TriggerQueuePayload {
  const parsed = TriggerQueuePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new TriggerPayloadError(
      `invalid ${source} trigger payload: ${message}`,
    );
  }
  if (source === "resume" && !parsed.data.run_id) {
    throw new TriggerPayloadError("resume trigger payload must include run_id");
  }
  if (
    (source === "webhook" || source === "issue") &&
    !parsed.data.relation_id &&
    !parsed.data.maintenance_id
  ) {
    throw new TriggerPayloadError(
      "webhook/issue trigger payload must include relation_id or maintenance_id",
    );
  }
  return parsed.data;
}
