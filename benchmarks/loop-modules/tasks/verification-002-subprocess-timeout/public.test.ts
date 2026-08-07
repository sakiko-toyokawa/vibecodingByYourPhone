import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_VERIFIER_TIMEOUT_MS,
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

test("runCommand 超时后返回 kind timeout 且 exitCode 为 null", async () => {
  const outcome = await runCommand(
    `"${process.execPath}" -e "setTimeout(() => {}, 30000)"`,
    { cwd, timeoutMs: 300 },
  );
  assert.equal(outcome.kind, "timeout");
  assert.equal(outcome.exitCode, null);
  assert.ok(outcome.durationMs < 3000, "应被提前终止");
});

test("runVerificationCommands 超时时产出 inconclusive + escalate", async () => {
  const { writeEvidence } = memoryEvidence();
  const report = await runVerificationCommands({
    phase: "static",
    commands: [`"${process.execPath}" -e "setTimeout(() => {}, 30000)"`],
    cwd,
    timeoutMs: 300,
    writeEvidence,
  });
  assert.equal(report.status, "inconclusive");
  assert.equal(report.recommendation, "escalate");
  assert.ok(
    report.unresolved_risks.some((risk) => risk.includes("timed out")),
    "应记录超时风险",
  );
});

test("默认超时值为 120 秒", () => {
  assert.equal(DEFAULT_VERIFIER_TIMEOUT_MS, 120_000);
});

test("runVerificationCommands 非零退出码 → failed + retry", async () => {
  const { writeEvidence } = memoryEvidence();
  const report = await runVerificationCommands({
    phase: "runtime",
    commands: [`"${process.execPath}" -e "process.exit(1)"`],
    cwd,
    writeEvidence,
  });
  assert.equal(report.status, "failed");
  assert.equal(report.recommendation, "retry");
});
