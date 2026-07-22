import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_VERIFIER_TIMEOUT_MS,
  runCommand,
  runVerificationCommands,
} from "./subprocess-verifier.js";

const cwd = process.cwd();

// Collect evidence writes in memory; returns refs like the real sink does.
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

test("runCommand: exit 0 → kind exit with code 0", async () => {
  const outcome = await runCommand('node -e "process.exit(0)"', { cwd });
  assert.equal(outcome.kind, "exit");
  assert.equal(outcome.exitCode, 0);
});

test("runCommand: non-zero exit code is preserved", async () => {
  const outcome = await runCommand('node -e "process.exit(3)"', { cwd });
  assert.equal(outcome.kind, "exit");
  assert.equal(outcome.exitCode, 3);
});

test("runCommand: output is captured", async () => {
  const outcome = await runCommand(
    "node -e \"console.log('hello-verifier')\"",
    {
      cwd,
    },
  );
  assert.equal(outcome.kind, "exit");
  assert.match(outcome.output, /hello-verifier/);
});

test("runCommand: timeout kills the process and reports kind timeout", async () => {
  const outcome = await runCommand('node -e "setTimeout(() => {}, 30000)"', {
    cwd,
    timeoutMs: 300,
  });
  assert.equal(outcome.kind, "timeout");
  assert.equal(outcome.exitCode, null);
  assert.ok(outcome.durationMs < 30000);
});

test("runCommand: nonexistent command → spawn_failed (not runnable)", async () => {
  const outcome = await runCommand("__yep_nonexistent_command_9f3b__", { cwd });
  assert.equal(outcome.kind, "spawn_failed");
});

test("runVerificationCommands: exit 0 → passed report with evidence ref", async () => {
  const { writeEvidence, files } = memoryEvidence();
  const report = await runVerificationCommands({
    phase: "static",
    commands: ['node -e "process.exit(0)"'],
    cwd,
    writeEvidence,
  });
  assert.equal(report.verifier_phase, "static");
  assert.equal(report.status, "passed");
  assert.equal(report.recommendation, "stop");
  assert.equal(report.requires_human, false);
  assert.deepEqual(report.unresolved_risks, []);
  assert.deepEqual(report.evidence_refs, [
    "artifact://run-test/verifier-output-static-0.log",
  ]);
  assert.match(files.get("verifier-output-static-0.log") ?? "", /exit 0/);
});

test("runVerificationCommands: non-zero exit → failed + retry recommendation", async () => {
  const { writeEvidence } = memoryEvidence();
  const report = await runVerificationCommands({
    phase: "runtime",
    commands: ['node -e "process.exit(1)"'],
    cwd,
    writeEvidence,
  });
  assert.equal(report.status, "failed");
  assert.equal(report.recommendation, "retry");
  assert.equal(report.unresolved_risks.length, 1);
  assert.match(report.unresolved_risks[0] ?? "", /exited with code 1/);
});

test("runVerificationCommands: timeout → inconclusive + escalate", async () => {
  const { writeEvidence } = memoryEvidence();
  const report = await runVerificationCommands({
    phase: "static",
    commands: ['node -e "setTimeout(() => {}, 30000)"'],
    cwd,
    timeoutMs: 300,
    writeEvidence,
  });
  assert.equal(report.status, "inconclusive");
  assert.equal(report.recommendation, "escalate");
  assert.match(report.unresolved_risks[0] ?? "", /timed out after 300ms/);
});

test("runVerificationCommands: worst status wins across commands", async () => {
  const { writeEvidence } = memoryEvidence();
  const report = await runVerificationCommands({
    phase: "static",
    commands: [
      'node -e "process.exit(0)"',
      "__yep_nonexistent_command_9f3b__", // inconclusive
      'node -e "process.exit(2)"', // failed
    ],
    cwd,
    writeEvidence,
  });
  assert.equal(report.status, "failed");
  assert.equal(report.evidence_refs.length, 3);
  assert.equal(report.unresolved_risks.length, 2);
});

test("runVerificationCommands: no commands → inconclusive without evidence", async () => {
  const { writeEvidence, files } = memoryEvidence();
  const report = await runVerificationCommands({
    phase: "runtime",
    commands: [],
    cwd,
    writeEvidence,
  });
  assert.equal(report.status, "inconclusive");
  assert.equal(report.recommendation, "escalate");
  assert.deepEqual(report.evidence_refs, []);
  assert.equal(files.size, 0);
});

test("default timeout constant is 120s", () => {
  assert.equal(DEFAULT_VERIFIER_TIMEOUT_MS, 120_000);
});
