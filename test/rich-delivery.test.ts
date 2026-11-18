import test from "node:test";
import assert from "node:assert/strict";
import { deliveryFixture } from "./delivery-fixture.js";

const markdown =
  "# Heading\n\n*italic* **bold** ~~strike~~ ||spoiler||\n\n- one\n- [x] task\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> quote\n\n$$x^2$$";
test("Markdown uses native rich drafts, persisted sends and preserved final controls", async (t) => {
  const f = deliveryFixture(t);
  await f.console.onRun("s", { turn: 1, partialAnswer: markdown });
  const draft = f.calls.find((call) => call.method === "sendRichMessageDraft");
  assert.equal(draft?.params.rich_message?.markdown, markdown);
  assert.equal(draft?.params.can_stop, true);
  const outputs = [{ id: "answer", text: markdown }];
  await f.console.onRun("s", { turn: 1, outputs, final: true });
  await f.console.onRun("s", { turn: 1, outputs, final: true });
  const sends = f.calls.filter((call) => call.method === "sendRichMessage");
  assert.equal(sends.length, 1);
  assert.equal(sends[0]?.params.rich_message?.markdown, markdown);
  assert.equal(sends[0]?.params.text, undefined);
  assert.equal(f.record("console:run:s:1").outputs?.[0]?.complete, true);
});
test("unsupported drafts edit rich content in the same placeholder", async (t) => {
  const f = deliveryFixture(t);
  f.console.draftsUnsupported = true;
  await f.console.onRun("s", { turn: 1, partialAnswer: markdown });
  const edit = f.calls.find(
    (call) => call.method === "editMessageText" && call.params.rich_message,
  );
  assert.equal(edit?.params.rich_message?.markdown, markdown);
  assert.equal(edit?.params.message_id, f.record("console:run:s:1").messageId);
});
test("legacy accepted output chunks never switch representation on recovery", async (t) => {
  const f = deliveryFixture(t);
  f.data.set("console:run:s:1", {
    outputs: [{ id: "old", messageIds: [10], complete: true }],
  });
  await f.console.onRun(
    "s",
    { turn: 1, outputs: [{ id: "old", text: markdown }], final: true },
    { replay: true },
  );
  assert.ok(!f.calls.some((call) => call.method === "sendRichMessage"));
});
test("ambiguous rich sends are quarantined without legacy fallback or blind resend", async (t) => {
  const f = deliveryFixture(t);
  const original = f.console.api.call.bind(f.console.api);
  let attempts = 0;
  f.console.api.call = async (method, params) => {
    if (method === "sendRichMessage") {
      attempts++;
      throw new Error("transport disconnected");
    }
    return original(method, params);
  };
  const view = { turn: 1, outputs: [{ id: "answer", text: markdown }] };
  await f.console.onRun("s", view, { replay: true });
  await f.console.onRun("s", { ...view, final: true }, { replay: true });
  assert.equal(attempts, 1);
  assert.equal(
    f.record("console:run:s:1").outputs?.[0]?.quarantine,
    "uncertain",
  );
  assert.ok(
    !f.calls.some(
      (call) =>
        call.method === "sendMessage" && call.params.text?.includes("Heading"),
    ),
  );
});
