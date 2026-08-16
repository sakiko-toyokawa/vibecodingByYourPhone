import type { LoopCard } from "@yep-anywhere/shared";
import { fetchJSON } from "./client";

/**
 * LOOP-PROPOSAL 閘門 API（server: packages/server/src/routes/loop-proposals.ts）。
 * agent 提議創建子 loop，人工批准後才落地。
 */

export type LoopProposalState = "pending_approval" | "approved" | "rejected";

export interface LoopProposal {
  proposal_id: string;
  loop_id: string;
  run_id: string;
  parent_loop_id: string;
  reason: string;
  card: LoopCard;
  state: LoopProposalState;
  state_logs: { event: string; message: string; at: string }[];
  created_loop_id?: string;
  rejection_reason?: string;
  created_at: string;
  updated_at: string;
}

export const loopProposalsApi = {
  listProposals: (state?: LoopProposalState) =>
    fetchJSON<{ proposals: LoopProposal[] }>(
      `/loop-proposals${state ? `?state=${encodeURIComponent(state)}` : ""}`,
    ),

  approveProposal: (proposalId: string) =>
    fetchJSON<{ proposal: LoopProposal; loop_id: string }>(
      `/loop-proposals/${encodeURIComponent(proposalId)}/approve`,
      { method: "POST" },
    ),

  rejectProposal: (proposalId: string, reason?: string) =>
    fetchJSON<{ proposal: LoopProposal }>(
      `/loop-proposals/${encodeURIComponent(proposalId)}/reject`,
      {
        method: "POST",
        body: JSON.stringify(reason ? { reason } : {}),
      },
    ),
};
