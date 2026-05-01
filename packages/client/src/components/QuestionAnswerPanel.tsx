import { useCallback, useEffect, useRef, useState } from "react";
import { useQuestionOtherDrafts } from "../hooks/useDrafts";
import { useI18n } from "../i18n";
import type { InputRequest } from "../types";
import type { AskUserQuestionInput, Question } from "./renderers/tools/types";

interface Props {
  request: InputRequest;
  sessionId: string;
  onSubmit: (answers: Record<string, string>) => Promise<void>;
  onDeny: () => Promise<void>;
}

/**
 * Panel for answering AskUserQuestion tool calls.
 * Shows one question at a time with tabs to navigate between them.
 */
export function QuestionAnswerPanel({
  request,
  sessionId,
  onSubmit,
  onDeny,
}: Props) {
  const { t } = useI18n();
  const input = request.toolInput as AskUserQuestionInput;
  const questions = input?.questions || [];

  const [currentTab, setCurrentTab] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // Persist "Other" text inputs to localStorage keyed by sessionId
  const [otherTexts, setOtherText, clearOtherTexts] =
    useQuestionOtherDrafts(sessionId);
  const [submitting, setSubmitting] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const otherInputRef = useRef<HTMLInputElement>(null);

  const currentQuestion = questions[currentTab];
  const isLastQuestion = currentTab === questions.length - 1;
  const currentAnswer = currentQuestion
    ? answers[currentQuestion.question]
    : undefined;
  const isOtherSelected = currentAnswer === "__other__";

  // Check if all questions are answered
  const allAnswered = questions.every((q) => {
    const answer = answers[q.question];
    if (!answer) return false;
    if (answer === "__other__") {
      return (otherTexts[q.question] || "").trim().length > 0;
    }
    return true;
  });

  // Focus the "other" input when it's selected and scroll it into view
  useEffect(() => {
    if (isOtherSelected && otherInputRef.current) {
      otherInputRef.current.focus();
      // Scroll input into view after a short delay to allow keyboard to open
      setTimeout(() => {
        otherInputRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }, 100);
    }
  }, [isOtherSelected]);

  const handleSelectOption = useCallback(
    (optionLabel: string) => {
      if (!currentQuestion) return;
      setAnswers((prev) => ({
        ...prev,
        [currentQuestion.question]: optionLabel,
      }));
    },
    [currentQuestion],
  );

  const handleOtherTextChange = useCallback(
    (text: string) => {
      if (!currentQuestion) return;
      setOtherText(currentQuestion.question, text);
    },
    [currentQuestion, setOtherText],
  );

  const advanceToNext = useCallback(() => {
    if (!isLastQuestion) {
      setCurrentTab((prev) => prev + 1);
    }
  }, [isLastQuestion]);

  const handleSubmit = useCallback(async () => {
    if (!allAnswered || submitting) return;

    // Build final answers, replacing __other__ with actual text
    const finalAnswers: Record<string, string> = {};
    for (const q of questions) {
      const answer = answers[q.question];
      if (answer === "__other__") {
        finalAnswers[q.question] = otherTexts[q.question] || "";
      } else if (answer) {
        finalAnswers[q.question] = answer;
      }
    }

    setSubmitting(true);
    try {
      await onSubmit(finalAnswers);
      // Clear "Other" drafts from localStorage on successful submit
      clearOtherTexts();
    } finally {
      setSubmitting(false);
    }
  }, [
    allAnswered,
    submitting,
    questions,
    answers,
    otherTexts,
    onSubmit,
    clearOtherTexts,
  ]);

  const handleDeny = useCallback(async () => {
    setSubmitting(true);
    try {
      await onDeny();
    } finally {
      setSubmitting(false);
    }
  }, [onDeny]);

  // Keyboard handling
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (submitting) return;

      // Escape to deny
      if (e.key === "Escape") {
        e.preventDefault();
        handleDeny();
        return;
      }

      // Enter behavior depends on context
      if (e.key === "Enter" && !e.shiftKey) {
        // If "other" is selected and has text, or a regular option is selected
        const hasCurrentAnswer = currentAnswer && currentAnswer !== "__other__";
        const hasOtherAnswer =
          currentAnswer === "__other__" &&
          (otherTexts[currentQuestion?.question || ""] || "").trim().length > 0;

        if (hasCurrentAnswer || hasOtherAnswer) {
          e.preventDefault();
          if (isLastQuestion && allAnswered) {
            handleSubmit();
          } else {
            advanceToNext();
          }
        }
      }

      // Tab/Shift+Tab to navigate between question tabs (when not in input)
      if (e.key === "Tab" && !isOtherSelected) {
        e.preventDefault();
        if (e.shiftKey) {
          setCurrentTab((prev) => Math.max(0, prev - 1));
        } else {
          setCurrentTab((prev) => Math.min(questions.length - 1, prev + 1));
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    submitting,
    currentAnswer,
    currentQuestion,
    otherTexts,
    isLastQuestion,
    allAnswered,
    isOtherSelected,
    questions.length,
    handleDeny,
    handleSubmit,
    advanceToNext,
  ]);

  if (!questions.length) {
    return (
      <div className="relative">
        <div className="flex flex-col gap-3 p-3 bg-[var(--bg-secondary)] border border-[var(--primary-color)] rounded-[var(--radius-md)] max-h-[50vh] overflow-y-auto">
          <div className="text-[var(--text-muted)] italic">
            {t("questionPanelNoQuestions")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Floating toggle button */}
      <button
        type="button"
        className="absolute -top-3 left-1/2 -translate-x-1/2 z-[1] w-8 h-6 flex items-center justify-center bg-[var(--bg-code)] border border-[var(--border-color)] rounded-[var(--radius-md)] text-[var(--text-muted)] cursor-pointer transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] hover:border-[var(--text-muted)]"
        onClick={() => setCollapsed(!collapsed)}
        aria-label={
          collapsed ? t("questionPanelExpand") : t("questionPanelCollapse")
        }
        aria-expanded={!collapsed}
      >
        <span
          className={`transition-transform duration-200 ${collapsed ? "rotate-180" : ""}`}
        >
          &#x25bc;
        </span>
      </button>

      {!collapsed && (
        <div className="flex flex-col gap-3 p-3 bg-[var(--bg-secondary)] border border-[var(--primary-color)] rounded-[var(--radius-md)] max-h-[50vh] overflow-y-auto max-sm:p-2">
          {/* Tab bar */}
          <div className="flex gap-2 flex-wrap max-sm:gap-1">
            {questions.map((q, idx) => {
              const isActive = idx === currentTab;
              const isAnswered = !!answers[q.question];
              return (
                <button
                  key={q.question}
                  type="button"
                  className={`flex items-center gap-1 px-3 py-2 bg-[var(--bg-code)] border border-[var(--border-input)] rounded-[var(--radius-md)] [font-size:var(--font-size-sm)] text-[var(--text-muted)] cursor-pointer hover:bg-[var(--bg-tertiary)] hover:border-[var(--border-input)] max-sm:px-2 max-sm:py-1 max-sm:[font-size:var(--font-size-xs)] ${isActive ? "bg-[var(--primary-color)] border-[var(--primary-color)] text-black font-medium" : ""} ${isAnswered ? "border-[var(--success-color)]" : ""} ${isAnswered && !isActive ? "text-[var(--success-color)]" : ""}`}
                  onClick={() => setCurrentTab(idx)}
                >
                  {isAnswered && (
                    <span className="text-[var(--success-color)]">
                      &#x2713;
                    </span>
                  )}
                  {q.header}
                </button>
              );
            })}
          </div>

          {/* Current question */}
          {currentQuestion && (
            <div className="flex flex-col gap-3">
              <div className="[font-size:var(--font-size-base)] text-[var(--text-primary)] leading-snug">
                {currentQuestion.question}
              </div>

              <div className="flex flex-col gap-2">
                {currentQuestion.options.map((option) => {
                  const isSelected = currentAnswer === option.label;
                  return (
                    <button
                      key={option.label}
                      type="button"
                      className={`flex items-start gap-3 p-3 bg-[var(--bg-code)] border border-[var(--border-input)] rounded-[var(--radius-md)] text-left cursor-pointer transition-all duration-150 hover:bg-[var(--bg-tertiary)] hover:border-[var(--border-input)] max-sm:p-2 ${isSelected ? "border-[var(--primary-color)] bg-[rgba(96,165,250,0.1)]" : ""}`}
                      onClick={() => handleSelectOption(option.label)}
                    >
                      <span
                        className={`text-[var(--text-dimmed)] font-mono text-base shrink-0 mt-px ${isSelected ? "text-[var(--primary-color)]" : ""}`}
                      >
                        {currentQuestion.multiSelect
                          ? isSelected
                            ? "\u2611"
                            : "\u2610"
                          : isSelected
                            ? "\u25cf"
                            : "\u25cb"}
                      </span>
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium text-[var(--text-primary)]">
                          {option.label}
                        </span>
                        {option.description && (
                          <span className="[font-size:var(--font-size-sm)] text-[var(--text-muted)]">
                            {option.description}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}

                {/* Other option */}
                <button
                  type="button"
                  className={`flex items-start gap-3 p-3 bg-[var(--bg-code)] border border-[var(--border-input)] rounded-[var(--radius-md)] text-left cursor-pointer transition-all duration-150 hover:bg-[var(--bg-tertiary)] hover:border-[var(--border-input)] max-sm:p-2 ${isOtherSelected ? "border-[var(--primary-color)] bg-[rgba(96,165,250,0.1)]" : ""}`}
                  onClick={() => handleSelectOption("__other__")}
                >
                  <span
                    className={`text-[var(--text-dimmed)] font-mono text-base shrink-0 mt-px ${isOtherSelected ? "text-[var(--primary-color)]" : ""}`}
                  >
                    {isOtherSelected ? "\u25cf" : "\u25cb"}
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium text-[var(--text-primary)]">
                      {t("questionPanelOther")}
                    </span>
                  </div>
                </button>

                {/* Other text input */}
                {isOtherSelected && (
                  <div className="ml-[calc(1rem+var(--space-3))] mt-2">
                    <input
                      ref={otherInputRef}
                      type="text"
                      className="w-full px-3 py-2 bg-[var(--bg-surface)] border border-[var(--border-input)] rounded-[var(--radius-md)] text-[var(--text-primary)] [font-size:var(--font-size-base)] outline-none focus:border-[var(--primary-color)] placeholder:text-[var(--text-muted)]"
                      placeholder={t("questionPanelTypeAnswer")}
                      value={otherTexts[currentQuestion.question] || ""}
                      onChange={(e) => handleOtherTextChange(e.target.value)}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2 border-t border-[var(--border-subtle)] max-sm:flex-row">
            <button
              type="button"
              className="flex items-center justify-center gap-2 px-3 py-2 border-none rounded-[var(--radius-md)] [font-size:var(--font-size-sm)] font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed bg-[var(--error-color)] text-white hover:opacity-90"
              onClick={handleDeny}
              disabled={submitting}
            >
              {t("questionPanelCancel")}
              <kbd className="font-mono [font-size:var(--font-size-xs)] px-1 py-0.5 bg-black/20 rounded">
                esc
              </kbd>
            </button>

            {isLastQuestion ? (
              <button
                type="button"
                className="flex items-center justify-center gap-2 px-3 py-2 border-none rounded-[var(--radius-md)] [font-size:var(--font-size-sm)] font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed bg-[var(--success-color)] text-white hover:opacity-90"
                onClick={handleSubmit}
                disabled={!allAnswered || submitting}
              >
                {t("questionPanelSubmit")}
                <kbd className="font-mono [font-size:var(--font-size-xs)] px-1 py-0.5 bg-black/20 rounded">
                  \u21b5
                </kbd>
              </button>
            ) : (
              <button
                type="button"
                className="flex items-center justify-center gap-2 px-3 py-2 border-none rounded-[var(--radius-md)] [font-size:var(--font-size-sm)] font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                onClick={advanceToNext}
                disabled={!currentAnswer || submitting}
              >
                {t("questionPanelNext")}
                <kbd className="font-mono [font-size:var(--font-size-xs)] px-1 py-0.5 bg-black/20 rounded">
                  \u21b5
                </kbd>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
