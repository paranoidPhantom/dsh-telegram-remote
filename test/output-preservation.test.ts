import test from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  deliveryFixture,
  outputReceipts,
  replyMarkup,
  type DeliveryView,
} from "./delivery-fixture.js";

function fixture(t: TestContext) {
  const f = deliveryFixture(t, { cardId: 99 });
  const run = (view: Omit<DeliveryView, "turn">) =>
    f.surface.onRun("s", {
      turn: 1,
      answer: "",
      partialAnswer: "",
      outputs: [],
      ...view,
    });
  const texts = () =>
    f.calls
      .filter(
        (x) =>
          ["sendMessage", "sendRichMessage"].includes(x.method) &&
          !x.params.text?.includes('emoji-id="5294363352070367389"'),
      )
      .map((x) => x.params.rich_message?.markdown ?? x.params.text);
  return { ...f, run, texts };
}

test("empty real placeholder is one custom emoji while native draft stays textual", async (t) => {
  const f = fixture(t);
  await f.run({});
  const message = f.calls.find((c) => c.method === "sendMessage");
  assert.ok(message);
  assert.equal(
    message.params.text,
    '<tg-emoji emoji-id="5294363352070367389">⏳</tg-emoji>',
  );
  assert.equal(message.params.parse_mode, "HTML");
  const draft = f.calls.find((c) => c.method === "sendMessageDraft");
  assert.equal(draft?.params.text, "Deep diving");
  assert.deepEqual(draft?.params.entities, []);
  f.surface.draftsUnsupported = true;
  await f.run({});
  const edit = f.calls.filter((c) => c.method === "editMessageText").at(-1);
  assert.equal(edit?.params.text, message.params.text);
  assert.equal(edit?.params.parse_mode, "HTML");
  await f.run({ partialAnswer: "<plain answer>" });
  const answer = f.calls.filter((c) => c.method === "editMessageText").at(-1);
  assert.equal(answer?.params.rich_message?.markdown, "&lt;plain answer&gt;");
  assert.equal(answer?.params.parse_mode, undefined);
});

test("interstitial committed messages publish immediately, format, and dedupe frames/final", async (t) => {
  const f = fixture(t);
  const first = { id: "a", text: "**First** `step`" };
  await f.run({ outputs: [first], answer: first.text });
  assert.deepEqual(f.texts(), [first.text]);
  const firstCall = f.calls.find(
    (x) => x.params.rich_message?.markdown === first.text,
  );
  assert.equal(firstCall?.method, "sendRichMessage");
  assert.equal(firstCall?.params.entities, undefined);
  await f.run({
    outputs: [first],
    answer: first.text,
    toolLog: [{ callId: "c", name: "tool", status: "running" }],
  });
  const second = { id: "b", text: "Second answer" };
  await f.run({ outputs: [first, second], answer: second.text });
  await f.run({
    outputs: [first, second],
    answer: second.text,
    final: true,
    status: "done",
  });
  await f.run({ outputs: [first, second], final: true });
  assert.equal(f.texts().filter((x) => x === first.text).length, 1);
  assert.equal(f.texts().filter((x) => x === second.text).length, 1);
  const lastOutput = outputReceipts(f.record("console:run:s:1")).at(-1);
  assert.ok(lastOutput);
  const delivered = lastOutput.messageIds.at(-1);
  const toolbar = f.calls
    .filter(
      (x) =>
        x.method === "editMessageReplyMarkup" &&
        x.params?.message_id === delivered,
    )
    .at(-1);
  assert.ok(toolbar);
  assert.ok(
    replyMarkup(toolbar)
      .inline_keyboard.flat()
      .some((button) => button.text === "Model"),
  );
  assert.ok(
    replyMarkup(toolbar)
      .inline_keyboard.flat()
      .some((button) => button.text === "End topic"),
  );
  const stored = JSON.stringify(f.data.get("console:run:s:1"));
  assert.ok(!stored.includes("First") && !stored.includes("Second answer"));
  assert.deepEqual(
    outputReceipts(f.record("console:run:s:1")).map((x) => x.id),
    ["a", "b"],
  );
  const drafts = f.calls.filter((x) => x.method === "sendMessageDraft");
  assert.ok(drafts.some((x) => x.params.text === "Deep diving"));
  const toolDraft = drafts.find((x) => x.params.text === "🔩 Tool");
  assert.ok(toolDraft);
  assert.deepEqual(toolDraft.params.entities, [
    {
      type: "custom_emoji",
      offset: 0,
      length: 2,
      custom_emoji_id: "5260249805522744465",
    },
  ]);
  assert.ok(
    drafts.every(
      (x) => x.params.text === "Deep diving" || x.params.text === "🔩 Tool",
    ),
  );
});

