import { buildReportSummary } from "../lib/loopHumanText";

interface LoopReportSummaryProps {
  name: string;
  content: string;
}

export function LoopReportSummary({ name, content }: LoopReportSummaryProps) {
  const summary = buildReportSummary(name, content);
  if (!summary) return null;

  return (
    <div className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
      <div className="text-sm font-semibold text-[var(--text-primary)]">
        {summary.title}
      </div>
      {summary.humanReasons.length > 0 && (
        <div className="mt-2">
          <div className="text-xs font-medium text-[var(--text-muted)]">
            Reasons
          </div>
          <ul className="m-0 mt-1 list-disc pl-4 text-sm text-[var(--text-secondary)]">
            {summary.humanReasons.map((reason) => (
              <li key={reason.code} className="break-words">
                {reason.message}
                {reason.evidence_refs && reason.evidence_refs.length > 0 && (
                  <ul className="m-0 mt-1 list-none pl-0">
                    {reason.evidence_refs.map((ref) => (
                      <li
                        key={ref}
                        className="break-all font-mono [font-size:var(--font-size-xs)] text-[var(--text-muted)]"
                      >
                        {ref}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary.rows.length > 0 && (
        <dl className="mt-2 grid grid-cols-[minmax(0,0.35fr)_minmax(0,0.65fr)] gap-x-3 gap-y-1 [font-size:var(--font-size-xs)]">
          {summary.rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-[var(--text-muted)]">{row.label}</dt>
              <dd className="break-words text-[var(--text-primary)]">
                {row.value || "—"}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {summary.risks.length > 0 && (
        <div className="mt-2">
          <div className="text-xs font-medium text-[var(--text-muted)]">
            Risks
          </div>
          <ul className="m-0 mt-1 list-disc pl-4 [font-size:var(--font-size-xs)] text-[var(--text-secondary)]">
            {summary.risks.map((risk) => (
              <li key={risk} className="break-words">
                {risk}
              </li>
            ))}
          </ul>
        </div>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-[var(--text-dimmed)]">
          Show raw report
        </summary>
        <pre className="m-0 mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--bg-primary)] p-2 [font-size:var(--font-size-xs)] text-[var(--text-primary)]">
          {summary.raw}
        </pre>
      </details>
    </div>
  );
}
