import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractJson,
  parseVerifierAgentOutput,
  parseVerifierAgentVerdict,
} from "./parse.js";

const VALID_VERDICT = {
  status: "failed",
  recommendation: "retry",
  confidence: 0.8,
  requires_human: false,
  score: 0.55,
  unresolved_risks: ["邊界條件未覆蓋"],
  issues: [
    {
      severity: "major",
      message: "需求要求 X 但實作只有 Y",
      location: { file: "src/a.ts", line: 12 },
      suggestion: "補上 X",
    },
  ],
  suggested_fix: "補齊 X 的實作",
  adversarial_findings: ["可以把空陣列當作通過證據"],
};

test("extractJson: 優先取最後一個 fenced json block", () => {
  const text = `前言\n\`\`\`json\n{"a":1}\n\`\`\`\n中間\n\`\`\`json\n{"b":2}\n\`\`\``;
  assert.deepEqual(extractJson(text), { b: 2 });
});

test("extractJson: 無 fenced block 時回落第一對大括號", () => {
  assert.deepEqual(extractJson('result is {"ok":true} done'), { ok: true });
  assert.equal(extractJson("no json at all"), null);
});

test("extractJson: 修復常見 trailing comma", () => {
  assert.deepEqual(
    extractJson(`{"status":"passed","recommendation":"stop",}`),
    { status: "passed", recommendation: "stop" },
  );
  assert.deepEqual(extractJson('```json\n{"issues":[],}\n```'), { issues: [] });
});

test("parseVerifierAgentVerdict: 回傳可給 retry prompt 用的錯誤訊息", () => {
  const invalid = parseVerifierAgentVerdict(
    "No further work is pending. The verdict is passed.",
  );
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.match(invalid.error, /no JSON object found/);
  }

  const schemaInvalid = parseVerifierAgentVerdict(
    JSON.stringify({ status: "bogus", recommendation: "stop" }),
  );
  assert.equal(schemaInvalid.ok, false);
  if (!schemaInvalid.ok) {
    assert.match(schemaInvalid.error, /status/);
  }
});

test("parseVerifierAgentOutput: 合法裁決映射為 VerifierReport", () => {
  const report = parseVerifierAgentOutput(JSON.stringify(VALID_VERDICT), {
    outputRef: "artifact://run-1/verifier-agent-output.log",
    extraEvidenceRefs: ["artifact://run-1/verifier-agent-input.json"],
  });
  assert.equal(report.verifier_phase, "review");
  assert.equal(report.status, "failed");
  assert.equal(report.recommendation, "retry");
  assert.equal(report.score, 0.55);
  assert.equal(report.issues?.length, 1);
  assert.equal(report.issues?.[0]?.id, "L4-001");
  assert.equal(report.issues?.[0]?.layer, "review");
  assert.equal(report.suggested_fix, "補齊 X 的實作");
  // 對抗性發現進 unresolved_risks
  assert.ok(
    report.unresolved_risks.some((risk) =>
      risk.startsWith("adversarial: 可以把空陣列"),
    ),
  );
  // 證據引用帶上輸出與輸入包
  assert.ok(
    report.evidence_refs.includes("artifact://run-1/verifier-agent-output.log"),
  );
});

test("parseVerifierAgentOutput: 無效輸出降級 inconclusive + escalate", () => {
  const report = parseVerifierAgentOutput("我覺得應該沒問題吧", {
    outputRef: "artifact://run-1/out.log",
  });
  assert.equal(report.status, "inconclusive");
  assert.equal(report.recommendation, "escalate");
  assert.match(report.unresolved_risks[0] ?? "", /無法解析/);
});

test("parseVerifierAgentOutput: 枚舉越界 (status=bogus) 同樣降級", () => {
  const report = parseVerifierAgentOutput(
    JSON.stringify({ ...VALID_VERDICT, status: "bogus" }),
    { outputRef: "artifact://run-1/out.log" },
  );
  assert.equal(report.status, "inconclusive");
  assert.equal(report.recommendation, "escalate");
});

test("parseVerifierAgentOutput: 缺省欄位有預設值", () => {
  const report = parseVerifierAgentOutput(
    JSON.stringify({
      status: "passed",
      recommendation: "stop",
      confidence: 0.9,
    }),
    { outputRef: "artifact://run-1/out.log" },
  );
  assert.equal(report.status, "passed");
  assert.equal(report.requires_human, false);
  assert.deepEqual(report.unresolved_risks, []);
  assert.equal(report.issues?.length, 0);
});

test("parseVerifierAgentOutput: 接受字串數字 confidence/score 與 location", () => {
  const report = parseVerifierAgentOutput(
    JSON.stringify({
      status: "passed",
      recommendation: "stop",
      confidence: "0.95",
      requires_human: false,
      score: "0.97",
      issues: [
        {
          severity: "minor",
          message: "example",
          location: { file: "src/a.ts", line: "12", column: "4" },
        },
      ],
    }),
    { outputRef: "artifact://run-1/out.log" },
  );
  assert.equal(report.status, "passed");
  assert.equal(report.confidence, 0.95);
  assert.equal(report.score, 0.97);
  assert.equal(report.issues?.[0]?.location?.line, 12);
  assert.equal(report.issues?.[0]?.location?.column, 4);
});
