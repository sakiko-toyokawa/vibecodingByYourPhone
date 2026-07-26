/**
 * classify.ts 分类表全覆盖测试（05 阶段 2 policy projection）。
 *
 * 覆盖：只读工具、写工具（workspace 内/外）、Bash 硬闸门七项、
 * 本地只读 / 本地可回滚 / 未知命令的风险分级、复合命令拆段，
 * 以及误报边界（git merge --abort 不算 merge —— 见 classify.ts 文件头
 * 的边界定义）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyToolCall, isInsideWorkspace } from "./classify.js";

const WS = "/workspace/project";

function bash(command: string) {
  return classifyToolCall("Bash", { command }, { workspacePath: WS });
}

test("read-only tools classify as low-risk reads", () => {
  for (const tool of ["Read", "Glob", "Grep", "WebFetch", "Agent"]) {
    const c = classifyToolCall(tool, {}, { workspacePath: WS });
    assert.equal(c.action, "read");
    assert.equal(c.risk, "low");
    assert.equal(c.hardGate, null);
    assert.equal(c.locallyRollbackable, true);
  }
});

test("file writes: inside workspace = medium/rollbackable, outside = high", () => {
  const inside = classifyToolCall(
    "Write",
    { file_path: `${WS}/src/foo.ts` },
    { workspacePath: WS },
  );
  assert.equal(inside.action, "write");
  assert.equal(inside.risk, "medium");
  assert.equal(inside.locallyRollbackable, true);
  assert.match(inside.summary, /src\/foo\.ts/);

  // 相对路径按 cwd 解析，视为 workspace 内
  const relative = classifyToolCall(
    "Edit",
    { file_path: "src/foo.ts" },
    { workspacePath: WS },
  );
  assert.equal(relative.risk, "medium");

  const outside = classifyToolCall(
    "Write",
    { file_path: "/etc/hosts" },
    { workspacePath: WS },
  );
  assert.equal(outside.action, "write");
  assert.equal(outside.risk, "high");
  assert.equal(outside.locallyRollbackable, false);

  // 无 workspace 上下文时写操作保守为 high
  const noCtx = classifyToolCall("Write", { file_path: "src/foo.ts" });
  assert.equal(noCtx.risk, "high");
});

test("interactive tools classify as high (unattended runs cannot answer)", () => {
  for (const tool of ["ExitPlanMode", "AskUserQuestion"]) {
    const c = classifyToolCall(tool, {}, { workspacePath: WS });
    assert.equal(c.risk, "high");
    assert.equal(c.hardGate, null);
  }
});

test("unknown tools (incl. MCP) classify conservatively as high", () => {
  const c = classifyToolCall(
    "mcp__github__create_issue",
    {},
    {
      workspacePath: WS,
    },
  );
  assert.equal(c.risk, "high");
  assert.equal(c.locallyRollbackable, false);
});

// --- 硬闸门七项 ---

test("merge: git merge hits the hard gate; --abort does NOT (边界定义)", () => {
  assert.equal(bash("git merge feature-x").hardGate, "merge");
  assert.equal(bash("git merge --no-ff feature-x").hardGate, "merge");

  // git merge --abort 是取消合并、恢复合并前状态：本地可回滚操作，
  // 不算 merge（classify.ts 文件头边界定义）
  const abort = bash("git merge --abort");
  assert.equal(abort.hardGate, null);
  assert.equal(abort.risk, "medium");
});

test("merge: force push (incl. --force-with-lease) hits; plain push is high", () => {
  assert.equal(bash("git push --force origin main").hardGate, "merge");
  assert.equal(
    bash("git push origin main --force-with-lease").hardGate,
    "merge",
  );

  const push = bash("git push origin main");
  assert.equal(push.hardGate, null);
  assert.equal(push.risk, "high");
});

test("deploy: deploy scripts / vercel / netlify / kubectl apply", () => {
  assert.equal(bash("npm run deploy").hardGate, "deploy");
  assert.equal(bash("pnpm deploy").hardGate, "deploy");
  assert.equal(bash("vercel deploy --prod").hardGate, "deploy");
  assert.equal(bash("netlify deploy").hardGate, "deploy");
  assert.equal(bash("kubectl apply -f k8s/").hardGate, "deploy");
});

test("publish: npm/pnpm/yarn publish and gh release create", () => {
  assert.equal(bash("npm publish").hardGate, "publish");
  assert.equal(bash("pnpm publish --access public").hardGate, "publish");
  assert.equal(bash("gh release create v1.2.3").hardGate, "publish");
  assert.equal(
    bash("gh repo fork owner/repo --clone=false").hardGate,
    "publish",
  );
  assert.equal(bash("gh pr create --draft --title fix").hardGate, "publish");
});

test("delete: rm -rf (any flag order) always hits, plain rm does not", () => {
  assert.equal(bash("rm -rf /tmp/x").hardGate, "delete");
  assert.equal(bash("rm -fr ./dist").hardGate, "delete");
  assert.equal(bash("rm -r -f ./dist").hardGate, "delete");
  // 即使 workspace 内路径也按 delete 升级（宁可误报）
  assert.equal(bash(`rm -rf ${WS}/dist`).hardGate, "delete");

  const plain = bash("rm src/foo.ts");
  assert.equal(plain.hardGate, null);
  assert.equal(plain.risk, "high");

  assert.equal(bash("git push origin --delete feature").hardGate, "delete");
  assert.equal(bash("git branch -D feature").hardGate, "delete");
});

test("notify: curl / wget / mail / gh comment", () => {
  assert.equal(
    bash("curl https://hooks.slack.com/x -d '{}'").hardGate,
    "notify",
  );
  assert.equal(bash("wget https://example.com/hook").hardGate, "notify");
  assert.equal(bash("mail -s hi ops@example.com").hardGate, "notify");
  assert.equal(bash("gh pr comment 12 -b 'lgtm'").hardGate, "notify");
  assert.equal(bash("gh issue comment 3 -b 'done'").hardGate, "notify");
});

test("close: gh issue/pr close", () => {
  assert.equal(bash("gh issue close 12").hardGate, "close");
  assert.equal(bash("gh pr close 34").hardGate, "close");
});

test("bill: payment providers / refund / payout", () => {
  assert.equal(bash("stripe charges create --amount 100").hardGate, "bill");
  assert.equal(bash("paypal payout now").hardGate, "bill");
  assert.equal(bash("node scripts/issue-refund.js --refund").hardGate, "bill");
});

// --- 风险分级（非硬闸门） ---

test("bash risk tiers: read-only low, local rollbackable medium, unknown high", () => {
  assert.equal(bash("ls -la").risk, "low");
  assert.equal(bash("git status").risk, "low");
  assert.equal(bash("git log --oneline | head -5").risk, "low");

  assert.equal(bash("pnpm test").risk, "medium");
  assert.equal(bash("npm run build").risk, "medium");
  assert.equal(bash("npx tsc --noEmit").risk, "medium");
  assert.equal(bash("git add . && git commit -m 'wip'").risk, "medium");
  // 本地可回滚组合（测试 + 提交）
  assert.equal(bash("pnpm test && git commit -m 'x'").risk, "medium");

  assert.equal(bash("some-unknown-cli do-thing").risk, "high");
  // 空命令保守为 high
  assert.equal(bash("").risk, "high");
  // 只读 + 未知混合 → 保守 high
  assert.equal(bash("ls && some-unknown-cli x").risk, "high");
});

test("compound commands: any segment hitting a hard gate gates the whole call", () => {
  assert.equal(bash("pnpm test && git merge feature").hardGate, "merge");
  assert.equal(bash("echo hi; curl https://x.example").hardGate, "notify");
  // --abort 段不命中，其他段也无硬闸门 → 整体不升级
  const abortCombo = bash("git merge --abort && git status");
  assert.equal(abortCombo.hardGate, null);
  assert.equal(abortCombo.risk, "medium");
});

test("isInsideWorkspace path containment", () => {
  assert.equal(isInsideWorkspace(`${WS}/a/b.ts`, WS), true);
  assert.equal(isInsideWorkspace("a/b.ts", WS), true);
  assert.equal(isInsideWorkspace(`${WS}/../outside.ts`, WS), false);
  assert.equal(isInsideWorkspace("/etc/passwd", WS), false);
  assert.equal(isInsideWorkspace("", WS), false);
  assert.equal(isInsideWorkspace("a.ts", undefined), false);
});

test("bash workspace boundary: outside write targets escalate to high/write", () => {
  // 重定向越界
  const redirect = bash("echo pwned > /etc/cron.d/evil");
  assert.equal(redirect.action, "write");
  assert.equal(redirect.risk, "high");
  assert.equal(redirect.locallyRollbackable, false);
  assert.match(redirect.summary, /outside workspace/);

  // 相对路径 .. 逃逸
  assert.equal(bash("echo x > ../escape.txt").risk, "high");

  // tee / cp 目标位 / dd of= / sed -i
  assert.equal(bash("cat a.log | tee /etc/b.log").risk, "high");
  assert.equal(bash("cp report.md /etc/nginx/").risk, "high");
  assert.equal(bash("dd if=a.img of=/dev/null").risk, "high");
  assert.equal(bash("sed -i 's/a/b/' /etc/hosts").risk, "high");

  // node -e 内联脚本里的越界绝对路径 (修复计划 #25 的标志性案例)
  const inline = bash(`node -e "fs.writeFileSync('/etc/pwned','x')"`);
  assert.equal(inline.action, "write");
  assert.equal(inline.risk, "high");
});

test("bash workspace boundary: inside-workspace writes keep their original grade", () => {
  // echo 是只读命令, workspace 内重定向不改变既有分级 (既有语义)
  assert.equal(bash("echo hi > out.txt").risk, "low");
  assert.equal(bash("pnpm test > result.log").risk, "medium");
  // cp/sed 本就不在本地可回滚清单, 默认 high (与边界检查无关, 不因
  // 目标在内而降低, 也不因目标在内而误报为 write)
  const cpInside = bash("cp a.txt b.txt");
  assert.equal(cpInside.risk, "high");
  assert.equal(cpInside.action, "execute");
  // 只读命令不扫参数路径
  assert.equal(bash("cat /etc/hosts").risk, "low");
  // 内联脚本无越界路径
  assert.equal(bash('node -e "console.log(1+1)"').risk, "medium");
});

test("bash workspace boundary: no workspace context = no boundary check (不误报)", () => {
  const verdict = classifyToolCall("Bash", {
    command: "echo x > /etc/cron.d/evil",
  });
  assert.equal(verdict.risk, "low");
});
