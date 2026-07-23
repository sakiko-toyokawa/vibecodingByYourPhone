import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LearningEvent } from "@yep-anywhere/shared";
import { LearningEventStore } from "./learning-event-store.js";

function makeEvent(overrides: Partial<LearningEvent> = {}): LearningEvent {
  return {
    event_id: "learn-evt-decision-run-1-t1-complete",
    run_id: "run-1",
    loop_id: "loop-1",
    decision: "complete",
    judgment_ref: "artifact://run-1/judgment-report.json",
    ledger_refs: ["ledger://run-1", "ledger://decision-run-1"],
    failure_tags: [],
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

async function withStore(
  fn: (ctx: { dataDir: string; store: LearningEventStore }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-learning-event-"));
  try {
    const store = new LearningEventStore({ dataDir });
    await fn({ dataDir, store });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("append + read: 事件按序可读，nextOffset 推进到文件末尾", async () => {
  await withStore(async ({ store }) => {
    await store.appendEvent(makeEvent({ event_id: "evt-1" }));
    await store.appendEvent(
      makeEvent({
        event_id: "evt-2",
        decision: "failed",
        failure_tags: ["tool_error"],
      }),
    );

    const result = await store.readEvents(0);
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0]?.event_id, "evt-1");
    assert.deepEqual(result.events[1]?.failure_tags, ["tool_error"]);
    assert.equal(result.nextOffset, 2);
  });
});

test("offset 消费语义：从 cursor 位置读只拿到新事件", async () => {
  await withStore(async ({ store }) => {
    await store.appendEvent(makeEvent({ event_id: "evt-1" }));
    const first = await store.readEvents(0);
    assert.equal(first.events.length, 1);
    // worker 消费后记录位点
    await store.writeCursor(first.nextOffset);

    await store.appendEvent(makeEvent({ event_id: "evt-2" }));
    const cursor = await store.readCursor();
    assert.equal(cursor, 1);
    const second = await store.readEvents(cursor);
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0]?.event_id, "evt-2");
    assert.equal(second.nextOffset, 2);

    // 再读一次：无新事件
    const third = await store.readEvents(second.nextOffset);
    assert.equal(third.events.length, 0);
    assert.equal(third.nextOffset, 2);
  });
});

test("损坏行被跳过且 offset 照常推进（毒行只消费一次）", async () => {
  await withStore(async ({ dataDir, store }) => {
    await store.appendEvent(makeEvent({ event_id: "evt-1" }));
    const eventsFile = join(dataDir, "loops", "learning", "events.jsonl");
    await appendFile(eventsFile, "this is not json\n", "utf-8");
    await store.appendEvent(makeEvent({ event_id: "evt-2" }));

    const result = await store.readEvents(0);
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0]?.event_id, "evt-1");
    assert.equal(result.events[1]?.event_id, "evt-2");
    // 3 行（含毒行）都被消费
    assert.equal(result.nextOffset, 3);
  });
});

test("无 events.jsonl 时读为空，offset 保持不变", async () => {
  await withStore(async ({ store }) => {
    const result = await store.readEvents(5);
    assert.deepEqual(result.events, []);
    assert.equal(result.nextOffset, 5);
  });
});

test("cursor 缺失 / 损坏时读作 0（幂等重消费安全）", async () => {
  await withStore(async ({ dataDir, store }) => {
    assert.equal(await store.readCursor(), 0);
    const learningDir = join(dataDir, "loops", "learning");
    await mkdir(learningDir, { recursive: true });
    const cursorFile = join(learningDir, "cursor.json");
    await writeFile(cursorFile, "{corrupt", "utf-8");
    assert.equal(await store.readCursor(), 0);
    // 非法 offset 也读作 0
    await writeFile(
      cursorFile,
      JSON.stringify({ version: 1, offset: -3 }),
      "utf-8",
    );
    assert.equal(await store.readCursor(), 0);
  });
});

test("schema 校验：非法事件拒绝写入", async () => {
  await withStore(async ({ store }) => {
    await assert.rejects(
      store.appendEvent(makeEvent({ failure_tags: ["not_a_tag" as never] })),
    );
    const result = await store.readEvents(0);
    assert.equal(result.events.length, 0);
  });
});
