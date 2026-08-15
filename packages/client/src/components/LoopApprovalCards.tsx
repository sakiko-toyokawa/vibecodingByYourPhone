import type {
  HumanReason,
  PendingToolCall,
  RunDecisionAction,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useState } from "react";
import { type HumanSlaItem, loopsApi } from "../api/loops";
import { useI18n } from "../i18n";
import {
  type LoopDecisionOption,
  type RunDecisionRequiredEvent,
  activityBus,
} from "../lib/activityBus";
import {
  buildDecisionRequest,
  isAwaitingHuman,
  loopChangedState,
} from "../lib/loopDecisions";
import { humanizeReason } from "../lib/loopHumanText";
import {
  DecisionButtons,
  DiffSummaryBlock,
  recommendedDecisionOption,
} from "./LoopApprovalCards.shared";

interface InitialPendingApproval {
  type: "run-decision-required";
  loop_id: string;
  run_id: string;
  request_id: string;
  action: "manual_review";
  risk: "unrated";
  reason: string;
  evidence_refs: string[];
  human_reasons: HumanReason[];
  tool_call?: PendingToolCall;
  diff_summary?: string;
  options: LoopDecisionOption[];
  recommended?: string;
  timestamp: string;
}

type ApprovalEvent = RunDecisionRequiredEvent | InitialPendingApproval;

function slaToApprovalEvent(item: HumanSlaItem): InitialPendingApproval {
  return {
    type: "run-decision-required",
    loop_id: item.loop_id,
    run_id: item.run_id,
    request_id: item.request_id ?? `sla-${item.run_id}`,
    action: "manual_review",
    risk: "unrated",
    reason: item.reason,
    evidence_refs: [],
    human_reasons: item.human_reasons ?? [],
    options: ["approve", "reject", "request_changes", "pause"],
    timestamp: item.entered_at,
  };
}

interface PendingApproval {
  event: ApprovalEvent;
  /** request_changes selected: show the feedback form */
  feedbackOpen: boolean;
  feedback: string;
  submitting: boolean;
  error: string | null;
}

const DECISION_LABEL_KEYS = {
  approve: "loopApprovalApprove",
  reject: "loopApprovalReject",
  request_changes: "loopApprovalRequestChanges",
  pause: "loopApprovalPause",
} as const;

/** 硬闸门动作 / next_action 枚举值 → 可读标签 (显示原始枚举值被当成
 *  "显示代码而不是请求原因"的误解来源; 未知值回退原文)。 */
const ACTION_LABEL_KEYS: Record<string, string> = {
  merge: "loopActionMerge",
  deploy: "loopActionDeploy",
  delete: "loopActionDelete",
  publish: "loopActionPublish",
  bill: "loopActionBill",
  notify: "loopActionNotify",
  close: "loopActionClose",
  complete: "loopActionComplete",
  retry: "loopActionRetry",
  needs_human: "loopActionNeedsHuman",
  escalate: "loopActionEscalate",
  stop: "loopActionStop",
  manual_review: "loopActionManualReview",
};

/** 风险档枚举值 → 可读标签。 */
const RISK_LABEL_KEYS: Record<string, string> = {
  low: "loopRiskLow",
  medium: "loopRiskMedium",
  high: "loopRiskHigh",
  critical: "loopRiskCritical",
  unrated: "loopRiskUnrated",
};

type MessageKey = Parameters<ReturnType<typeof useI18n>["t"]>[0];

