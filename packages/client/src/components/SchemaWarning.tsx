import { useCallback, useState } from "react";
import type { ZodError } from "zod";
import { useI18n } from "../i18n";
import { Modal } from "./ui/Modal";

interface SchemaWarningProps {
  toolName: string;
  errors: ZodError;
}

/**
 * Format Zod errors into structured data for display.
 * Groups missing/invalid fields for clear presentation.
 */
function formatErrors(errors: ZodError): {
  missing: string[];
  invalid: Array<{ path: string; message: string }>;
} {
  const issues = errors.issues;
  const missing: string[] = [];
  const invalid: Array<{ path: string; message: string }> = [];

  for (const issue of issues) {
    const path = issue.path.join(".") || "(root)";
    if (
      issue.code === "invalid_type" &&
      issue.message.toLowerCase().includes("required")
    ) {
      missing.push(path);
    } else {
      invalid.push({ path, message: issue.message });
    }
  }

  return { missing, invalid };
}

const GITHUB_ISSUES_URL = "https://github.com/kzahel/yepanywhere/issues/new";

/**
 * Build a GitHub issue URL with pre-filled title and body for schema validation errors.
 */
function buildIssueUrl(
  toolName: string,
  missing: string[],
  invalid: Array<{ path: string; message: string }>,
): string {
  const title = `Schema validation error: ${toolName}`;

  const bodyParts: string[] = [`## Tool\n\n\`${toolName}\``];

  if (missing.length > 0) {
    bodyParts.push(
      `## Missing fields\n\n${missing.map((f) => `- \`${f}\``).join("\n")}`,
    );
  }

  if (invalid.length > 0) {
    bodyParts.push(
      `## Invalid fields\n\n${invalid.map(({ path, message }) => `- \`${path}\`: ${message}`).join("\n")}`,
    );
  }

  bodyParts.push(
    "## Context\n\n<!-- Please add any additional context here, such as what you were doing when this occurred -->",
  );

  const body = bodyParts.join("\n\n");

  const params = new URLSearchParams({
    title,
    body,
    labels: "bug,schema",
  });

  return `${GITHUB_ISSUES_URL}?${params.toString()}`;
}

/**
 * Small warning badge that appears on tool results that fail schema validation.
 * Clicking opens a modal with detailed error information.
 * Uses a span with role="button" to avoid nested button issues when rendered
 * inside clickable containers.
 */
export function SchemaWarning({ toolName, errors }: SchemaWarningProps) {
  const { t } = useI18n();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { missing, invalid } = formatErrors(errors);
  const issueUrl = buildIssueUrl(toolName, missing, invalid);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsModalOpen(true);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      setIsModalOpen(true);
    }
  }, []);

  const handleClose = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  return (
    <>
      <span
        role="button"
        tabIndex={0}
        className="relative ml-2 inline-flex cursor-pointer items-center justify-center border-none bg-none p-0"
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        title={t("schemaWarningTooltip" as never, { tool: toolName })}
      >
        <span
          className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-[var(--warning-color)] text-[10px] font-bold text-[var(--bg-surface)] select-none"
          aria-hidden="true"
        >
          !
        </span>
      </span>
      {isModalOpen && (
        <Modal
          title={
            <span className="text-[var(--warning-color)]">
              Schema validation failed: {toolName}
              {t("schemaWarningTitle" as never, { tool: toolName })}
            </span>
          }
          onClose={handleClose}
        >
          <div className="flex flex-col gap-4">
            {missing.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="[font-size:var(--font-size-sm)] font-semibold text-[var(--text-secondary)]">
                  {t("schemaWarningMissing" as never)}
                </div>
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {missing.map((field) => (
                    <li
                      key={field}
                      className="flex flex-col gap-1 rounded-[var(--radius-sm)] bg-[var(--bg-code)] p-[var(--space-2)]"
                    >
                      <code className="[font-family:var(--font-mono)] [font-size:var(--font-size-sm)] text-[var(--warning-color)]">
                        {field}
                      </code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {invalid.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="[font-size:var(--font-size-sm)] font-semibold text-[var(--text-secondary)]">
                  {t("schemaWarningInvalid" as never)}
                </div>
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {invalid.map(({ path, message }) => (
                    <li
                      key={path}
                      className="flex flex-col gap-1 rounded-[var(--radius-sm)] bg-[var(--bg-code)] p-[var(--space-2)]"
                    >
                      <code className="[font-family:var(--font-mono)] [font-size:var(--font-size-sm)] text-[var(--warning-color)]">
                        {path}
                      </code>
                      <span className="[font-size:var(--font-size-xs)] text-[var(--text-muted)]">
                        {message}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="border-t border-[var(--border-subtle)] pt-[var(--space-2)]">
              <a
                href={issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="[font-size:var(--font-size-sm)] text-[var(--link-color)] no-underline hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {t("schemaWarningReport" as never)}
              </a>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
