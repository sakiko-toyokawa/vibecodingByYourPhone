import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import type {
  AskUserQuestionInput,
  AskUserQuestionResult,
  Question,
  ToolRenderer,
} from "./types";

/**
 * Single question display
 */
function QuestionDisplay({
  question,
  selectedAnswer,
}: {
  question: Question;
  selectedAnswer?: string;
}) {
  const isCustomAnswer =
    selectedAnswer &&
    !question.options.some((opt) => opt.label === selectedAnswer);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-block rounded bg-[var(--bg-secondary)] px-2 py-0.5 text-sm font-medium text-[var(--link-color)]">
          {question.header}
        </span>
        <span className="text-[var(--text-secondary,var(--text-muted))]">
          {question.question}
        </span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {question.options.map((option) => {
          const isSelected = selectedAnswer === option.label;
          return (
            <li
              key={option.label}
              className={`flex items-start gap-2 rounded border border-[var(--border-color)] bg-[var(--bg-code)] p-2 hover:bg-[var(--bg-tertiary)] ${isSelected ? "border-[#4a4] bg-[rgba(68,170,68,0.1)]" : ""}`}
            >
              <span
                className={`shrink-0 font-[monospace] ${isSelected ? "text-[var(--success-color)]" : "text-[var(--text-muted)]"}`}
              >
                {question.multiSelect
                  ? isSelected
                    ? "☑"
                    : "☐"
                  : isSelected
                    ? "●"
                    : "○"}
              </span>
              <div className="flex flex-col gap-0.5">
                <span className="font-medium text-[var(--text-secondary,var(--text-muted))]">
                  {option.label}
                </span>
                {option.description && (
                  <span className="text-base text-[var(--text-muted)]">
                    {option.description}
                  </span>
                )}
              </div>
            </li>
          );
        })}
        {isCustomAnswer && (
          <li className="flex items-start gap-2 rounded border border-[#4a4] bg-[rgba(68,170,68,0.1)] p-2 hover:bg-[var(--bg-tertiary)]">
            <span className="shrink-0 font-[monospace] text-[var(--success-color)]">
              ●
            </span>
            <div className="flex flex-col gap-0.5">
              <span className="font-medium text-[var(--text-secondary,var(--text-muted))]">
                Other
              </span>
              <span className="text-base text-[var(--text-muted)]">
                {selectedAnswer}
              </span>
            </div>
          </li>
        )}
      </ul>
    </div>
  );
}

/**
 * AskUserQuestion tool use - shows questions to be asked
 */
function AskUserQuestionToolUse({ input }: { input: AskUserQuestionInput }) {
  return (
    <div className="flex flex-col gap-4">
      {input.questions.map((q, i) => (
        <QuestionDisplay key={`${q.header}-${i}`} question={q} />
      ))}
    </div>
  );
}

/**
 * AskUserQuestion tool result - shows questions with selected answers
 */
function AskUserQuestionToolResult({
  result,
  isError,
}: {
  result: AskUserQuestionResult;
  isError: boolean;
}) {
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("AskUserQuestion", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("AskUserQuestion", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("AskUserQuestion");

  if (isError) {
    const errorResult = result as unknown as { content?: unknown } | undefined;
    return (
      <div className="rounded bg-[var(--bg-error,rgba(207,34,46,0.1))] p-2 text-[var(--error-color)]">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="AskUserQuestion" errors={validationErrors} />
        )}
        {typeof result === "object" && errorResult?.content
          ? String(errorResult.content)
          : "Question failed"}
      </div>
    );
  }

  if (!result || !result.questions) {
    return (
      <div className="text-lg italic text-[var(--text-muted)]">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="AskUserQuestion" errors={validationErrors} />
        )}
        No questions
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {showValidationWarning && validationErrors && (
        <SchemaWarning toolName="AskUserQuestion" errors={validationErrors} />
      )}
      {result.questions.map((q, i) => {
        // Find the answer by matching the question text
        const answer = result.answers?.[q.question];
        return (
          <QuestionDisplay
            key={`${q.header}-${i}`}
            question={q}
            selectedAnswer={answer}
          />
        );
      })}
    </div>
  );
}

export const askUserQuestionRenderer: ToolRenderer<
  AskUserQuestionInput,
  AskUserQuestionResult
> = {
  tool: "AskUserQuestion",

  renderToolUse(input, _context) {
    return <AskUserQuestionToolUse input={input as AskUserQuestionInput} />;
  },

  renderToolResult(result, isError, _context) {
    return (
      <AskUserQuestionToolResult
        result={result as AskUserQuestionResult}
        isError={isError}
      />
    );
  },

  getUseSummary(input) {
    const questions = (input as AskUserQuestionInput).questions;
    return `${questions?.length || 0} question${questions?.length === 1 ? "" : "s"}`;
  },

  getResultSummary(result: AskUserQuestionResult, isError: boolean): string {
    if (isError) return "Error";
    const answered = Object.keys(result?.answers || {}).length;
    const questionCount = result?.questions?.length || 0;
    // If no answers yet but we have questions, show question count instead
    if (answered === 0 && questionCount > 0) {
      return `${questionCount} question${questionCount === 1 ? "" : "s"}`;
    }
    return `${answered} answered`;
  },
};
