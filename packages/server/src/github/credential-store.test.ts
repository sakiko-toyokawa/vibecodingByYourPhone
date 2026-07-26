import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitHubCredentialStore } from "./credential-store.js";

test("GitHubCredentialStore stores PAT and only exposes masked status", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-gh-credentials-"));
  try {
    const store = new GitHubCredentialStore({ dataDir });
    await store.initialize();

    await store.setToken("github_pat_1234567890abcdef");

    assert.equal(await store.getToken(), "github_pat_1234567890abcdef");
    assert.deepEqual(store.getStatus(), {
      configured: true,
      tokenPreview: "gith...cdef",
      updatedAt: store.getStatus().updatedAt,
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("GitHubCredentialStore trims tokens and rejects empty values", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-gh-credentials-"));
  try {
    const store = new GitHubCredentialStore({ dataDir });
    await store.initialize();

    await assert.rejects(() => store.setToken("   "), /token is required/);

    await store.setToken("  ghp_token  ");
    assert.equal(await store.getToken(), "ghp_token");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
