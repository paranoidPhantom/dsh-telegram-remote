import assert from "node:assert/strict";
import test from "node:test";
import { FixtureConsole } from "./console-constructor.js";
import { TodoDelivery, todoText } from "../src/delivery/todo-delivery.js";
import {
  foldRun,
  initialRun,
  runProjection,
} from "../src/projection/run-projection.js";
import { createTranslator } from "../src/i18n/bot-i18n.js";
import type {
  TelegramMethod,
  TelegramParams,
  TopicBinding,
  TodoItem,
} from "../src/bot/contracts.js";

const todos: TodoItem[] = [{ content: "Plan <a>& 🐱", status: "in_progress" }];
function fixture() {
  const data = new Map<string, unknown>([
    [
      "console:topic:s",
      { chatId: 1, threadId: 2, cardId: 7, latestControlMessageId: 8 },
    ],
  ]);
  const calls: { method: TelegramMethod; params: TelegramParams }[] = [];
  let pinFailures = 0,
    sendFailures = 0,
    rejectFailures = 0;
  const surface = new FixtureConsole({
    ownerId: 1,
    bridge: {},
    store: {
      get: async (key) => structuredClone(data.get(key)),
      set: async (key, value) => {
        data.set(key, structuredClone(value));
      },
      entries: async () => [...data],
    },
    api: {
      call: async (method, params = {}) => {
        calls.push({ method, params });
        if (method === "sendMessage" && rejectFailures-- > 0)
          throw Object.assign(new Error("rejected"), { code: 429 });
        if (method === "sendMessage" && sendFailures-- > 0)
          throw new Error("transport interrupted");
        if (method === "pinChatMessage") {
          assert.equal(
            (data.get("console:topic:s") as TopicBinding).todoReceipt
              ?.messageId,
            100,
          );
          if (pinFailures-- > 0) throw new Error("pin denied");
        }
        return method === "sendMessage" ? { message_id: 100 } : true;
      },
    },
  });
  const helper = new TodoDelivery(surface);
  return {
    data,
    calls,
    surface,
    helper,
    failPin: () => {
      pinFailures = 1;
    },
    failSend: () => {
      sendFailures = 1;
    },
    rejectSend: () => {
      rejectFailures = 1;
    },
    mapping: () => data.get("console:topic:s") as TopicBinding,
    deliver: async (version = 1, items = todos, turn = 1) =>
      helper.onRun("s", (await surface.mapping("s")) as TopicBinding, {
        turn,
        todos: items,
        todoVersion: version,
      }),
  };
}

test("semantic todo snapshot survives turns; invalid or failed tool arguments do not mutate it", () => {
  const empty = initialRun();
  const state = foldRun(empty, { type: "todo/write", seq: 4, data: { todos } });
  assert.equal(runProjection.stateVersion, 9);
  assert.deepEqual(state.todos, todos);
  assert.equal(state.todoVersion, 4);
  const next = foldRun(state, {
    type: "turn/start",
    time: 5,
    data: { turn: 2 },
  });
  assert.equal(next.todos, state.todos);
  assert.equal(next.todoVersion, 4);
  assert.equal(
    foldRun(next, {
      type: "todo/write",
      seq: 6,
      data: { todos: [{ content: "bad", status: "bogus" }] },
    }),
    next,
  );
  assert.equal(
    foldRun(next, { type: "todo/write", seq: 4, data: { todos: [] } }),
    next,
  );
  const call = foldRun(next, {
    type: "tool/call",
    time: 6,
    data: { callId: "x", name: "todo_write", arguments: { todos: [] } },
  });
  const failed = foldRun(call, {
    type: "tool/result",
    time: 7,
    data: { message: { toolCallId: "x", isError: true } },
  });
  assert.deepEqual(failed.todos, todos);
});