function ApprovalCard({
  approval,
  onChange,
  onDismiss,
}: {
  approval: PendingApproval;
  onChange: (patch: Partial<PendingApproval>) => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const { event } = approval;

  const submit = useCallback(
    async (decision: RunDecisionAction, feedback?: string) => {
      const built = buildDecisionRequest(decision, feedback);
      if (!built.ok) {
        onChange({ error: t("loopApprovalFeedbackRequired") });
        return;
      }
      onChange({ submitting: true, error: null });
      try {
        await loopsApi.submitDecision(
          event.run_id,
          built.request.decision,
          built.request.feedback,
        );
        onDismiss();
      } catch (err) {
        const status = (err as { status?: number }).status;
        // 409 invalid_state: someone else already handled it — hide the card
        if (status === 409) {
          onDismiss();
          return;
        }
        onChange({
          submitting: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [event.run_id, onChange, onDismiss, t],
  );

  const handleDecision = useCallback(
    (option: LoopDecisionOption) => {
      if (option === "request_changes") {
        onChange({ feedbackOpen: true, error: null });
        return;
      }
      void submit(option);
    },
    [onChange, submit],
  );

  return (
    <div className="border border-[var(--warning-color)]/50 rounded-[var(--radius-md)] bg-[var(--bg-surface)] p-4 shadow-[0_18px_60px_rgba(20,20,19,0.25)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[var(--text-primary)]">
            {t("loopApprovalTitle")}
          </div>
          <div className="mt-1 font-mono text-xs text-[var(--text-muted)]">
            {event.loop_id} · {event.run_id}
          </div>
        </div>
        <span className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--warning-color)]/15 px-2 py-0.5 text-xs font-medium text-[var(--warning-color)]">
          {RISK_LABEL_KEYS[event.risk]
            ? t(RISK_LABEL_KEYS[event.risk] as MessageKey)
            : event.risk}
        </span>
      </div>

      <div className="mt-3 flex flex-col gap-1 text-sm">
        <div className="text-[var(--text-primary)]">
          <span className="text-[var(--text-muted)]">
            {t("loopsJudgmentNextAction")}:{" "}
          </span>
          {ACTION_LABEL_KEYS[event.action]
            ? t(ACTION_LABEL_KEYS[event.action] as MessageKey)
            : event.action}
        </div>
        {event.human_reasons && event.human_reasons.length > 0 ? (
          <div className="flex flex-col gap-1">
            {event.human_reasons.map((reason) => (
              <div key={reason.code} className="break-words">
                {reason.message}
                {reason.evidence_refs && reason.evidence_refs.length > 0 && (
                  <div className="mt-1 flex flex-col gap-1">
                    {reason.evidence_refs.map((ref) => (
                      <span
                        key={ref}
                        className="break-all font-mono text-xs text-[var(--text-dimmed)]"
                      >
                        {ref}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : event.reason ? (
          <div className="break-words text-[var(--text-secondary)]">
            {humanizeReason(event.reason)}
          </div>
        ) : null}
        {event.tool_call && (
          <div className="mt-2 rounded-[var(--radius-sm)] border border-[var(--warning-color)]/25 bg-[var(--bg-secondary)] p-2">
            <div className="text-xs font-semibold text-[var(--text-secondary)]">
              {t("loopApprovalToolCall")}
            </div>
            <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-xs text-[var(--text-primary)]">
              {event.tool_call.summary ??
                `${event.tool_call.tool} ${JSON.stringify(event.tool_call.input)}`}
            </pre>
          </div>
        )}
        {event.diff_summary && (
          <DiffSummaryBlock
            label={t("loopApprovalDiffSummary")}
            summary={event.diff_summary}
          />
        )}
      </div>

      {approval.error && (
        <p className="mt-3 rounded-[var(--radius-sm)] border border-[var(--error-color)]/40 bg-[var(--error-color)]/10 p-2 text-xs text-[var(--error-color)]">
          {approval.error}
        </p>
      )}

      {approval.feedbackOpen ? (
        <div className="mt-3 flex flex-col gap-2">
          <textarea
            className="min-h-[72px] w-full resize-y rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-secondary)] p-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-dimmed)]"
            placeholder={t("loopApprovalFeedbackPlaceholder")}
            value={approval.feedback}
            onChange={(e) => onChange({ feedback: e.target.value })}
            disabled={approval.submitting}
          />
          <div className="flex gap-2">
            <button
              type="button"
              className="flex-1 rounded-md bg-[var(--primary)] px-4 py-2.5 text-sm font-medium text-[var(--on-primary)] transition-opacity hover:opacity-90 disabled:opacity-50"
              disabled={approval.submitting}
              onClick={() => void submit("request_changes", approval.feedback)}
            >
              {t("loopApprovalSubmit")}
            </button>
            <button
              type="button"
              className="rounded-md border border-[var(--border-color)] bg-[var(--bg-hover)] px-4 py-2.5 text-sm text-[var(--text-primary)] disabled:opacity-50"
              disabled={approval.submitting}
              onClick={() => onChange({ feedbackOpen: false, error: null })}
            >
              {t("loopApprovalCancel")}
            </button>
          </div>
        </div>
      ) : (
        <DecisionButtons
          options={event.options}
          labels={{
            approve: t(DECISION_LABEL_KEYS.approve),
            reject: t(DECISION_LABEL_KEYS.reject),
            request_changes: t(DECISION_LABEL_KEYS.request_changes),
            pause: t(DECISION_LABEL_KEYS.pause),
          }}
          recommended={recommendedDecisionOption(event.recommended)}
          recommendedBadge={t("loopApprovalRecommended")}
          disabled={approval.submitting}
          onSelect={handleDecision}
        />
      )}
    </div>
  );
}

/**
 * Global needs_human approval cards. Subscribes to the activity channel:
 * - run-decision-required → show a prominent card with the decision options
 * - loop-state-changed (state left needs_human) → auto-hide the card
 *
 * Rendered once in NavigationLayout so it works on every page, including
 * outside the Loops section. Fixed above the bottom safe area so it stays
 * tappable on mobile.
 */
export function LoopApprovalCards() {
  const [approvals, setApprovals] = useState<Record<string, PendingApproval>>(
    {},
  );

  useEffect(() => {
    let cancelled = false;
    loopsApi
      .listPendingHuman()
      .then(({ items }) => {
        if (cancelled) return;
        setApprovals((prev) => {
          const next = { ...prev };
          for (const item of items) {
            if (!next[item.run_id]) {
              next[item.run_id] = {
                event: slaToApprovalEvent(item),
                feedbackOpen: false,
                feedback: "",
                submitting: false,
                error: null,
              };
            }
          }
          return next;
        });
      })
      .catch(() => {
        // Initial hydration is best-effort; live WS events still populate.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unsubDecision = activityBus.on("run-decision-required", (event) => {
      setApprovals((prev) => ({
        ...prev,
        [event.run_id]: {
          event,
          feedbackOpen: false,
          feedback: "",
          submitting: false,
          error: null,
        },
      }));
    });
    const unsubState = activityBus.on("loop-state-changed", (event) => {
      if (isAwaitingHuman(loopChangedState(event))) return;
      setApprovals((prev) => {
        if (!prev[event.run_id]) return prev;
        const next = { ...prev };
        delete next[event.run_id];
        return next;
      });
    });
    return () => {
      unsubDecision();
      unsubState();
    };
  }, []);

  const entries = Object.entries(approvals);
  if (entries.length === 0) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[120] flex flex-col gap-2 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] sm:left-auto sm:right-4 sm:bottom-4 sm:w-[380px] sm:p-0">
      {entries.map(([runId, approval]) => (
        <ApprovalCard
          key={runId}
          approval={approval}
          onChange={(patch) =>
            setApprovals((prev) =>
              prev[runId]
                ? { ...prev, [runId]: { ...prev[runId], ...patch } }
                : prev,
            )
          }
          onDismiss={() =>
            setApprovals((prev) => {
              const next = { ...prev };
              delete next[runId];
              return next;
            })
          }
        />
      ))}
    </div>
  );
}
