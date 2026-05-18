import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveFilePath, resolveProjectPath } from "./files.js";

async function testRejectsTraversal(): Promise<void> {
  const resolved = resolveFilePath("C:\\repo", "..\\outside.txt");
  console.log(`[TEST] resolved=${resolved}`);
  assert.equal(resolved, null);
}

async function testAllowsRegularFilesInsideProject(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "yep-editor-root-"));

  try {
    const filePath = join(rootDir, "src", "index.ts");
    await mkdir(join(rootDir, "src"), { recursive: true });
    await writeFile(filePath, "export const ok = true;\n", "utf8");

    const resolved = await resolveProjectPath(rootDir, "src/index.ts");
    console.log(`[TEST] resolved=${resolved} expected=${resolve(filePath)}`);
    assert.equal(resolved, resolve(filePath));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

async function testRejectsEscapingJunctionReads(): Promise<void> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "yep-editor-workspace-"));
  const projectRoot = join(workspaceDir, "project");
  const outsideDir = join(workspaceDir, "outside");
  const junctionPath = join(projectRoot, "escape");

  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "secret.txt"), "nope\n", "utf8");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    console.log(
      `[TEST] creating symlink type=${linkType} target=${outsideDir} link=${junctionPath}`,
    );
    try {
      await symlink(outsideDir, junctionPath, linkType);
    } catch (e) {
      console.error("[TEST] symlink failed:", e);
      throw e;
    }

    const resolved = await resolveProjectPath(projectRoot, "escape/secret.txt");
    console.log(`[TEST] resolved=${resolved}`);
    assert.equal(resolved, null);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testRejectsEscapingJunctionWrites(): Promise<void> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "yep-editor-write-"));
  const projectRoot = join(workspaceDir, "project");
  const outsideDir = join(workspaceDir, "outside");
  const junctionPath = join(projectRoot, "escape");

  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    const linkType = process.platform === "win32" ? "junction" : "dir";
    console.log(
      `[TEST] creating symlink type=${linkType} target=${outsideDir} link=${junctionPath}`,
    );
    try {
      await symlink(outsideDir, junctionPath, linkType);
    } catch (e) {
      console.error("[TEST] symlink failed:", e);
      throw e;
    }

    const resolved = await resolveProjectPath(
      projectRoot,
      "escape/new-file.ts",
    );
    console.log(`[TEST] resolved=${resolved}`);
    assert.equal(resolved, null);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log(
    `[TEST] platform=${process.platform} node=${process.version} cwd=${process.cwd()}`,
  );

  const cases: Array<[string, () => Promise<void>]> = [
    ["resolveFilePath rejects path traversal", testRejectsTraversal],
    [
      "resolveProjectPath allows regular files inside the project",
      testAllowsRegularFilesInsideProject,
    ],
    [
      "resolveProjectPath rejects junctions that escape the project root",
      testRejectsEscapingJunctionReads,
    ],
    [
      "resolveProjectPath rejects new files created through escaping junctions",
      testRejectsEscapingJunctionWrites,
    ],
  ];

  for (const [name, run] of cases) {
    console.log(`[TEST] starting: ${name}`);
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      console.error(`FAIL ${name}`);
      console.error(error);
      throw error;
    }
  }
}

main().catch((error) => {
  console.error("[TEST] fatal error:", error);
  process.exitCode = 1;
});
