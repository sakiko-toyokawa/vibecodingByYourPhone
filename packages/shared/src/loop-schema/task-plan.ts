import { z } from "zod";

/**
 * TaskPlan — produced by the Planner Agent at intent-contract time.
 *
 * It decomposes a complex task into ordered subtasks. The loop run-service
 * consumes the plan so that each turn is responsible for one subtask,
 * preventing a single turn from finishing (or pretending to finish) the
 * whole task.
 */

export const SubTaskSchema = z.object({
  /** Stable identifier for this subtask (e.g. "subtask-1"). */
  id: z.string(),
  /** Human-readable description of what this turn must do. */
  description: z.string(),
  /** Criteria that must be satisfied for the subtask to be considered done. */
  success_criteria: z.array(z.string()),
  /** Expected files / artifacts this subtask should produce. */
  target_artifacts: z.array(z.string()).default([]),
});

export const TaskPlanSchema = z.object({
  /** Unique identifier for this plan (usually tied to the run/intent). */
  plan_id: z.string(),
  /** ISO timestamp when the plan was created. */
  created_at: z.string(),
  /** Ordered list of subtasks; executed one per turn. */
  subtasks: z.array(SubTaskSchema).min(1),
});

export type SubTask = z.infer<typeof SubTaskSchema>;
export type TaskPlan = z.infer<typeof TaskPlanSchema>;
