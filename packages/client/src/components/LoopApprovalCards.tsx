import type { RunDecisionAction } from "@yep-anywhere/shared";
import { useCallback, useEffect, useState } from "react";
import { loopsApi } from "../api/loops";
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

interface PendingApproval {
  event: RunDecisionRequiredEvent;
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

function decisionButtonClass(option: LoopDecisionOption): string {
  switch (option) {
    case "approve":
      return "bg-[var(--primary)] text-[var(--on-primary)]";
    case "reject":
      return "bg-[var(--error-color)]/15 text-[var(--error-color)] border border-[var(--error-color)]/40";
    case "request_changes":
      return "bg-[var(--warning-color)]/15 text-[var(--warning-color)] border border-[var(--warning-color)]/40";
    case "pause":
      return "bg-[var(--bg-hover)] text-[var(--text-primary)] border border-[var(--border-color)]";
  }
}

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
        {event.reason && (
          <div className="break-words text-[var(--text-secondary)]">
            {event.reason}
          </div>
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
        <div className="mt-3 grid grid-cols-2 gap-2">
          {event.options.map((option) => (
            <button
              key={option}
              type="button"
              className={`rounded-md px-3 py-2.5 text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-50 ${decisionButtonClass(option)}`}
              disabled={approval.submitting}
              onClick={() => handleDecision(option)}
            >
              {t(DECISION_LABEL_KEYS[option])}
            </button>
          ))}
        </div>
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
