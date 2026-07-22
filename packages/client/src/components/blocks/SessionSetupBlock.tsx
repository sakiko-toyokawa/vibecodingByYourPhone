import { memo } from "react";
import type { ContentBlock } from "../../types";
import { UserPromptBlock } from "./UserPromptBlock";

interface Props {
  title: string;
  prompts: Array<string | ContentBlock[]>;
}

function getPromptKey(prompt: string | ContentBlock[]): string {
  if (typeof prompt === "string") {
    return `s:${prompt.length}:${prompt.slice(0, 80)}`;
  }

  const text = prompt
    .filter(
      (block): block is ContentBlock & { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");

  return `a:${prompt.length}:${text.length}:${text.slice(0, 80)}`;
}

export const SessionSetupBlock = memo(function SessionSetupBlock({
  title,
  prompts,
}: Props) {
  const promptKeyCounts = new Map<string, number>();

  return (
    <details className="mb-3">
      <summary className="inline-flex cursor-pointer items-center gap-1 rounded-sm border border-[var(--border-color)] bg-[var(--bg-code)] px-2 py-1 text-xs">
        <span>▸</span>
        <span>{title}</span>
      </summary>
      <div className="mt-2">
        {prompts.map((prompt) => {
          const baseKey = getPromptKey(prompt);
          const count = (promptKeyCounts.get(baseKey) ?? 0) + 1;
          promptKeyCounts.set(baseKey, count);
          return (
            <div key={`${baseKey}:${count}`}>
              <UserPromptBlock content={prompt} />
            </div>
          );
        })}
      </div>
    </details>
  );
});
