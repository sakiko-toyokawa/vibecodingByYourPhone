import { runRuntimeEvaluation } from "./evaluator.js";

const prompt =
  "Create a plan.md, then implement src/main.js according to the plan, then verify with tests.";

async function main() {
  const result = await runRuntimeEvaluation({
    prompt,
    maxTurns: 3,
    turns: [
      { result: "Created plan.md with a simple design." },
      { result: "Implemented src/main.js according to plan." },
      { result: "All tests pass. Task complete." },
    ],
  });

  console.log(JSON.stringify(result, null, 2));

  console.log("\n# Multi-turn Loop Runtime Evaluation Summary");
  console.log(`- run_id: ${result.runId}`);
  console.log(`- final_state: ${result.finalState}`);
  console.log(`- terminal: ${result.terminal}`);
  console.log(`- elapsed_ms: ${result.elapsedMs}`);
  console.log(`- state_trace_turns: ${result.stateTrace.length}`);
  console.log(
    `- stage_score: ${result.stages.filter((s) => s.passed).length}/${result.stages.length}`,
  );

  console.log("\n| Turn | State | Time |");
  console.log("|---|---|---|");
  for (const [i, entry] of result.stateTrace.entries()) {
    console.log(`| ${i + 1} | ${entry.state} | ${entry.at} |`);
  }
}

void main();