test("first checklist persisted before pin; edits same ID across turns and helper reload; duplicate frames dedupe", async (t) => {
  const f = fixture();
  t.after(() => f.surface.close());
  await f.deliver();
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ["sendMessage", "pinChatMessage"],
  );
  assert.equal(f.calls[0]?.params.parse_mode, "HTML");
  assert.match(String(f.calls[0]?.params.text), /&lt;a&gt;&amp;/);
  assert.equal(f.calls[1]?.params.disable_notification, true);
  assert.equal(f.mapping().cardId, 7);
  assert.equal(f.mapping().latestControlMessageId, 8);
  assert.ok(!f.calls[0]?.params.reply_markup);
  await f.deliver();
  await f.deliver(1, todos, 2);
  assert.equal(f.calls.length, 2);
  const reloaded = new TodoDelivery(f.surface);
  await reloaded.onRun("s", f.mapping(), {
    turn: 2,
    todos: [{ content: "Done", status: "completed" }],
    todoVersion: 9,
  });
  assert.equal(f.calls.at(-1)?.method, "editMessageText");
  assert.equal(f.calls.at(-1)?.params.message_id, 100);
  await f.deliver(10, [], 3);
  assert.match(String(f.calls.at(-1)?.params.text), /No tasks/);
  assert.equal(
    f.calls.filter((call) => call.method === "sendMessage").length,
    1,
  );
  assert.equal(JSON.stringify(f.mapping()).includes("Done"), false);
});

test("pin failure retries pin, not send; ambiguous send marker prevents blind duplicates", async (t) => {
  const f = fixture();
  t.after(() => f.surface.close());
  f.failPin();
  await assert.rejects(f.deliver(), /pin denied/);
  await f.deliver();
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ["sendMessage", "pinChatMessage", "pinChatMessage"],
  );
  const g = fixture();
  t.after(() => g.surface.close());
  g.failSend();
  await assert.rejects(g.deliver(), /transport interrupted/);
  await g.deliver();
  assert.equal(g.calls.length, 1);
  assert.equal(g.mapping().todoReceipt?.pending, true);
});

test("first empty checklist does not send; deleted, moved and closed lifecycle topics are fenced", async (t) => {
  const f = fixture();
  t.after(() => f.surface.close());
  await f.deliver(1, []);
  assert.equal(f.calls.length, 0);
  const old = f.mapping();
  f.data.set("console:topic:s", { ...old, deleted: true });
  await f.helper.onRun("s", old, { turn: 1, todos, todoVersion: 2 });
  f.data.set("console:topic:s", { ...old, chatId: 9, threadId: 3 });
  await f.helper.onRun("s", old, { turn: 1, todos, todoVersion: 2 });
  assert.equal(f.calls.length, 0);
  await f.surface.close();
  await f.helper.onRun("s", old, { turn: 1, todos, todoVersion: 2 });
  assert.equal(f.calls.length, 0);
});

test("definitive send rejection retries and RunDelivery processes todo after a final receipt", async (t) => {
  const f = fixture();
  t.after(() => f.surface.close());
  f.rejectSend();
  await assert.rejects(f.deliver(), /rejected/);
  assert.equal(f.mapping().todoReceipt?.pending, false);
  f.data.set("console:run:s:1", {
    id: "s",
    chatId: 1,
    threadId: 2,
    final: true,
  });
  await f.surface.onRun("s", { turn: 1, final: true, todos, todoVersion: 1 });
  assert.equal(f.mapping().todoReceipt?.messageId, 100);
  assert.equal(f.mapping().todoReceipt?.pinned, true);
  assert.ok(
    f.calls.find(
      (c) =>
        c.method === "sendMessage" &&
        c.params.text?.includes(
          '<tg-emoji emoji-id="5219899949281453881">✅</tg-emoji>',
        ),
    ),
  );
  await f.surface.onRun("s", {
    turn: 1,
    final: true,
    todos: [],
    todoVersion: 2,
  });
  assert.equal(f.calls.at(-1)?.method, "editMessageText");
  assert.match(String(f.calls.at(-1)?.params.text), /No tasks/);
});

test("localized checklist stays escaped, well formed and bounded with omissions and counts", () => {
  for (const locale of ["en", "zh", "ru"] as const) {
    const text = todoText(
      Array.from({ length: 1000 }, (_, index) => ({
        content: "<&>🐱".repeat(500),
        status: index % 2 ? ("completed" as const) : ("pending" as const),
      })),
      createTranslator(() => locale),
    );
    assert.ok(text.length <= 4096, `${locale}: ${text.length}`);
    assert.equal(text.toWellFormed(), text);
    assert.ok(!text.includes("<&>"));
    assert.match(text, /500/);
    assert.match(text, /1000/);
    assert.match(text, /…/);
  }
});
