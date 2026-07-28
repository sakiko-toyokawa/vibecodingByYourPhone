import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceStrategyBadge } from "./LoopWorkspaceHint.js";

function assertIncludes(
  actual: string,
  expectedSubstring: string,
  message?: string,
): void {
  if (!actual.includes(expectedSubstring)) {
    throw new Error(
      message ?? `Expected "${actual}" to include "${expectedSubstring}"`,
    );
  }
}

function assertExcludes(
  actual: string,
  unexpectedSubstring: string,
  message?: string,
): void {
  if (actual.includes(unexpectedSubstring)) {
    throw new Error(
      message ?? `Expected "${actual}" to NOT include "${unexpectedSubstring}"`,
    );
  }
}

const HINT =
  "Verification runs directly in this workspace — avoid heavy edits while a run is active";

function testDirectShowsHint(): void {
  const html = renderToStaticMarkup(
    <WorkspaceStrategyBadge strategy="direct" directHint={HINT} />,
  );
  assertIncludes(html, "direct");
  assertIncludes(html, HINT, "direct 策略应显示验证失真提示");
}

function testWorktreeHidesHint(): void {
  const html = renderToStaticMarkup(
    <WorkspaceStrategyBadge strategy="worktree" directHint={HINT} />,
  );
  assertIncludes(html, "worktree");
  assertExcludes(html, HINT, "worktree 策略已隔离, 不应显示提示");
}

testDirectShowsHint();
testWorktreeHidesHint();
console.log("LoopWorkspaceHint tests passed");
