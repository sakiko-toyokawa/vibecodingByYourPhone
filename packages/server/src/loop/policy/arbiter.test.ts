/**
 * arbiter.ts 裁决测试（05 阶段 2 policy projection）。
 *
 * 核心断言：硬闸门七项即使 bypass 也一律 hard_gate（bypass ≠ 绕过硬闸门，
 * 05 阶段 2 验收 4）；bypass 下本地可回滚动作自批准；manual 模式只读兜底。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopCard, PolicyProfile } from "@yep-anywhere/shared";
import { arbitrate } from "./arbiter.js";
import { resolvePolicyProfile } from "./profiles.js";

const WS = "/workspace/project";

function profileFor(mode: "manual" | "assisted" | "full_auto" | "bypass") {
  const card = {
    loop: {
      id: "loop-x",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: WS },
      verification: { required: [] },
      persistence: { state_file: "state/loop-x.json" },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 2 },
      policy: { approval_mode: mode },
    },
  } as unknown as LoopCard;
  const profile = resolvePolicyProfile(card);
  assert.ok(profile, "profile resolved");
  return profile;
}

const BYPASS = profileFor("bypass");
const ASSISTED = profileFor("assisted");

test("resolvePolicyProfile: no policy block → null (legacy read-only run)", () => {
  const card = {
    loop: {
      id: "loop-legacy",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: WS },
      verification: { required: [] },
      persistence: { state_file: "state/loop-legacy.json" },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 2 },
    },
  } as unknown as LoopCard;
  assert.equal(resolvePolicyProfile(card), null);
});

test("bypass: local rollbackable work self-approves", () => {
  const write = arbitrate(
    BYPASS,
    "Write",
    { file_path: `${WS}/src/foo.ts` },
    { workspacePath: WS },
  );
  assert.equal(write.decision, "allow");

  const test_ = arbitrate(
    BYPASS,
    "Bash",
    { command: "pnpm test" },
    { workspacePath: WS },
  );
  assert.equal(test_.decision, "allow");

  const read = arbitrate(BYPASS, "Read", {}, { workspacePath: WS });
  assert.equal(read.decision, "allow");

  const commit = arbitrate(
    BYPASS,
    "Bash",
    { command: "git add . && git commit -m 'wip'" },
    { workspacePath: WS },
  );
  assert.equal(commit.decision, "allow");
});

test("relation scope allows push/comment only for the active relation", () => {
  const relation = {
    relation_id: "rel-1",
    loop_id: "loop-x",
    subject: {
      type: "github_pr" as const,
      repository: "owner/repo",
      pr_number: 12,
      branch: "fix/12",
    },
    state: "awaiting_feedback" as const,
    last_processed: {},
    feedback_count: 0,
    repair_count: 0,
    created_at: "2026-08-11T00:00:00.000Z",
    updated_at: "2026-08-11T00:00:00.000Z",
  };
  const push = arbitrate(
    BYPASS,
    "Bash",
    { command: "git push fork fix/12" },
    { workspacePath: WS, relation },
  );
  assert.equal(push.decision, "allow");
  assert.match(push.reason, /relation-scoped action allowed/);

  const comment = arbitrate(
    BYPASS,
    "Bash",
    {
      command:
        "gh pr comment 12 --repo owner/repo --body 'fixed, please re-check'",
    },
    { workspacePath: WS, relation },
  );
  assert.equal(comment.decision, "allow");

  const otherBranch = arbitrate(
    BYPASS,
    "Bash",
    { command: "git push fork fix/13" },
    { workspacePath: WS, relation },
  );
  assert.equal(otherBranch.decision, "hard_gate");
});

test("direct allowlist: writes inside IntentContract.target.files are allowed; outside escalate", () => {
  const inside = arbitrate(
    BYPASS,
    "Edit",
    { file_path: "src/allowed.ts" },
    { workspacePath: WS, directWriteAllowlist: ["src"] },
  );
  assert.equal(inside.decision, "allow");

  const outside = arbitrate(
    BYPASS,
    "Write",
    { file_path: "other.ts" },
    { workspacePath: WS, directWriteAllowlist: ["src"] },
  );
  assert.equal(outside.decision, "hard_gate");
  assert.match(outside.reason, /IntentContract\.target\.files/);

  const bashOutside = arbitrate(
    BYPASS,
    "Bash",
    { command: "echo x > other.txt" },
    { workspacePath: WS, directWriteAllowlist: ["src"] },
  );
  assert.equal(bashOutside.decision, "hard_gate");
});

test("direct allowlist: managed workspace root allows Codex changes; escaped paths fail closed", () => {
  const inside = arbitrate(
    BYPASS,
    "Edit",
    {
      file_path: WS,
      changes: [
        { path: "src/allowed.ts", kind: { type: "update", move_path: null } },
      ],
    },
    { workspacePath: WS, directWriteAllowlist: ["."] },
  );
  assert.equal(inside.decision, "allow");

  const escaping = arbitrate(
    BYPASS,
    "Edit",
    {
      file_path: WS,
      changes: [
        { path: "../outside.ts", kind: { type: "update", move_path: null } },
      ],
    },
    { workspacePath: WS, directWriteAllowlist: ["."] },
  );
  assert.equal(escaping.decision, "hard_gate");
});

test("bypass: ALL seven hard gates still escalate (bypass ≠ 绕过硬闸门)", () => {
  const cases: Array<[string, unknown, string]> = [
    ["Bash", { command: "git merge feature" }, "merge"],
    ["Bash", { command: "npm run deploy" }, "deploy"],
    ["Bash", { command: "rm -rf /tmp/x" }, "delete"],
    ["Bash", { command: "npm publish" }, "publish"],
    ["Bash", { command: "stripe charges create" }, "bill"],
    ["Bash", { command: "curl https://hooks.slack.com/x" }, "notify"],
    ["Bash", { command: "gh issue close 1" }, "close"],
  ];
  for (const [tool, input, gate] of cases) {
    const verdict = arbitrate(BYPASS, tool, input, { workspacePath: WS });
    assert.equal(
      verdict.decision,
      "hard_gate",
      `${gate} must escalate under bypass`,
    );
    assert.equal(verdict.classification.hardGate, gate);
    assert.match(verdict.reason, new RegExp(gate));
  }
});

test("bypass: out-of-workspace / blacklisted non-gate actions escalate too", () => {
  const outside = arbitrate(
    BYPASS,
    "Write",
    { file_path: "/etc/hosts" },
    { workspacePath: WS },
  );
  assert.equal(outside.decision, "hard_gate");

  const unknown = arbitrate(
    BYPASS,
    "Bash",
    { command: "some-unknown-cli do-thing" },
    { workspacePath: WS },
  );
  assert.equal(unknown.decision, "allow");

  const blacklisted = arbitrate(
    BYPASS,
    "Bash",
    { command: "git push origin main" },
    { workspacePath: WS },
  );
  assert.equal(blacklisted.decision, "hard_gate");

  const interactive = arbitrate(
    BYPASS,
    "AskUserQuestion",
    {},
    { workspacePath: WS },
  );
  assert.equal(interactive.decision, "hard_gate");
});

test("review_or_policy is reviewable; human_required and hard gates are not", () => {
  const high = arbitrate(
    BYPASS,
    "Bash",
    { command: "git push origin main" },
    { workspacePath: WS },
  );
  assert.equal(high.decision, "hard_gate");
  assert.equal(high.reviewable, true);

  const hardGate = arbitrate(
    BYPASS,
    "Bash",
    { command: "git merge feature" },
    { workspacePath: WS },
  );
  assert.equal(hardGate.reviewable, undefined);

  const strict: PolicyProfile = {
    ...BYPASS,
    risk_rules: {
      ...BYPASS.risk_rules,
      high: "human_required",
    },
  };
  const human = arbitrate(
    strict,
    "Bash",
    { command: "git push origin main" },
    { workspacePath: WS },
  );
  assert.equal(human.decision, "hard_gate");
  assert.equal(human.reviewable, undefined);
});

test("bypass_scope narrows self-approval (workspace write disabled)", () => {
  const narrowed: PolicyProfile = {
    ...BYPASS,
    bypass_scope: {
      allow_workspace_write: false,
      allow_local_commands: true,
    },
  };
  const verdict = arbitrate(
    narrowed,
    "Write",
    { file_path: `${WS}/src/foo.ts` },
    { workspacePath: WS },
  );
  assert.equal(verdict.decision, "hard_gate");
  assert.match(verdict.reason, /allow_workspace_write=false/);
});

test("assisted: low/medium auto, high/critical escalate", () => {
  assert.equal(
    arbitrate(ASSISTED, "Read", {}, { workspacePath: WS }).decision,
    "allow",
  );
  assert.equal(
    arbitrate(
      ASSISTED,
      "Edit",
      { file_path: "src/a.ts" },
      {
        workspacePath: WS,
      },
    ).decision,
    "allow",
  );
  assert.equal(
    arbitrate(
      ASSISTED,
      "Bash",
      { command: "weird-cli x" },
      {
        workspacePath: WS,
      },
    ).decision,
    "allow",
  );
  assert.equal(
    arbitrate(
      ASSISTED,
      "Bash",
      { command: "git push origin main" },
      {
        workspacePath: WS,
      },
    ).decision,
    "hard_gate",
  );
  assert.equal(
    arbitrate(
      ASSISTED,
      "Bash",
      { command: "git merge f" },
      {
        workspacePath: WS,
      },
    ).decision,
    "hard_gate",
  );
});

test("manual: read-only allowed, everything else denied (no escalation storm)", () => {
  const MANUAL = profileFor("manual");
  assert.equal(
    arbitrate(MANUAL, "Read", {}, { workspacePath: WS }).decision,
    "allow",
  );
  const write = arbitrate(
    MANUAL,
    "Write",
    { file_path: `${WS}/src/a.ts` },
    { workspacePath: WS },
  );
  assert.equal(write.decision, "deny");
  // 硬闸门在 manual 下依然升级人工（不是静默 deny）
  const gate = arbitrate(
    MANUAL,
    "Bash",
    { command: "git merge f" },
    { workspacePath: WS },
  );
  assert.equal(gate.decision, "hard_gate");
});

test("profile carries the authoritative hard-gate list and default risk rules", () => {
  assert.deepEqual(BYPASS.hard_gates, [
    "merge",
    "deploy",
    "delete",
    "publish",
    "bill",
    "notify",
    "close",
  ]);
  assert.deepEqual(BYPASS.risk_rules, {
    low: "auto",
    medium: "auto_if_in_workspace",
    high: "review_or_policy",
    critical: "human_required",
  });
});

test("card-declared human_gate.required_for escalates through the hard-gate path", () => {
  // card 声明 close 必须人工闸门；resolvePolicyProfile 把它并入 hard_gates
  // 后，裁决与硬闸门同路径（decision=hard_gate 且 reason 是 hard-gate 命中，
  // 不是 risk_rules 的 human_required 升级）。
  const card = {
    loop: {
      id: "loop-hg",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: WS },
      verification: { required: [] },
      persistence: { state_file: "state/loop-hg.json" },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 2 },
      policy: { approval_mode: "bypass" },
      human_gate: { required_for: ["close"] },
    },
  } as unknown as LoopCard;
  const profile = resolvePolicyProfile(card);
  assert.ok(profile);
  const verdict = arbitrate(
    profile,
    "Bash",
    { command: "gh issue close 1" },
    { workspacePath: WS },
  );
  assert.equal(verdict.decision, "hard_gate");
  assert.match(verdict.reason, /hard gate 'close' hit/);
});

test("counterfactual: a gate word absent from hard_gates is not hard-gate blocked", () => {
  // 反证并入逻辑的意义：把 close 从 hard_gates 拿掉后，同一动作不再命中
  // 硬闸门路径（reason 无 hard-gate 命中字样；critical 风险仍经
  // risk_rules.human_required 升级，decision 不变、路径不同）。
  const withoutClose: PolicyProfile = {
    ...BYPASS,
    hard_gates: BYPASS.hard_gates.filter((g) => g !== "close"),
  };
  const verdict = arbitrate(
    withoutClose,
    "Bash",
    { command: "gh issue close 1" },
    { workspacePath: WS },
  );
  assert.equal(verdict.decision, "hard_gate");
  assert.doesNotMatch(verdict.reason, /hard gate/);
});
