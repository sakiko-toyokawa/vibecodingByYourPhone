import { fetchJSON } from "./client";

export type MaintenanceTargetState =
  | "pending_approval"
  | "awaiting_review"
  | "awaiting_feedback"
  | "waiting"
  | "waking"
  | "fixing"
  | "needs_human"
  | "done";

export interface MaintenanceTarget {
  target_id: string;
  loop_id: string;
  target_type: string;
  external_ref: Record<string, unknown>;
  state: MaintenanceTargetState;
  feedback_cursor: Record<string, unknown>;
  feedback_count: number;
  repair_count: number;
  wake_policy: {
    trigger_types: string[];
    max_repairs: number;
  };
  context_payload: Record<string, unknown>;
  adapter_data?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export const maintenanceApi = {
  listTargets: (loopId?: string) =>
    fetchJSON<{ targets: MaintenanceTarget[] }>(
      `/maintenance/targets${
        loopId ? `?loop_id=${encodeURIComponent(loopId)}` : ""
      }`,
    ),

  getTarget: (targetId: string) =>
    fetchJSON<{ target: MaintenanceTarget }>(
      `/maintenance/targets/${encodeURIComponent(targetId)}`,
    ),

  createTarget: (
    target: Omit<
      MaintenanceTarget,
      | "state"
      | "feedback_cursor"
      | "feedback_count"
      | "repair_count"
      | "created_at"
      | "updated_at"
    >,
  ) =>
    fetchJSON<{ target: MaintenanceTarget }>("/maintenance/targets", {
      method: "POST",
      body: JSON.stringify(target),
    }),

  sendEvent: (body: {
    source: string;
    event_id: string;
    target_id?: string;
    external_ref?: { source: string; subject_id: string };
    priority?: "urgent" | "normal" | "background";
    payload?: Record<string, unknown>;
  }) =>
    fetchJSON<{
      accepted: boolean;
      event_id: string;
      target_id: string;
      state: string;
    }>("/maintenance/events", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
