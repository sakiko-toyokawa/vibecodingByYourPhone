import type { HumanReason } from "@yep-anywhere/shared";

export interface ReportSummaryRow {
  label: string;
  value: string;
}

export interface ReportSummary {
  title: string;
  rows: ReportSummaryRow[];
  humanReasons: HumanReason[];
  risks: string[];
  raw: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function humanReasonArray(value: unknown): HumanReason[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is HumanReason =>
          item !== null &&
          typeof item === "object" &&
          typeof (item as HumanReason).code === "string" &&
          typeof (item as HumanReason).message === "string",
      )
    : [];
}

/** Deterministic user-facing labels for run states and turn decisions. */
export function humanizeDecision(value: string): string {
  switch (value) {
    case "active":
      return "Running";
    case "needs_human":
      return "Human review required";
    case "complete":
      return "Complete";
    case "failed":
      return "Failed";
    case "budget_limited":
      return "Budget exhausted";
    case "paused":
      return "Paused";
    case "retry":
      return "Retry";
    case "discarded":
      return "Discarded";
    default:
      return value;
  }
}

export function humanizeVerifierStatus(value: string): string {
  switch (value) {
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "inconclusive":
      return "Inconclusive";
    case "unverified":
      return "Unverified";
    default:
      return value;
  }
}

export function humanizeNextAction(value: string): string {
  return humanizeDecision(value);
}

export function humanizeRecommendation(value: string): string {
  switch (value) {
    case "stop":
      return "Stop";
    case "retry":
      return "Retry";
    case "escalate":
      return "Escalate to human";
    default:
      return value;
  }
}

export function humanizeRelationState(value: string): string {
  switch (value) {
    case "pr_pending_approval":
      return "Pending approval";
    case "awaiting_review":
      return "Awaiting review";
    case "awaiting_feedback":
      return "Awaiting feedback";
    case "fixing":
      return "Fixing";
    case "merged":
      return "Merged";
    case "closed":
      return "Closed";
    case "needs_human":
      return "Human review required";
    default:
      return value;
  }
}

export function humanizeMaintenanceState(value: string): string {
  switch (value) {
    case "pending_approval":
      return "Pending approval";
    case "awaiting_review":
      return "Awaiting review";
    case "awaiting_feedback":
      return "Awaiting feedback";
    case "waiting":
      return "Waiting";
    case "waking":
      return "Waking";
    case "fixing":
      return "Fixing";
    case "needs_human":
      return "Human review required";
    case "done":
      return "Done";
    default:
      return value;
  }
}

/** Convert internal decision reasons into deterministic human text. */
export function humanizeReason(reason: string): string {
  const normalized = reason.trim().toLowerCase();
  if (
    normalized.startsWith("judgment overall == inconclusive") ||
    normalized.includes("verifier json recovery retry failed") ||
    normalized.includes("无法解析为合法裁决 json")
  ) {
    return "Verifier could not reach a clear verdict; the run was escalated for human review.";
  }
  if (normalized.startsWith("budget exhausted")) {
    return "Budget exhausted before the next turn; increase budget to continue.";
  }
  if (normalized.startsWith("a verifier requires human review")) {
    return "A verifier passed but requested human review; the run was escalated for a human decision.";
  }
  if (normalized.includes("policy gate")) {
    return "Policy hard gate blocked an action; human review is required.";
  }
  if (normalized.includes("execution failed")) {
    return "Execution failed; the run stopped.";
  }
  if (
    normalized.includes("did not produce the required final report") ||
    normalized.includes("missing final report")
  ) {
    return "Executor did not produce a final report; the turn was retried.";
  }
  if (
    normalized.includes("duplicate") ||
    normalized.includes("conflicting work")
  ) {
    return "Duplicate or conflicting work was detected; human review is required.";
  }
  if (normalized.includes("restart recovery requested")) {
    return "The run requested confirmation after a restart; human review is required.";
  }
  return reason;
}

