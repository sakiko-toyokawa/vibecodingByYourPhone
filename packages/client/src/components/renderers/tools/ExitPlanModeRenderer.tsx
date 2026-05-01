import type {
  ExitPlanModeInput,
  ExitPlanModeResult,
  ToolRenderer,
} from "./types";

interface ExitPlanModeInputWithHtml extends ExitPlanModeInput {
  _renderedHtml?: string;
}

interface ExitPlanModeResultWithHtml extends ExitPlanModeResult {
  _renderedHtml?: string;
}

const planContentClasses =
  "text-[13px] leading-6 text-[var(--text-primary)] [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1 [&_h1]:mt-4 [&_h1]:[font-family:var(--font-display)] [&_h1]:text-[1.35rem] [&_h2]:mt-4 [&_h2]:[font-family:var(--font-display)] [&_h2]:text-[1.15rem] [&_h3]:mt-3 [&_h3]:text-[1rem] [&_h3]:font-semibold [&_code]:rounded-[var(--radius-sm)] [&_code]:bg-[var(--bg-secondary)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:[font-family:var(--font-mono)] [&_code]:text-[0.9em] [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-[16px] [&_pre]:border [&_pre]:border-black/10 [&_pre]:bg-[#171717] [&_pre]:p-4 [&_pre]:[font-family:var(--font-mono)] [&_pre]:text-[#e8e3d8] [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_blockquote]:my-3 [&_blockquote]:border-l-[3px] [&_blockquote]:border-[var(--border-color)] [&_blockquote]:pl-4 [&_blockquote]:text-[var(--text-muted)] [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-[var(--border-color)] [&_th]:bg-[var(--bg-secondary)] [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_td]:border [&_td]:border-[var(--border-color)] [&_td]:px-3 [&_td]:py-2";

function PlanContent({
  plan,
  renderedHtml,
}: { plan?: string; renderedHtml?: string }) {
  if (renderedHtml) {
    return (
      <div
        className={planContentClasses}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered markdown is safe
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
      />
    );
  }

  return (
    <pre className={`${planContentClasses} whitespace-pre-wrap font-sans`}>
      {plan}
    </pre>
  );
}

export const exitPlanModeRenderer: ToolRenderer<
  ExitPlanModeInput,
  ExitPlanModeResult
> = {
  tool: "ExitPlanMode",

  renderToolUse() {
    return null;
  },

  renderToolResult() {
    return null;
  },

  renderInline(input, result, isError, status) {
    const planInput = input as ExitPlanModeInputWithHtml;
    const planResult = result as ExitPlanModeResultWithHtml;

    const plan: string | undefined = planInput?.plan || planResult?.plan;
    const renderedHtml: string | undefined =
      planInput?._renderedHtml || planResult?._renderedHtml;

    if (isError) {
      let errorMessage = "Exit plan mode failed";
      if (typeof result === "string") {
        errorMessage = result;
      } else if (typeof result === "object" && result !== null) {
        const errorResult = result as { message?: unknown };
        if (errorResult.message) {
          errorMessage = String(errorResult.message);
        }
      }
      return (
        <div className="rounded-lg border border-[var(--error-color)]/20 bg-[var(--error-color)]/5 px-4 py-3 text-sm text-[var(--error-color)]">
          {errorMessage}
        </div>
      );
    }

    if (!plan && !renderedHtml) {
      if (status === "pending") {
        return (
          <div className="text-sm italic text-[var(--text-muted)]">
            Planning...
          </div>
        );
      }
      return null;
    }

    return (
      <details
        className="my-2 overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[0_1px_0_rgba(20,20,19,0.03)]"
        open
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--text-muted)]">
          <span>{status === "pending" ? "Planning..." : "Plan"}</span>
          <span
            aria-hidden="true"
            className="text-xs text-[var(--text-dimmed)]"
          >
            ▾
          </span>
        </summary>
        <div className="border-t border-[var(--border-subtle)] px-5 py-4">
          <PlanContent plan={plan} renderedHtml={renderedHtml} />
        </div>
      </details>
    );
  },

  getUseSummary(_input) {
    return "Exit plan mode";
  },

  getResultSummary(_result, isError) {
    if (isError) return "Error";
    return "Plan";
  },
};
