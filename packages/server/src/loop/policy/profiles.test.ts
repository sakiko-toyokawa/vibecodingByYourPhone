/**
 * profiles.ts 解析测试：card 级 human_gate.required_for 并入硬闸门。
 *
 * 核心断言：required_for 与档位 hard_gates 求并集、去重；未识别的词原样
 * 保留（裁决器按字符串匹配，不匹配即不生效、不报错）；无 human_gate 块
 * 时行为不变。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import { ALL_HARD_GATES, resolvePolicyProfile } from "./profiles.js";

const WS = "/workspace/project";

function cardWith(humanGate?: { required_for?: string[] }): LoopCard {
  return {
    loop: {
      id: "loop-hg",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: WS },
      verification: { required: [] },
      persistence: { state_file: "state/loop-hg.json" },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 2 },
      policy: { approval_mode: "bypass" },
      ...(humanGate ? { human_gate: humanGate } : {}),
    },
  } as unknown as LoopCard;
}

test("no human_gate block: hard_gates unchanged (registry default = 七项)", () => {
  const profile = resolvePolicyProfile(cardWith());
  assert.ok(profile);
  assert.deepEqual(profile.hard_gates, ALL_HARD_GATES);
});

test("empty required_for: hard_gates unchanged", () => {
  const profile = resolvePolicyProfile(cardWith({ required_for: [] }));
  assert.ok(profile);
  assert.deepEqual(profile.hard_gates, ALL_HARD_GATES);
});

test("required_for merges into hard_gates and dedupes against the profile", () => {
  // 当前所有命名档默认含全部七项（ALL_HARD_GATES），声明 delete/merge 是
  // 并集去重：每个词只出现一次，不重复、不膨胀。
  const profile = resolvePolicyProfile(
    cardWith({ required_for: ["delete", "merge"] }),
  );
  assert.ok(profile);
  assert.equal(profile.hard_gates.length, ALL_HARD_GATES.length);
  for (const gate of ["delete", "merge"]) {
    assert.equal(
      profile.hard_gates.filter((g) => g === gate).length,
      1,
      `${gate} must appear exactly once`,
    );
  }
});

test("unrecognized required_for words are kept verbatim (string-matched at arbitration)", () => {
  const profile = resolvePolicyProfile(
    cardWith({ required_for: ["purge_cache"] }),
  );
  assert.ok(profile);
  assert.equal(profile.hard_gates.length, ALL_HARD_GATES.length + 1);
  assert.ok((profile.hard_gates as string[]).includes("purge_cache"));
});

test("required_for merge survives a named profile override", () => {
  const profile = resolvePolicyProfile(
    cardWith({ required_for: ["wipe_cluster"] }),
    "loop_strict_review",
  );
  assert.ok(profile);
  assert.equal(profile.policy_profile, "loop_strict_review");
  assert.ok((profile.hard_gates as string[]).includes("wipe_cluster"));
});

test("allow_direct_mutations: explicit direct-worktree profiles opt in; loop_bypass does not", () => {
  const bypass = resolvePolicyProfile(cardWith(), "loop_bypass");
  assert.equal(bypass?.allow_direct_mutations, false);
  const localFix = resolvePolicyProfile(cardWith(), "workspace_local_fix");
  assert.equal(localFix?.allow_direct_mutations, true);
});
