import { runRuntimeEvaluation } from "./evaluator.js";

async function main() {
  const args = process.argv.slice(2);
  const prompt = args[0] ?? "Scan the workspace and report any TODO comments";
  const lintFails = args.includes("--lint-fails");
  const testFails = args.includes("--test-fails");
  const maxTurns = Number(
    args.find((_, i) => args[i - 1] === "--max-turns") ?? 3,
  );
  const maxRetries = Number(
    args.find((_, i) => args[i - 1] === "--max-retries") ?? 2,
  );

  console.error(`Running loop runtime evaluation with prompt:\n${prompt}\n`);

  const result = await runRuntimeEvaluation({
    prompt,
    lintFails,
    testFails,
    maxTurns,
    maxRetries,
    timeoutMs: 30_000,
  });

  console.log(JSON.stringify(result, null, 2));

  // Human-readable summary on stderr
  const totalScore = result.stages.reduce((sum, s) => sum + s.score, 0);
  const maxScore = result.stages.length;
  console.error("\n# Loop Runtime Evaluation Summary");
  console.error(`- run_id: ${result.runId}`);
  console.error(`- final_state: ${result.finalState ?? "unknown"}`);
  console.error(`- terminal: ${result.terminal}`);
  console.error(`- elapsed_ms: ${result.elapsedMs}`);
  console.error(`- stage_score: ${totalScore}/${maxScore}`);
  console.error("\n| Stage | Passed | Score | Reason |");
  console.error("|---|---|---|---|");
  for (const stage of result.stages) {
    console.error(
      `| ${stage.stage} | ${stage.passed} | ${stage.score} | ${stage.reason} |`,
    );
  }
}

void main();
