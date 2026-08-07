import assert from "node:assert/strict";
import { test } from "node:test";
import { extractTargetFiles } from "../../../../packages/server/src/loop/contract/intent-contract.js";

test("extractTargetFiles strips punctuation, deduplicates, and keeps relative paths", () => {
  const files = extractTargetFiles(
    "修复 `packages/server/src/loop/run-service.ts`, 以及 (src/foo/bar.tsx)。 再看 packages/server/src/loop/run-service.ts 一遍",
  );
  assert.deepEqual(files, [
    "packages/server/src/loop/run-service.ts",
    "src/foo/bar.tsx",
  ]);
});

test("extractTargetFiles drops absolute, Windows, and parent-escape paths", () => {
  assert.deepEqual(extractTargetFiles("看 /etc/nginx/nginx.conf"), []);
  assert.deepEqual(extractTargetFiles("看 C:/Users/admin/a.ts"), []);
  assert.deepEqual(extractTargetFiles("看 ../outside/secret.ts"), []);
});

test("extractTargetFiles ignores tokens without extension or without slash", () => {
  assert.deepEqual(extractTargetFiles("阅读 README 和 src/ 目录"), []);
  assert.deepEqual(extractTargetFiles("检查 run-service 函数"), []);
});

test("extractTargetFiles caps results at 20", () => {
  const task = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`).join(" ");
  const files = extractTargetFiles(task);
  assert.equal(files.length, 20);
  assert.equal(files[19], "src/f19.ts");
});

test("extractTargetFiles keeps distinct tokens in order", () => {
  const files = extractTargetFiles(
    "先改 a/b/c.ts 再改 d/e.tsx 最后看看 f/g/h.css",
  );
  assert.deepEqual(files, ["a/b/c.ts", "d/e.tsx", "f/g/h.css"]);
});
