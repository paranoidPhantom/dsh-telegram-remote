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
  const restart = () => {
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
    return surface;
  };
  const surface = restart();
  const receipt = (turn: number) =>
    historicalReceipt(data.get(`console:run:s:${turn}`));
  return {
    surface,
    restart,
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
  assert.equal(await f.surface.onRun("s", completedView(2)), "warning");
  const output = f.receipt(2)?.outputs?.[0];
  assert.equal(output?.pending, true);
  assert.equal(output?.quarantine, "uncertain");
  assert.notEqual(output?.complete, true);
  assert.deepEqual(output?.messageIds, [10]);
  assert.equal(
    f.receipt(2)?.final,
    true,
    "processed final is not proof of delivery",
  );
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

test("ambiguous newer output is durably quarantined after fresh helper restart without blocking later outputs, turns, or chats", async (t) => {
  const f = fixture(t);
  f.data.set("console:run:s:3", {
    ...pendingReceipt(3),
    outputs: [
      { id: "output:3", hash: "hash", messageIds: [303], pending: true },
    ],
  });
  await f.surface.onRun("s", completedView(1));
  await f.surface.close();
  const recovered = f.restart();
  const view = {
    ...completedView(3),
    outputs: [
      ...completedView(3).outputs,
      { id: "later-a", text: "Later A" },
      { id: "later-b", text: "Later B" },
    ],
  };
  assert.equal(await recovered.onRun("s", view), "warning");
  assert.deepEqual(f.sent, ["answer 1", "Later A", "Later B"]);
  assert.equal(f.receipt(3)?.superseded, undefined);
  const [uncertain, ...later] = f.receipt(3)?.outputs ?? [];
  assert.equal(uncertain?.pending, true);
  assert.equal(uncertain?.quarantine, "uncertain");
  assert.notEqual(uncertain?.complete, true);
  assert.deepEqual(uncertain?.messageIds, [303]);
  assert.ok(later.every((output) => output.complete));
  assert.equal(f.receipt(3)?.final, true);
  await recovered.close();
  const again = f.restart();
  assert.equal(await again.onRun("s", view), "warning");
  assert.deepEqual(
    f.sent,
    ["answer 1", "Later A", "Later B"],
    "no quarantined resend after another restart",
  );
  assert.deepEqual(f.receipt(3)?.outputs?.[0]?.messageIds, [303]);
  await again.onRun("s", completedView(4));
  f.data.set("console:topic:other", { chatId: 7, threadId: 8 });
  await again.onRun("other", {
    turn: 1,
    final: true,
    outputs: [{ id: "other-output", text: "Other chat" }],
  });
  assert.deepEqual(f.sent, [
    "answer 1",
    "Later A",
    "Later B",
    "answer 4",
    "Other chat",
  ]);
  assert.equal(f.receipt(4)?.outputs?.[0]?.complete, true);
  assert.equal(
    historicalReceipt(f.data.get("console:run:other:1"))?.outputs?.[0]
      ?.complete,
    true,
  );
});

test("malformed legacy receipt warns without rewriting or resending and does not block a valid later turn", async (t) => {
  const f = fixture(t);
  const malformed = {
    messageId: 17,
    outputs: [{ id: "bad", messageIds: "invalid" }],
  };
  f.data.set("console:run:s:1", structuredClone(malformed));
  assert.equal(await f.surface.onRun("s", completedView(1)), "warning");
  assert.deepEqual(f.data.get("console:run:s:1"), malformed);
  assert.deepEqual(f.sent, []);
  await f.surface.onRun("s", completedView(2));
  assert.deepEqual(f.sent, ["answer 2"]);
  assert.deepEqual(f.data.get("console:run:s:1"), malformed);
  assert.equal(f.receipt(2)?.outputs?.[0]?.complete, true);
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
