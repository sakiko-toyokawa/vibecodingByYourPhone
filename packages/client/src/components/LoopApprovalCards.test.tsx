import { renderToStaticMarkup } from "react-dom/server";
import type { LoopDecisionOption } from "../lib/activityBus.js";
import {
  DecisionButtons,
  DiffSummaryBlock,
  recommendedDecisionOption,
} from "./LoopApprovalCards.shared.js";

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(
      message ?? `Expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

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

const OPTIONS: LoopDecisionOption[] = [
  "approve",
  "reject",
  "request_changes",
  "pause",
];

const LABELS: Record<LoopDecisionOption, string> = {
  approve: "Approve",
  reject: "Reject",
  request_changes: "Request changes",
  pause: "Pause",
};

function renderButtons(recommended: LoopDecisionOption | null): string {
  return renderToStaticMarkup(
    <DecisionButtons
      options={OPTIONS}
      labels={LABELS}
      recommended={recommended}
      recommendedBadge="Recommended"
      disabled={false}
      onSelect={() => {}}
    />,
  );
}

function testRecommendedMapping(): void {
  assertEqual(recommendedDecisionOption("approve"), "approve");
  assertEqual(recommendedDecisionOption("reject"), "reject");
  assertEqual(recommendedDecisionOption("request_changes"), "request_changes");
  assertEqual(recommendedDecisionOption("pause"), "pause");
  // manual_review / 未知值 / 缺省不映射到任何按钮
  assertEqual(recommendedDecisionOption("manual_review"), null);
  assertEqual(recommendedDecisionOption("stop"), null);
  assertEqual(recommendedDecisionOption(undefined), null);
}

function testRecommendedButtonHighlighted(): void {
  const html = renderButtons("approve");
  // 命中推荐的按钮: data-recommended 标记 + 主色描边 + 徽标
  assertIncludes(html, 'data-recommended="true"');
  assertIncludes(html, "ring-2");
  assertIncludes(html, "Recommended");
  // 只有推荐的那个按钮带徽标
  assertEqual(html.split('data-recommended="true"').length - 1, 1);
}

function testNoHighlightWithoutRecommendation(): void {
  const html = renderButtons(recommendedDecisionOption("manual_review"));
  assertEqual(html.includes("data-recommended"), false);
  assertEqual(html.includes("Recommended"), false);
}

function testDiffSummaryRenders(): void {
  const stat = " src/a.ts | 2 +-\n 1 file changed, 1 insertion(+)";
  const html = renderToStaticMarkup(
    <DiffSummaryBlock label="Workspace diff summary" summary={stat} />,
  );
  assertIncludes(html, "Workspace diff summary");
  assertIncludes(html, "src/a.ts | 2 +-");
  assertIncludes(html, "<details");
}

function main(): void {
  const cases: Array<[string, () => void]> = [
    [
      "recommendedDecisionOption maps decision options; manual_review/unknown map to null",
      testRecommendedMapping,
    ],
    [
      "DecisionButtons highlights the recommended option with badge",
      testRecommendedButtonHighlighted,
    ],
    [
      "DecisionButtons renders no highlight for manual_review",
      testNoHighlightWithoutRecommendation,
    ],
    [
      "DiffSummaryBlock renders the diff stat in a collapsible",
      testDiffSummaryRenders,
    ],
  ];

  for (const [name, run] of cases) {
    run();
    console.log(`PASS ${name}`);
  }
}

main();
