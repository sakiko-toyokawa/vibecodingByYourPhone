import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runCommand,
  runVerificationCommands,
} from "../../../../packages/server/src/loop/verification/subprocess-verifier.js";

const cwd = process.cwd();

function memoryEvidence(): {
  writeEvidence: (name: string, content: string) => Promise<string>;
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  return {
    files,
    writeEvidence: (name, content) => {
      files.set(name, content);
      return Promise.resolve(`artifact://run-test/${name}`);
    },
  };
}

test("不存在的命令 → spawn_failed，verifier 报 inconclusive", async () => {
  const outcome = await runCommand(
    "__yep_benchmark_nonexistent_command_9f3b__",
    { cwd },
  );
  assert.equal(outcome.kind, "spawn_failed");

  const { writeEvidence } = memoryEvidence();
  const report = await runVerificationCommands({
    phase: "static",
    commands: ["__yep_benchmark_nonexistent_command_9f3b__"],
    cwd,
    writeEvidence,
  });
  assert.equal(report.status, "inconclusive");
  assert.equal(report.recommendation, "escalate");
});

test("混合结果中 failed 覆盖 inconclusive 与 passed", async () => {
  const { writeEvidence } = memoryEvidence();
  const report = await runVerificationCommands({
    phase: "static",
    commands: [
      `"${process.execPath}" -e "process.exit(0)"`, // passed
      "__yep_benchmark_nonexistent_command_9f3b__", // inconclusive
      `"${process.execPath}" -e "process.exit(2)"`, // failed
    ],
    cwd,
    writeEvidence,
  });
  assert.equal(report.status, "failed");
  assert.equal(report.recommendation, "retry");
  assert.equal(report.evidence_refs.length, 3);
  assert.equal(report.unresolved_risks.length, 2);
});

test("runCommand 保留非零退出码", async () => {
  const outcome = await runCommand(
    `"${process.execPath}" -e "process.exit(7)"`,
    { cwd },
  );
  assert.equal(outcome.kind, "exit");
  assert.equal(outcome.exitCode, 7);
});
