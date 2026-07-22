/**
 * Process.handleToolApproval 回归测试（05 阶段 2 policy projection）。
 *
 * 证明影响面：
 *  - 不带 hook 的会话（= 全部交互会话）四档 permissionMode 行为与
 *    显式 deny/allow 规则保持原样；
 *  - hook 是 opt-in：只在装配时注入才参与裁决，且显式 deny 规则仍优先
 *    （防御纵深）；hook 返回 undefined 时回落到既有 mode 逻辑。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKMessage } from "../sdk/types.js";
import { Process } from "./Process.js";
import type { ToolApprovalHook } from "./types.js";

/** Immediately-done iterator: processMessages() drains and settles. */
function doneIterator(): AsyncIterator<SDKMessage> {
  return {
    next: async () => ({ done: true, value: undefined }),
  };
}

function makeProcess(options: {
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  permissions?: { deny?: string[]; allow?: string[] };
  toolApprovalHook?: ToolApprovalHook;
}): Process {
  return new Process(doneIterator(), {
    projectPath: "/tmp/policy-hook-test",
    projectId: "policy-hook-test" as never,
    sessionId: "session-1",
    provider: "claude",
    permissionMode: options.permissionMode,
    permissions: options.permissions,
    toolApprovalHook: options.toolApprovalHook,
  });
}

const signal = new AbortController().signal;

test("no hook: plan mode auto-allows read-only tools (interactive baseline)", async () => {
  const proc = makeProcess({ permissionMode: "plan" });
  try {
    const result = await proc.handleToolApproval("Read", {}, { signal });
    assert.deepEqual(result, { behavior: "allow" });
  } finally {
    await proc.abort();
  }
});

test("no hook: acceptEdits auto-allows edit tools (existing tier intact)", async () => {
  const proc = makeProcess({ permissionMode: "acceptEdits" });
  try {
    const edit = await proc.handleToolApproval(
      "Edit",
      { file_path: "/tmp/x.ts" },
      { signal },
    );
    assert.deepEqual(edit, { behavior: "allow" });
  } finally {
    await proc.abort();
  }
});

test("no hook: bypassPermissions auto-allows non-interactive tools", async () => {
  const proc = makeProcess({ permissionMode: "bypassPermissions" });
  try {
    const result = await proc.handleToolApproval(
      "Bash",
      { command: "rm -rf /" },
      { signal },
    );
    assert.deepEqual(result, { behavior: "allow" });
  } finally {
    await proc.abort();
  }
});

test("no hook: explicit deny rules still block before mode logic", async () => {
  const proc = makeProcess({
    permissionMode: "bypassPermissions",
    permissions: { deny: ["Bash(rm *)"] },
  });
  try {
    const result = await proc.handleToolApproval(
      "Bash",
      { command: "rm -rf /tmp/x" },
      { signal },
    );
    assert.equal(result.behavior, "deny");
    assert.match(result.message ?? "", /Blocked by permission rule/);
  } finally {
    await proc.abort();
  }
});

test("hook is consulted and short-circuits the mode logic", async () => {
  const seen: string[] = [];
  const hook: ToolApprovalHook = async (toolName) => {
    seen.push(toolName);
    return { behavior: "deny", message: "policy says no" };
  };
  // plan 模式下 Read 本应自动放行；hook 优先裁决为 deny
  const proc = makeProcess({ permissionMode: "plan", toolApprovalHook: hook });
  try {
    const result = await proc.handleToolApproval("Read", {}, { signal });
    assert.deepEqual(result, { behavior: "deny", message: "policy says no" });
    assert.deepEqual(seen, ["Read"]);
  } finally {
    await proc.abort();
  }
});

test("hook returning undefined falls through to the existing mode logic", async () => {
  const hook: ToolApprovalHook = async () => undefined;
  const proc = makeProcess({ permissionMode: "plan", toolApprovalHook: hook });
  try {
    const result = await proc.handleToolApproval("Read", {}, { signal });
    assert.deepEqual(result, { behavior: "allow" });
  } finally {
    await proc.abort();
  }
});

test("explicit deny rules take precedence over the hook (defense in depth)", async () => {
  const hook: ToolApprovalHook = async () => ({ behavior: "allow" });
  const proc = makeProcess({
    permissionMode: "bypassPermissions",
    permissions: { deny: ["Bash(rm *)"] },
    toolApprovalHook: hook,
  });
  try {
    const result = await proc.handleToolApproval(
      "Bash",
      { command: "rm -rf /tmp/x" },
      { signal },
    );
    assert.equal(result.behavior, "deny");
  } finally {
    await proc.abort();
  }
});
