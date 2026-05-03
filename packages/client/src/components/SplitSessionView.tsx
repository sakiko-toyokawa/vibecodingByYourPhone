import { StreamingMarkdownProvider } from "../contexts/StreamingMarkdownContext";
import { SessionPageContent } from "../pages/SessionPage";

interface SplitSessionViewProps {
  left: {
    projectId: string;
    sessionId: string;
  };
  right: {
    projectId: string;
    sessionId: string;
  };
}

export function SplitSessionView({ left, right }: SplitSessionViewProps) {
  return (
    <div className="flex h-[100dvh] w-full flex-row">
      <div className="flex w-1/2 flex-col overflow-hidden border-r border-[var(--border-subtle)]">
        <StreamingMarkdownProvider key={left.sessionId}>
          <SessionPageContent
            projectId={left.projectId}
            sessionId={left.sessionId}
          />
        </StreamingMarkdownProvider>
      </div>
      <div className="flex w-1/2 flex-col overflow-hidden">
        <StreamingMarkdownProvider key={right.sessionId}>
          <SessionPageContent
            projectId={right.projectId}
            sessionId={right.sessionId}
            isSecondaryPane
          />
        </StreamingMarkdownProvider>
      </div>
    </div>
  );
}