test("stop preserves previous outputs and publishes distinct current partial attempt", async (t) => {
  const f = fixture(t);
  const outputs = [{ id: "a", text: "Earlier message" }];
  await f.run({
    outputs,
    answer: "Earlier message",
    partialAnswer: "New partial",
    partialId: "attempt-2",
  });
  await f.run({
    outputs,
    answer: "Earlier message",
    partialAnswer: "New partial",
    partialId: "attempt-2",
    final: true,
    status: "stopped",
  });
  assert.deepEqual(f.texts(), ["Earlier message", "New partial"]);
  assert.equal(outputReceipts(f.record("console:run:s:1")).length, 2);
});

test("stop matching last output or empty partial does not duplicate or add status noise", async (t) => {
  for (const partialAnswer of ["", "Same"]) {
    const f = fixture(t);
    const outputs = [
      { id: "a", text: "Same" },
      { id: "empty", text: "" },
    ];
    await f.run({ outputs });
    await f.run({ outputs, partialAnswer, final: true, status: "stopped" });
    assert.deepEqual(f.texts(), ["Same"]);
  }
});

test("cleanup and log failures never swallow durable output or final answer", async (t) => {
  const f = fixture(t);
  const original = f.api.call;
  f.api.call = async (method, params = {}) => {
    if (
      method === "editMessageReplyMarkup" ||
      method === "deleteMessage" ||
      (params.parse_mode === "HTML" && params.text?.includes("<blockquote"))
    )
      throw Error("cosmetic failure");
    return original(method, params);
  };
  await f.run({
    outputs: [{ id: "a", text: "Committed" }],
    toolLog: [{ callId: "c", name: "tool", status: "running" }],
  });
  await f.run({
    outputs: [{ id: "a", text: "Committed" }],
    partialAnswer: "Preserved partial",
    final: true,
    status: "stopped",
  });
  assert.deepEqual(f.texts(), ["Committed", "Preserved partial"]);
  await f.surface.onRun("s", { turn: 2, answer: "Legacy final", final: true });
  assert.equal(f.texts().at(-1), "Legacy final");
  const finalMessageIds = f.record("console:run:s:2").finalMessageIds;
  assert.ok(finalMessageIds);
  assert.equal(finalMessageIds.length, 1);
});

