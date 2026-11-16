import test from "node:test";
import assert from "node:assert/strict";
import { FixtureConsole } from "../console-constructor.js";
import { historicalReceipt } from "../../src/bot/contracts.js";
import type { RunReceipt } from "../../src/bot/contracts.js";

function fixture(t: test.TestContext) {
  const data = new Map<string, unknown>([
    ["console:topic:s", { chatId: 1, threadId: 2, activeTurn: 3 }],
  ]);
  const sent: string[] = [];
  const cleared: number[] = [];
  let next = 100;
  let scans = 0;
  const surface = new FixtureConsole({
    ownerId: 1,
    bridge: {},
    store: {
      async get(key) {
        return structuredClone(data.get(key));
      },
      async set(key, value) {
        data.set(key, structuredClone(value));
      },
      async entries() {
        scans++;
        return [...data];
      },
    },
    api: {
      async call(method, params = {}) {
        if (method === "sendMessage") {
          assert.equal(typeof params.text, "string");
          sent.push(String(params.text));
          return { message_id: ++next };
        }
        if (
          method === "editMessageReplyMarkup" &&
          typeof params.message_id === "number"
        )
          cleared.push(params.message_id);
        return true;
      },
    },
  });
  t.after(() => surface.close());
  const receipt = (turn: number) =>
    historicalReceipt(data.get(`console:run:s:${turn}`));
  return {
    surface,
    data,
    sent,
    cleared,
    receipt,
    get scans() {
      return scans;
    },
  };
}

function pendingReceipt(turn: number): RunReceipt {
  return {
    id: "s",
    draftId: turn + 1,
    chatId: 1,
    threadId: 2,
    messageId: 200 + turn,
  };
}

test("unfinished legacy receipt upgrades without losing message IDs or ambiguous-send guards", async (t) => {
  const f = fixture(t);
  f.data.set("console:run:s:1", { messageId: 7, logMessageIds: [8] });
  await f.surface.onRun("s", completedView(1));
  assert.equal(f.receipt(1)?.messageId, 7);
  assert.ok(f.receipt(1)?.sealedLogMessageIds?.includes(8));
  assert.equal(f.receipt(1)?.final, true);
  f.data.set("console:run:s:2", {
    messageId: 9,
    outputs: [
      { id: "output:2", hash: "hash", messageIds: [10], pending: true },
    ],
  });
  await assert.rejects(
    f.surface.onRun("s", completedView(2)),
    /ambiguous; automatic resend suppressed/,
  );
  assert.equal(f.receipt(2)?.outputs?.[0]?.pending, true);
  assert.deepEqual(f.sent, ["answer 1"]);
});

const completedView = (turn: number) => ({
  turn,
  final: true,
  outputs: [{ id: `output:${turn}`, text: `answer ${turn}` }],
});

test("historical replay sweep preserves multiple newer pending receipts until their outputs are replayed", async (t) => {
  const f = fixture(t);
  f.data.set("console:run:s:0", pendingReceipt(0));
  f.data.set("console:run:s:2", pendingReceipt(2));
  f.data.set("console:run:s:3", pendingReceipt(3));
  f.data.set("console:run:s:legacy", { final: true, messageId: 777 });

  await f.surface.onRun("s", completedView(1));
  assert.equal(f.receipt(0)?.superseded, true);
  assert.equal(f.receipt(2)?.superseded, undefined);
  assert.equal(f.receipt(3)?.superseded, undefined);
  assert.ok(f.cleared.includes(777), "legacy toolbar cleanup still runs");
  assert.ok(
    !f.cleared.includes(202),
    "newer receipt toolbar must not be swept",
  );
  assert.ok(
    !f.cleared.includes(203),
    "newer active-turn receipt must not be swept",
  );

  await f.surface.onRun("s", completedView(2));
  await f.surface.onRun("s", completedView(3));
  assert.deepEqual(f.sent, ["answer 1", "answer 2", "answer 3"]);
  for (const turn of [1, 2, 3]) {
    assert.equal(f.receipt(turn)?.final, true);
    assert.equal(f.receipt(turn)?.outputs?.[0]?.complete, true);
    await f.surface.onRun("s", completedView(turn));
  }
  assert.deepEqual(f.sent, ["answer 1", "answer 2", "answer 3"]);
});

test("replaying an existing older receipt does not supersede the newer active receipt", async (t) => {
  const f = fixture(t);
  f.data.set("console:run:s:1", pendingReceipt(1));
  f.data.set("console:run:s:3", pendingReceipt(3));
  await f.surface.onRun("s", completedView(1));
  assert.equal(f.receipt(3)?.superseded, undefined);
  await f.surface.onRun("s", completedView(3));
  assert.deepEqual(f.sent, ["answer 1", "answer 3"]);
});

test("ambiguous committed output in a newer receipt still rejects after replaying an older turn", async (t) => {
  const f = fixture(t);
  f.data.set("console:run:s:3", {
    ...pendingReceipt(3),
    outputs: [
      { id: "output:3", hash: "hash", messageIds: [303], pending: true },
    ],
  });
  await f.surface.onRun("s", completedView(1));
  await assert.rejects(
    f.surface.onRun("s", completedView(3)),
    /ambiguous; automatic resend suppressed/,
  );
  assert.deepEqual(f.sent, ["answer 1"]);
  assert.equal(f.receipt(3)?.superseded, undefined);
  assert.equal(f.receipt(3)?.outputs?.[0]?.pending, true);
});

test("replaying an older turn does not supersede a newer in-memory active receipt", async (t) => {
  const f = fixture(t);
  await f.surface.onRun("s", { turn: 3 });
  await f.surface.onRun("s", completedView(1));
  assert.equal(f.receipt(3)?.superseded, undefined);
  await f.surface.onRun("s", completedView(3));
  assert.equal(f.sent.filter((text) => text === "answer 3").length, 1);
});

test("migration leaves the current receipt eligible and legacy cleanup runs once", async (t) => {
  const f = fixture(t);
  f.data.set("console:run:s:legacy", { messageId: 777 });
  await f.surface.onRun("s", { turn: 1 });
  const before = f.scans;
  const clearedBefore = f.cleared.filter((id) => id === 777).length;
  await f.surface.onRun("s", { turn: 2 });
  assert.equal(
    f.scans - before,
    1,
    "only latest() topic lookup may scan again",
  );
  assert.equal(f.cleared.filter((id) => id === 777).length, clearedBefore);
  assert.equal(f.receipt(1)?.superseded, true);
  assert.equal(f.receipt(2)?.superseded, undefined);
});
