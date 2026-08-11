/**
 * codex 桥策略投影映射测试 (06 偏差 #39):
 * 策略钩子接线 (policyHookWired) 时, thread policy 保留合约安全等级对应
 * 的原生 sandbox, 但 approvalPolicy 取 untrusted —— 一切 file/command 变更
 * 仍经审批反向请求到达 loop 策略钩子, 不再 never + danger-full-access
 * (06 #24 的静默失效路径)。
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

test("policy hook wired → native sandbox by contract level + untrusted approval", () => {
  const fullAccess = map("bypassPermissions", true);
  assert.equal(fullAccess.approvalPolicy, "untrusted");
  assert.equal(fullAccess.sandbox, "danger-full-access");

  const workspaceWrite = map("default", true);
  assert.equal(workspaceWrite.approvalPolicy, "untrusted");
  assert.equal(workspaceWrite.sandbox, "workspace-write");

  const readOnly = map("plan", true);
  assert.equal(readOnly.approvalPolicy, "untrusted");
  assert.equal(readOnly.sandbox, "read-only");
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
