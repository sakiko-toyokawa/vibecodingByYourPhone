/**
 * codex 桥策略投影映射测试 (06 偏差 #39):
 * 策略钩子接线 (policyHookWired) 时, thread policy 映射为
 * on-request + read-only —— 一切变更经审批反向请求到达 loop 策略钩子,
 * 不再 never + danger-full-access (06 #24 的静默失效路径)。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexProvider } from "./codex.js";

type ThreadPolicy = {
  approvalPolicy: string;
  sandbox: string;
};

function map(permissionMode?: string, policyHookWired?: boolean): ThreadPolicy {
  const provider = new CodexProvider() as unknown as {
    mapPermissionModeToThreadPolicy(
      permissionMode?: string,
      policyHookWired?: boolean,
    ): ThreadPolicy;
  };
  return provider.mapPermissionModeToThreadPolicy(
    permissionMode,
    policyHookWired,
  );
}

test("policy hook wired → on-request + read-only (loop 策略投影桥)", () => {
  const policy = map("bypassPermissions", true);
  assert.equal(policy.approvalPolicy, "on-request");
  assert.equal(policy.sandbox, "read-only");
});

test("no hook → 交互语义不变 (bypassPermissions = never + danger-full-access)", () => {
  const policy = map("bypassPermissions", false);
  assert.equal(policy.approvalPolicy, "never");
  assert.equal(policy.sandbox, "danger-full-access");

  const plan = map("plan", false);
  assert.equal(plan.approvalPolicy, "on-request");
  assert.equal(plan.sandbox, "read-only");

  const def = map("default", false);
  assert.equal(def.approvalPolicy, "on-request");
  assert.equal(def.sandbox, "workspace-write");
});
