import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import type {
  Todo,
  TodoWriteInput,
  TodoWriteResult,
  ToolRenderer,
} from "./types";

/**
 * Get status icon for a todo item
 */
function getStatusIcon(status: Todo["status"]): string {
  switch (status) {
    case "pending":
      return "□";
    case "in_progress":
      return "❋";
    case "completed":
      return "✓";
    default:
      return "□";
  }
}

/**
 * Single todo item
 */
function TodoItem({ todo }: { todo: Todo }) {
  const statusClass = `todo-status-${todo.status}`;
  const isCompleted = todo.status === "completed";

  return (
    <div className={`flex items-start gap-2 py-0.5 ${statusClass}`}>
      <span className="shrink-0 text-base leading-[1.4] text-[var(--text-muted)]">
        {getStatusIcon(todo.status)}
      </span>
      <span
        className={`break-words leading-[1.4] ${isCompleted ? "line-through text-[var(--text-muted)]" : ""}`}
      >
        {todo.content}
      </span>
    </div>
  );
}

/**
 * TodoWrite tool use - shows intended todo changes
 */
function TodoWriteToolUse({ input }: { input: TodoWriteInput }) {
  if (!input?.todos || input.todos.length === 0) {
    return (
      <div className="text-lg italic text-[var(--text-muted)]">
        No todos specified
      </div>
    );
  }

  const inProgress = input.todos.filter((t) => t.status === "in_progress");
  const pending = input.todos.filter((t) => t.status === "pending");
  const completed = input.todos.filter((t) => t.status === "completed");

  return (
    <div className="flex items-center gap-2">
      <span className="text-lg text-[var(--text-muted)]">
        {inProgress.length > 0 && `${inProgress.length} in progress`}
        {inProgress.length > 0 &&
          (pending.length > 0 || completed.length > 0) &&
          ", "}
        {pending.length > 0 && `${pending.length} pending`}
        {pending.length > 0 && completed.length > 0 && ", "}
        {completed.length > 0 && `${completed.length} completed`}
      </span>
    </div>
  );
}

/**
 * TodoWrite tool result - shows the updated todo list
 */
function TodoWriteToolResult({
  result,
  isError,
}: {
  result: TodoWriteResult;
  isError: boolean;
}) {
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("TodoWrite", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("TodoWrite", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("TodoWrite");

  if (isError) {
    const errorResult = result as unknown as { content?: unknown } | undefined;
    return (
      <div className="rounded bg-[var(--bg-error,rgba(207,34,46,0.1))] p-2 text-[var(--error-color)]">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="TodoWrite" errors={validationErrors} />
        )}
        {typeof result === "object" && errorResult?.content
          ? String(errorResult.content)
          : "Failed to update todos"}
      </div>
    );
  }

  if (!result?.newTodos || result.newTodos.length === 0) {
    return (
      <div className="text-lg italic text-[var(--text-muted)]">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="TodoWrite" errors={validationErrors} />
        )}
        No todos
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {showValidationWarning && validationErrors && (
        <SchemaWarning toolName="TodoWrite" errors={validationErrors} />
      )}
      <div className="flex flex-col gap-1">
        {result.newTodos.map((todo, index) => (
          <TodoItem key={`${todo.content}-${index}`} todo={todo} />
        ))}
      </div>
    </div>
  );
}

export const todoWriteRenderer: ToolRenderer<TodoWriteInput, TodoWriteResult> =
  {
    tool: "TodoWrite",
    displayName: "Update Todos",

    renderToolUse(input, _context) {
      return <TodoWriteToolUse input={input as TodoWriteInput} />;
    },

    renderToolResult(result, isError, _context) {
      return (
        <TodoWriteToolResult
          result={result as TodoWriteResult}
          isError={isError}
        />
      );
    },

    getUseSummary(input) {
      const todos = (input as TodoWriteInput).todos;
      return todos ? `${todos.length} items` : "Todos";
    },

    getResultSummary(result, isError) {
      if (isError) return "Error";
      const r = result as TodoWriteResult;
      return r?.newTodos ? `${r.newTodos.length} items` : "Todos";
    },
  };
