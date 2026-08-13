import { z } from "zod";

/**
 * Run-level structured working memory for multi-turn agent loops.
 *
 * Unlike machine-state.json, this is domain state owned by the executor:
 * which GitHub subject was selected, where it was cloned, and how each
 * planner subtask is progressing. It is intentionally optional and
 * fail-open; when absent the next turn still has the prose handoff.
 */
export const SelectedSubjectSchema = z.object({
  repository: z.string(),
  issue_url: z.string().optional(),
  issue_number: z.number().int().optional(),
  clone_path: z.string(),
  branch: z.string().optional(),
  base_sha: z.string().optional(),
});
export type SelectedSubject = z.infer<typeof SelectedSubjectSchema>;

export const SubtaskStatusSchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "in_progress", "done", "failed"]),
  outputs: z.string().optional(),
});
export type SubtaskStatus = z.infer<typeof SubtaskStatusSchema>;

export const RunWorkingStateSchema = z.object({
  schema_version: z.number().int().positive().default(1),
  run_id: z.string(),
  updated_at: z.string().datetime(),
  turn: z.number().int().nonnegative(),
  selected_subject: SelectedSubjectSchema.nullable().default(null),
  subtask_status: z.array(SubtaskStatusSchema).default([]),
});
export type RunWorkingState = z.infer<typeof RunWorkingStateSchema>;
