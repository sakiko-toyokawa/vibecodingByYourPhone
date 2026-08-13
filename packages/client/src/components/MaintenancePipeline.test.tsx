import { renderToStaticMarkup } from "react-dom/server";
import { MaintenancePipeline } from "./MaintenancePipeline.js";

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

function testWaitingPipeline(): void {
  const html = renderToStaticMarkup(<MaintenancePipeline state="waiting" />);
  assertIncludes(html, 'data-state="waiting"');
  assertIncludes(html, "Waiting");
  assertIncludes(html, 'data-active="true"');
}

function testFixingPipelineShowsPath(): void {
  const html = renderToStaticMarkup(<MaintenancePipeline state="fixing" />);
  assertIncludes(html, 'data-state="fixing"');
  assertIncludes(html, "Waiting");
  assertIncludes(html, "Waking");
  assertIncludes(html, "Fixing");
}

function testDonePipelineShowsTerminal(): void {
  const html = renderToStaticMarkup(<MaintenancePipeline state="done" />);
  assertIncludes(html, 'data-stage="done"');
  assertIncludes(html, "Done");
  assertIncludes(html, "Fixing");
}

function testGithubPrPipelineShowsApprovalStages(): void {
  const html = renderToStaticMarkup(
    <MaintenancePipeline state="awaiting_review" targetType="github_pr" />,
  );
  assertIncludes(html, 'data-state="awaiting_review"');
  assertIncludes(html, "Pending approval");
  assertIncludes(html, "Awaiting review");
}

testWaitingPipeline();
testFixingPipelineShowsPath();
testDonePipelineShowsTerminal();
testGithubPrPipelineShowsApprovalStages();
