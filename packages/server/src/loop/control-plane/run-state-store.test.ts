import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunStateRecord } from "@yep-anywhere/shared";
import { RunStateStore } from "./run-state-store.js";

function makeState(
  runId: string,
  state: RunStateRecord["state"],
  turn: number,
): RunStateRecord {
  return {
    version: 2,
    goal_id: "g",
    run_id: runId,
    state,
    turn,
    intent_version: 1,
    workspace_ref: `workspace://loop-1/${runId}`,
    last_judgment: null,
    pending_approval: null,
    session_ref: null,
    budget: {
      max_tokens: 0,
      max_time_minutes: 30,
      max_turns: 3,
      max_retries: 2,
      used_tokens: 0,
      used_time_minutes: 0,
      used_turns: turn,
      used_retries: 0,
    },
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
}

async function withTempDir(
  fn: (dataDir: string) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-run-state-"));
  try {
    await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("save/load uses append-only state/<loop_id>.jsonl", async () => {
  await withTempDir(async (dataDir) => {
    const store = new RunStateStore({ dataDir });
    await store.save("loop-1", makeState("run-1", "active", 1));
    const raw = await readFile(
      join(dataDir, "loops", "state", "loop-1.jsonl"),
      "utf-8",
    );
    assert.equal(raw.trim().split("\n").length, 1);
    assert.deepEqual((await store.load("loop-1"))?.run_id, "run-1");
  });
});

test("old .json state files are ignored after direct switch", async () => {
  await withTempDir(async (dataDir) => {
    const stateDir = join(dataDir, "loops", "state");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(stateDir, { recursive: true }),
    );
    await writeFile(
      join(stateDir, "loop-legacy.json"),
      JSON.stringify(makeState("old-run", "active", 1)),
      "utf-8",
    );
    const store = new RunStateStore({ dataDir });
    assert.equal(await store.load("loop-legacy"), null);
    assert.deepEqual(await store.list(), []);
  });
});

test("checkpoint append + latestCheckpoint round-trip", async () => {
  await withTempDir(async (dataDir) => {
    const store = new RunStateStore({ dataDir });
    await store.save("loop-1", makeState("run-1", "retry", 2));
    await store.appendCheckpoint("loop-1", {
      run_id: "run-1",
      state: "retry",
      turn: 2,
      workspace_snapshot: { head: "abc", status: " M file.txt" },
      artifact_manifest_hash: "hash",
    });
    const checkpoint = await store.latestCheckpoint("loop-1");
    assert.equal(checkpoint?.run_id, "run-1");
    assert.equal(checkpoint?.turn, 2);
    assert.equal(checkpoint?.workspace_snapshot?.head, "abc");
    assert.equal((await store.readEvents("loop-1")).length, 2);
  });
});

test("corrupt tail does not hide the previous valid state", async () => {
  await withTempDir(async (dataDir) => {
    const store = new RunStateStore({ dataDir });
    await store.save("loop-1", makeState("run-1", "active", 1));
    await import("node:fs/promises").then((fs) =>
      fs.appendFile(
        join(dataDir, "loops", "state", "loop-1.jsonl"),
        "not-json-at-all\n",
        "utf-8",
      ),
    );
    assert.equal((await store.load("loop-1"))?.run_id, "run-1");
  });
});

test("checksum mismatch rolls back to the previous valid event", async () => {
  await withTempDir(async (dataDir) => {
    const store = new RunStateStore({ dataDir });
    await store.save("loop-1", makeState("run-1", "active", 1));
    await store.save("loop-1", makeState("run-1", "complete", 2));
    const filePath = join(dataDir, "loops", "state", "loop-1.jsonl");
    const lines = (await readFile(filePath, "utf-8")).trim().split("\n");
    const last = JSON.parse(lines.at(-1) ?? "") as Record<string, unknown>;
    last.checksum = "bad";
    lines[lines.length - 1] = JSON.stringify(last);
    await writeFile(filePath, `${lines.join("\n")}\n`, "utf-8");
    const loaded = await store.load("loop-1");
    assert.equal(loaded?.state, "active");
    assert.equal(loaded?.turn, 1);
  });
});