test("partial send failure preserves accepted chunk IDs and never ambiguously resends", async (t) => {
  const f = fixture(t);
  const original = f.api.call;
  let attempts = 0;
  f.api.call = async (method, params = {}) => {
    if (
      method === "sendMessage" &&
      !params.text?.includes('emoji-id="5294363352070367389"') &&
      ++attempts === 2
    )
      throw Error("ambiguous network failure");
    return original(method, params);
  };
  const outputs = [{ id: "long", text: "A".repeat(5000) }];
  assert.equal(await f.run({ outputs }), "warning");
  const firstReceipt = outputReceipts(f.record("console:run:s:1"))[0];
  assert.ok(firstReceipt);
  const ids = [...firstReceipt.messageIds];
  assert.equal(ids.length, 1);
  assert.equal(firstReceipt.quarantine, "uncertain");
  assert.notEqual(firstReceipt.complete, true);
  const later = [
    { id: "later-1", text: "Later committed output" },
    { id: "later-2", text: "Last committed output" },
  ];
  assert.equal(
    await f.run({ outputs: [...outputs, ...later], final: true }),
    "warning",
  );
  assert.equal(attempts, 4, "only the two later outputs are sent");
  const preservedReceipt = outputReceipts(f.record("console:run:s:1"))[0];
  assert.ok(preservedReceipt);
  assert.deepEqual(preservedReceipt.messageIds, ids);
  assert.equal(preservedReceipt.quarantine, "uncertain");
  assert.notEqual(preservedReceipt.complete, true);
  assert.equal(
    f.record("console:run:s:1").final,
    true,
    "final means processed, not delivered",
  );
  assert.ok(
    outputReceipts(f.record("console:run:s:1"))
      .slice(1)
      .every((r) => r.complete),
  );
  assert.deepEqual(
    f.texts().slice(-2),
    later.map((output) => output.text),
  );
  assert.equal(
    await f.run({ outputs: [...outputs, ...later], final: true }),
    "warning",
  );
  assert.equal(
    attempts,
    4,
    "quarantined and completed outputs never automatically resend",
  );
  await f.surface.onRun("s", {
    turn: 2,
    outputs: [{ id: "next", text: "Next turn" }],
    final: true,
  });
  assert.equal(f.texts().at(-1), "Next turn");
});

for (const status of [400, 403]) {
  test(`definitive ${status} rejection quarantines only that output and continues`, async (t) => {
    const f = fixture(t);
    const original = f.api.call;
    let attempts = 0;
    f.api.call = async (method, params = {}) => {
      if (method === "sendMessage" && params.text === "Rejected") {
        attempts++;
        throw Object.assign(Error("Telegram rejected send"), {
          code: status,
        });
      }
      return original(method, params);
    };
    const outputs = [
      { id: "bad", text: "Rejected" },
      { id: "good", text: "Delivered" },
    ];
    assert.equal(await f.run({ outputs, final: true }), "warning");
    const [bad, good] = outputReceipts(f.record("console:run:s:1"));
    assert.equal(bad?.quarantine, "rejected");
    assert.notEqual(bad?.complete, true);
    assert.equal(bad?.pending, false);
    assert.deepEqual(bad?.messageIds, []);
    assert.equal(good?.complete, true);
    assert.deepEqual(f.texts(), ["Delivered"]);
    assert.equal(await f.run({ outputs, final: true }), "warning");
    assert.equal(attempts, 1);
  });
}

for (const phase of ["pending", "accepted", "quarantine"] as const) {
  test(`output ${phase} storage failure rejects instead of acknowledging`, async (t) => {
    const f = fixture(t);
    const save = f.store.set;
    f.store.set = async (key, value) => {
      const output = value.outputs?.[0];
      if (
        key === "console:run:s:1" &&
        output &&
        ((phase === "pending" && output.pending && !output.messageIds.length) ||
          (phase === "accepted" && output.messageIds.length > 0) ||
          (phase === "quarantine" && output.quarantine))
      )
        throw Error("receipt storage unavailable");
      return save(key, value);
    };
    if (phase === "quarantine") {
      const call = f.api.call;
      f.api.call = async (method, params = {}) => {
        if (method === "sendMessage" && params.text === "Committed")
          throw Error("ambiguous send");
        return call(method, params);
      };
    }
    await assert.rejects(
      f.run({ outputs: [{ id: "a", text: "Committed" }], final: true }),
      /receipt storage unavailable/,
    );
    assert.notEqual(f.record("console:run:s:1").final, true);
    assert.notEqual(f.record("console:run:s:1").outputs?.[0]?.complete, true);
    if (phase === "pending") assert.ok(!f.texts().includes("Committed"));
  });
}
