export const MAINTENANCE_TARGET_STATES = [
  "pending_approval",
  "awaiting_review",
  "awaiting_feedback",
  "waiting",
  "waking",
  "fixing",
  "needs_human",
  "done",
] as const;

export type MaintenanceTargetState = (typeof MAINTENANCE_TARGET_STATES)[number];

export interface MaintenanceWakePolicy {
  trigger_types: string[];
  max_repairs: number;
}

export interface MaintenanceTarget {
  target_id: string;
  loop_id: string;
  target_type: string;
  external_ref: Record<string, unknown>;
  state: MaintenanceTargetState;
  feedback_cursor: Record<string, unknown>;
  feedback_count: number;
  repair_count: number;
  wake_policy: MaintenanceWakePolicy;
  context_payload: Record<string, unknown>;
  /** Adapter-specific state, e.g. GitHub PR fields and relation_id. */
  adapter_data?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
