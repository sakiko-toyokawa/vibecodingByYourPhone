import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitHubToolProvisioner } from "./tool-provisioner.js";

test("GitHubToolProvisioner reuses an existing pinned gh binary", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-gh-tools-"));
  try {
    const provisioner = new GitHubToolProvisioner({
      dataDir,
      platform: "win32",
      arch: "x64",
      version: "2.64.0",
      pathExists: async () => true,
      downloadAndExtract: async () => {
        throw new Error("download should not run");
      },
    });

    const status = await provisioner.ensureGh();

    assert.equal(status.installed, true);
    assert.equal(
      status.path,
      join(
        dataDir,
        "tools",
        "gh",
        "2.64.0",
        "gh_2.64.0_windows_amd64",
        "bin",
        "gh.exe",
      ),
    );
    assert.equal(status.version, "2.64.0");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("GitHubToolProvisioner downloads and extracts when binary is missing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-gh-tools-"));
  try {
    let requestedUrl = "";
    let targetDir = "";
    const provisioner = new GitHubToolProvisioner({
      dataDir,
      platform: "linux",
      arch: "x64",
      version: "2.64.0",
      pathExists: async () => false,
      downloadAndExtract: async (url, destination) => {
        requestedUrl = url;
        targetDir = destination;
      },
    });

    const status = await provisioner.ensureGh();

    assert.equal(status.installed, true);
    assert.match(requestedUrl, /cli\/cli\/releases\/download\/v2\.64\.0/);
    assert.match(requestedUrl, /linux_amd64\.tar\.gz$/);
    assert.equal(targetDir, join(dataDir, "tools", "gh", "2.64.0"));
    await stat(targetDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("GitHubToolProvisioner resolves a flat extracted gh layout", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-gh-flat-"));
  try {
    const flatBin = join(dataDir, "tools", "gh", "2.64.0", "bin");
    await mkdir(flatBin, { recursive: true });
    await writeFile(join(flatBin, "gh.exe"), "");

    const provisioner = new GitHubToolProvisioner({
      dataDir,
      platform: "win32",
      arch: "x64",
      version: "2.64.0",
    });

    assert.equal(provisioner.getGhPath(), join(flatBin, "gh.exe"));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("GitHubToolProvisioner returns the actual path after flat extraction", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-gh-extract-"));
  try {
    const provisioner = new GitHubToolProvisioner({
      dataDir,
      platform: "win32",
      arch: "x64",
      version: "2.64.0",
      pathExists: async (filePath) => {
        try {
          await stat(filePath);
          return true;
        } catch {
          return false;
        }
      },
      downloadAndExtract: async (_url, destination) => {
        await mkdir(join(destination, "bin"), { recursive: true });
        await writeFile(join(destination, "bin", "gh.exe"), "");
      },
    });

    const status = await provisioner.ensureGh();

    assert.equal(
      status.path,
      join(dataDir, "tools", "gh", "2.64.0", "bin", "gh.exe"),
    );
    assert.equal(status.installed, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