export function formatHumanReasons(reasons: HumanReason[]): string {
  return reasons.map((reason) => reason.message).join("\n");
}

function parseObject(content: string): unknown | null {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

function judgmentReportSummary(content: string): ReportSummary | null {
  const value = parseObject(content);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const report = value as Record<string, unknown>;
  return {
    title: "Judgment Summary",
    humanReasons: humanReasonArray(report.human_reasons),
    rows: [
      {
        label: "Overall",
        value: humanizeVerifierStatus(text(report.overall)),
      },
      {
        label: "Next action",
        value: humanizeNextAction(text(report.next_action)),
      },
      {
        label: "Human review",
        value: report.requires_human === true ? "Required" : "Not required",
      },
    ],
    risks: stringArray(report.unresolved_risks),
    raw: content,
  };
}

function verifierReportSummary(content: string): ReportSummary | null {
  const parsed = parseObject(content);
  const reports = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  const rows: ReportSummaryRow[] = [];
  const risks: string[] = [];
  for (const item of reports) {
    if (!item || typeof item !== "object") continue;
    const report = item as Record<string, unknown>;
    rows.push(
      {
        label: "Phase",
        value: text(report.verifier_phase),
      },
      {
        label: "Status",
        value: humanizeVerifierStatus(text(report.status)),
      },
      {
        label: "Recommendation",
        value: humanizeRecommendation(text(report.recommendation)),
      },
      {
        label: "Confidence",
        value: text(report.confidence),
      },
    );
    risks.push(...stringArray(report.unresolved_risks));
    if (Array.isArray(report.issues)) {
      for (const issue of report.issues) {
        if (issue && typeof issue === "object") {
          const issueRecord = issue as Record<string, unknown>;
          risks.push(
            `${text(issueRecord.severity)}: ${text(issueRecord.message)}`,
          );
        }
      }
    }
  }
  if (rows.length === 0) return null;
  return {
    title: "Verifier Summary",
    humanReasons: reports.flatMap((item) =>
      humanReasonArray(
        item && typeof item === "object"
          ? (item as Record<string, unknown>).human_reasons
          : undefined,
      ),
    ),
    rows,
    risks,
    raw: content,
  };
}

function collectorReportSummary(content: string): ReportSummary | null {
  const value = parseObject(content);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const report = value as Record<string, unknown>;
  return {
    title: "Collector Summary",
    humanReasons: humanReasonArray(report.human_reasons),
    rows: [
      { label: "Status", value: humanizeVerifierStatus(text(report.status)) },
      {
        label: "Recommendation",
        value: humanizeRecommendation(text(report.recommendation)),
      },
      { label: "Summary", value: text(report.summary) },
    ],
    risks: stringArray(report.unresolved_risks),
    raw: content,
  };
}

/** Build a deterministic report summary for known loop report artifacts. */
export function buildReportSummary(
  name: string,
  content: string,
): ReportSummary | null {
  if (/judgment-report(?:-turn\d+)?\.json$/.test(name)) {
    return (
      judgmentReportSummary(content) ?? {
        title: "Judgment Summary",
        humanReasons: [],
        rows: [],
        risks: ["Report could not be parsed as a judgment JSON object."],
        raw: content,
      }
    );
  }
  if (/verifier-reports(?:-turn\d+)?\.json$/.test(name)) {
    return (
      verifierReportSummary(content) ?? {
        title: "Verifier Summary",
        humanReasons: [],
        rows: [],
        risks: ["Report could not be parsed as verifier JSON."],
        raw: content,
      }
    );
  }
  if (/collector-report(?:-turn\d+)?\.json$/.test(name)) {
    return (
      collectorReportSummary(content) ?? {
        title: "Collector Summary",
        humanReasons: [],
        rows: [],
        risks: ["Report could not be parsed as collector JSON."],
        raw: content,
      }
    );
  }
  return null;
}
