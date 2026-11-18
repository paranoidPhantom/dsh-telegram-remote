import test from "node:test";
import assert from "node:assert/strict";
import { toolLogPages } from "../src/rendering/console-render.js";
import {
  deliveryFixture,
  logMessageIds,
  replyMarkup,
  type DeliveryTool,
} from "./delivery-fixture.js";

const fixture = (t: Parameters<typeof deliveryFixture>[0]) =>
  deliveryFixture(t, { ownerId: 1 });

for (const unsupported of [false, true]) {
  test(`replay delivers committed text directly without transient surfaces (fallback=${unsupported})`, async (t) => {
    const f = fixture(t);
    f.console.draftsUnsupported = unsupported;
    const view = {
      turn: 1,
      outputs: [{ id: "first", text: "Saved answer", toolCount: 1 }],
      toolLog: [{ name: "read", summary: "source.ts", status: "completed" }],
    };
    await f.console.onRun("s", view, { replay: true });
    await f.console.refreshDrafts();
    assert.equal(f.console.active.size, 0);
    assert.equal(f.record("console:run:s:1").messageId, undefined);
    assert.ok(
      !f.calls.some((call) =>
        ["sendMessageDraft", "sendChatAction", "deleteMessage"].includes(
          call.method,
        ),
      ),
    );
    const sends = f.calls.filter((call) => call.method === "sendMessage");
    assert.equal(sends.length, 2); // sealed log, then the saved answer
    assert.equal(sends[1]?.params.text, "Saved answer");
    const before = sends.length;
    await f.console.onRun("s", { ...view, final: true }, { replay: true });
    assert.equal(
      f.calls.filter((call) => call.method === "sendMessage").length,
      before,
    );
    assert.equal(f.record("console:run:s:1").final, true);
  });
}

test("an unfinished replay resumes drafts only on a live snapshot", async (t) => {
  const f = fixture(t);
  const view = { turn: 1, outputs: [{ id: "first", text: "Saved answer" }] };
  await f.console.onRun("s", view, { replay: true });
  assert.ok(!f.calls.some((call) => call.method === "sendMessageDraft"));
  await f.console.onRun("s", { ...view, partialAnswer: "Live continuation" });
  assert.equal(f.console.active.size, 1);
  assert.ok(
    f.calls.some(
      (call) =>
        call.method === "sendMessageDraft" &&
        call.params.text === "Live continuation",
    ),
  );
});

test("unchanged frames do not edit pages or regenerate callback tokens; native draft needs no typing", async (t) => {
  const f = fixture(t),
    view = {
      turn: 1,
      partialAnswer: "answer",
      toolLog: [{ name: "read", summary: "source", status: "running" }],
    };
  await f.console.onRun("s", view);
  const before = f.calls.length,
    tokens = f.console.actions.size;
  for (let i = 0; i < 5; i++) await f.console.onRun("s", view);
  assert.equal(
    f.calls.slice(before).filter((c) => c.method === "editMessageText").length,
    0,
  );
  assert.equal(f.console.actions.size, tokens);
  assert.equal(f.calls.filter((c) => c.method === "sendChatAction").length, 0);
  assert.ok(
    f.calls
      .filter((c) => c.method === "sendMessageDraft")
      .every((c) => c.params.can_stop),
  );
});

test("long log last-row update edits only its last page", async (t) => {
  const f = fixture(t);
  const tools: DeliveryTool[] = Array.from({ length: 80 }, (_, i) => ({
    name: `tool-${i}`,
    summary: "x".repeat(150),
    status: "completed",
  }));
  const lastLoggedTool = tools.at(-1);
  assert.ok(lastLoggedTool);
  lastLoggedTool.status = "running";
  assert.ok(toolLogPages(tools).length > 1);
  tools.push({ name: "Latest sentinel", status: "running" });
  await f.console.onRun("s", { turn: 1, toolLog: tools });
  const ids = logMessageIds(f.record("console:run:s:1")),
    before = f.calls.length;
  lastLoggedTool.status = "completed";
  await f.console.onRun("s", { turn: 1, toolLog: tools });
  assert.deepEqual(
    f.calls
      .slice(before)
      .filter((c) => c.method === "editMessageText")
      .map((c) => c.params.message_id),
    [ids.at(-1)],
  );
});

test("slow heartbeat has one pending slot per session and never replays stale view", async (t) => {
  const f = fixture(t);
  await f.console.onRun("s", { turn: 1, partialAnswer: "initial" });
  const original = f.console.api.call.bind(f.console.api);
  let release: () => void = () => assert.fail("Gate not initialized");
  let started: () => void = () => assert.fail("Start signal not initialized");
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    began = new Promise<void>((r) => {
      started = r;
    });
  f.console.api.call = async (method, params) => {
    if (method === "sendMessageDraft") {
      started();
      await gate;
    }
    return original(method, params);
  };
  const before = f.calls.length,
    first = f.console.refreshDrafts();
  await began;
  const pulses = Array.from({ length: 25 }, () => f.console.refreshDrafts());
  assert.equal(f.console.delivery.heartbeats.size, 1);
  release();
  await Promise.all([first, ...pulses]);
  assert.equal(
    f.calls.slice(before).filter((c) => c.method === "sendMessageDraft").length,
    1,
  );
  assert.equal(f.console.delivery.heartbeats.size, 0);
});

test("legacy cleanup scans history once, later turns clear only current controls", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 100; i++)
    f.data.set(`console:run:s:old${i}`, { final: true, messageId: i + 1000 });
  await f.console.onRun("s", { turn: 1 });
  const scans = f.scans,
    before = f.calls.length;
  await f.console.onRun("s", { turn: 2 });
  assert.equal(f.scans - scans, 1); // latest()'s topic lookup, not another history migration.
  assert.ok(
    f.calls
      .slice(before)
      .filter((c) => c.method === "editMessageReplyMarkup")
      .every((c) => {
        assert.ok(c.params.message_id !== undefined);
        return c.params.message_id < 1000;
      }),
  );
  assert.equal(f.record("console:run:s:1").superseded, true);
});

test("ownership changes invalidate controls without rewriting unrelated pages", async (t) => {
  const f = fixture(t),
    view = {
      turn: 1,
      toolLog: [
        { name: "read", status: "running" },
        { name: "Latest sentinel", status: "running" },
      ],
    };
  await f.console.onRun("s", view);
  const id = logMessageIds(f.record("console:run:s:1"))[0];
  await f.console.latest({ chatId: 1, threadId: 2 }, 999);
  const before = f.calls.length;
  await f.console.onRun("s", view);
  const edits = f.calls
    .slice(before)
    .filter((c) => c.method === "editMessageText");
  assert.equal(edits.length, 1);
  const edit = edits[0];
  assert.ok(edit);
  assert.equal(edit.params.message_id, id);
  assert.deepEqual(replyMarkup(edit).inline_keyboard, []);
  assert.equal(f.record("console:topic:s").latestControlMessageId, 999);
});
