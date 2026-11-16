import { inlineMarkup, requiredField } from "./console-param-checks.js";
import test from "node:test";
import assert from "node:assert/strict";
import { FixtureConsole as TelegramConsole } from "./console-constructor.js";
import type {
  TelegramMethod,
  TelegramParams,
  ConsoleDocument,
} from "../src/bot/contracts.js";

import {
  required,
  type ApiCall,
  type ApiParams,
  type Bridge,
  type BridgeCall,
  type Session,
  type State,
  type MessageUpdate,
} from "./console-fixture-types.js";

const OWNER = 5491328220;
function fixture() {
  const calls: ApiCall[] = [];
  const documentCalls: ConsoleDocument[] = [];
  const data = new Map<string, State>();
  let messageId = 100;
  let topicId = 20;
  let sessions: Session[] = [
    {
      id: "s1",
      title: "First",
      model: "old",
      activeModel: "old",
      turns: 2,
      context: "10%",
      cwd: "/work",
      running: false,
    },
  ];
  const bridgeCalls: BridgeCall[] = [];
  const bridge: Bridge = {
    async list() {
      bridgeCalls.push(["list"]);
      return sessions;
    },
    async metadata(id) {
      return sessions.find((s) => s.id === id);
    },
    async models() {
      return [{ provider: "p", id: "new", name: "New", description: "hint" }];
    },
    async selectModel(id, selection) {
      bridgeCalls.push(["selectModel", id, selection]);
      return { ok: true, model: selection.model };
    },
    async create() {
      return "s1";
    },
    async newSessionSelection() {
      return { provider: "p", model: "new" };
    },
    async prompt(...args) {
      bridgeCalls.push(["prompt", ...args]);
    },
    async stop(...args) {
      bridgeCalls.push(["stop", ...args]);
    },
    async details() {
      return "trace";
    },
    async files() {
      return [{ name: "a.txt", content: Buffer.from("a") }];
    },
  };
  const api = {
    async call(method: TelegramMethod, params: TelegramParams = {}) {
      calls.push({ method, params: params });
      if (method === "createForumTopic")
        return { message_thread_id: ++topicId };
      if (method === "sendMessage") return { message_id: ++messageId };
      return true;
    },
    async document(args: ConsoleDocument) {
      documentCalls.push(args);
    },
  };
  const controller = new AbortController();
  const console = new TelegramConsole({
    api,
    bridge,
    ownerId: OWNER,
    store: {
      async get(k: string) {
        return data.get(k);
      },
      async set(k: string, v: State) {
        data.set(k, structuredClone(v));
      },
      async entries() {
        return [...data];
      },
    },
    signal: controller.signal,
  });
  const message = (
    text: string | undefined,
    thread = 0,
    id = ++messageId,
    owner = OWNER,
  ): MessageUpdate => ({
    message: {
      message_id: id,
      from: { id: owner },
      chat: { id: OWNER, type: "private" },
      ...(thread ? { message_thread_id: thread } : {}),
      text,
    },
  });
  const callback = (
    token: string | undefined,
    thread = 0,
    owner = OWNER,
    chatId = OWNER,
    id = 999,
  ) => ({
    callback_query: {
      id: `q${messageId++}`,
      from: { id: owner },
      data: token,
      message: {
        message_id: id,
        chat: { id: chatId, type: "private" },
        ...(thread ? { message_thread_id: thread } : {}),
      },
    },
  });
  const lastSend = () =>
    required(calls.filter((c) => c.method === "sendMessage").at(-1));
  const token = (call: ApiCall | undefined, label: string) =>
    inlineMarkup(required(call).params.reply_markup)
      .inline_keyboard.flat()
      .find((b) => b.text.includes(label))?.callback_data;
  const open = async () => {
    await console.handleUpdate(message("/sessions"));
    await console.handleUpdate(callback(token(lastSend(), "First")));
    return required(await console.getTopic("s1")).threadId;
  };
  return {
    console,
    calls,
    data,
    bridge,
    bridgeCalls,
    controller,
    message,
    callback,
    lastSend,
    token,
    open,
    setSessions(s: Session[]) {
      sessions = s;
    },
  };
}

test("rejects non-owner messages and callbacks before bridge access", async (t) => {
  const f = fixture();
  t.after(() => f.console.close());
  await f.console.handleUpdate(f.message("/new", 0, 1, 123));
  await f.console.handleUpdate(f.callback("x", 0, 123));
  assert.equal(f.bridgeCalls.length, 0);
  assert.equal(f.calls.length, 1);
  assert.match(requiredField(f.calls[0]!.params.text), /Not authorized/);
});

test("callback tokens are opaque and bound to owner, chat, and topic", async (t) => {
  const f = fixture();
  t.after(() => f.console.close());
  f.console.draftsUnsupported = true;
  f.setSessions([{ id: "s1", title: "First", model: "old", running: true }]);
  const thread = await f.open();
  const card = f.calls.find(
    (c) =>
      c.method === "sendMessage" &&
      requiredField(c.params.text)?.startsWith("First\n"),
  );
  const stop = required(f.token(card, "Stop"));
  assert.ok(Buffer.byteLength(stop) <= 64);
  assert.notEqual(stop, "s1");
  await f.console.handleUpdate(f.callback(stop, thread + 1));
  await f.console.handleUpdate(f.callback(stop, thread, OWNER, 111));
  assert.equal(f.bridgeCalls.filter((c) => c[0] === "stop").length, 0);
  await f.console.handleUpdate(f.callback(stop, thread));
  assert.equal(f.bridgeCalls.filter((c) => c[0] === "stop").length, 1);
});

test("/sessions reads current bridge list every time and pagination is live", async (t) => {
  const f = fixture();
  t.after(() => f.console.close());
  await f.console.handleUpdate(f.message("/sessions"));
  f.setSessions(
    Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`,
      title: `Live ${i}`,
      model: "m",
    })),
  );
  await f.console.handleUpdate(f.message("/sessions"));
  const next = f.token(f.lastSend(), "Next");
  await f.console.handleUpdate(f.callback(next));
  assert.equal(f.bridgeCalls.filter((c) => c[0] === "list").length, 3);
  const edit = f.calls.filter((c) => c.method === "editMessageText").at(-1)!;
  assert.match(requiredField(edit.params.text), /page 2/);
  assert.ok(
    inlineMarkup(edit.params.reply_markup)
      .inline_keyboard.flat()
      .some((b) => b.text.includes("Live 9")),
  );
});

test("opens a titled topic, pins metadata card, and provides private topic link", async (t) => {
  const f = fixture();
  t.after(() => f.console.close());
  f.console.username = "@ExampleBot";
  await f.console.handleUpdate(f.message("/sessions"));
  await f.console.handleUpdate(f.callback(f.token(f.lastSend(), "First")));
  const thread = required(await f.console.getTopic("s1")).threadId;
  assert.equal(
    f.calls.find((c) => c.method === "createForumTopic")!.params.name,
    "First",
  );
  assert.ok(f.calls.some((c) => c.method === "pinChatMessage"));
  assert.equal(
    inlineMarkup(
      f.calls.filter((c) => c.method === "editMessageText").at(-1)!.params
        .reply_markup,
    ).inline_keyboard[0]![0]!.url,
    `https://t.me/ExampleBot/${thread}`,
  );
  assert.ok(
    !f.calls.some(
      (c) =>
        c.method === "sendMessage" &&
        requiredField(c.params.text)?.startsWith("Open:"),
    ),
  );
  assert.deepEqual(await f.console.getTopic("s1"), {
    chatId: OWNER,
    threadId: thread,
  });
});

test("model failure never installs preference, refresh uses live metadata", async (t) => {
  const f = fixture();
  t.after(() => f.console.close());
  const thread = await f.open();
  f.bridge.selectModel = async () => ({ ok: false, reason: "denied" });
  const card = f.calls.find(
    (c) =>
      c.method === "sendMessage" &&
      requiredField(c.params.text)?.startsWith("First\n"),
  );
  await f.console.handleUpdate(f.callback(f.token(card, "Model"), thread));
  await f.console.handleUpdate(f.callback(f.token(f.lastSend(), "p"), thread));
  await f.console.handleUpdate(
    f.callback(
      f.token(
        f.calls.filter((c) => c.method === "editMessageText").at(-1),
        "New",
      ),
      thread,
    ),
  );
  assert.ok(
    !f.calls.some(
      (c) =>
        c.method === "sendMessage" &&
        /Model unchanged/.test(requiredField(c.params.text)),
    ),
  );
  assert.match(
    requiredField(
      f.calls.filter((c) => c.method === "editMessageText").at(-1)!.params.text,
    ),
    /Model unchanged: denied/,
  );
  for (const [key, value] of f.data) {
    assert.match(key, /^console:(topic|run|controls):/);
    assert.equal(value.model, undefined);
    assert.equal(value.preference, undefined);
  }
});

test("serialized streaming has immediate Stop, native draft, one answer and no receipt", async (t) => {
  const f = fixture();
  t.after(() => f.console.close());
  const thread = await f.open();
  const before = f.calls.length;
  await Promise.all([
    f.console.onRun("s1", { turn: "t1", status: "thinking" }),
    f.console.onRun("s1", { turn: "t1", answer: "partial" }),
    f.console.onRun("s1", {
      turn: "t1",
      final: true,
      answer: "result",
      tools: ["debug"],
      elapsed: 5,
    }),
  ]);
  await f.console.onRun("s1", { turn: "t1", final: true, answer: "duplicate" });
  const calls = f.calls.slice(before),
    sends = calls.filter((c) => c.method === "sendMessage");
  assert.equal(sends.length, 2);
  assert.equal(
    requiredField(sends[0]!.params.text),
    '<tg-emoji emoji-id="5258121851091043775">⏳</tg-emoji>',
  );
  assert.equal(sends[0]!.params.parse_mode, "HTML");
  assert.equal(f.token(sends[0], "Stop"), undefined);
  assert.equal(requiredField(sends[1]!.params.text), "result");
  assert.equal(f.token(sends[1], "Stop"), undefined);
  assert.equal(sends[1]!.params.disable_notification, false);
  const draft = required(
    calls.find(
      (c) =>
        c.method === "sendMessageDraft" &&
        requiredField(c.params.text) === "partial",
    ),
  );
  assert.equal(draft.params.message_thread_id, thread);
  assert.ok(draft.params.draft_id);
  assert.equal(draft.params.can_stop, true);
  assert.ok(!calls.some((c) => c.method === "sendChatAction"));
  assert.ok(
    calls.findIndex((c) => c.method === "deleteMessage") >
      calls.findIndex(
        (c) =>
          c.method === "sendMessage" &&
          requiredField(c.params.text) === "result",
      ),
  );
});

test("unbound prompts never select latest; bound prompts have stable request IDs", async (t) => {
  const f = fixture();
  t.after(() => f.console.close());
  await f.console.handleUpdate(f.message("hello"));
  assert.equal(f.bridgeCalls.filter((c) => c[0] === "prompt").length, 0);
  assert.match(requiredField(f.lastSend().params.text), /create a new topic/);
  const thread = await f.open();
  const update = f.message("work", thread, 900);
  await f.console.handleUpdate(update);
  await f.console.handleUpdate(update);
  assert.deepEqual(
    f.bridgeCalls.filter((c) => c[0] === "prompt"),
    [["prompt", "s1", "work", `telegram:${OWNER}:900`]],
  );
});

test("queued receipt steers exact original request without resubmitting text", async (t) => {
  const f = fixture();
  t.after(() => f.console.close());
  const thread = await f.open();
  f.setSessions([{ id: "s1", title: "First", running: true }]);
  let steered;
  f.bridge.steerQueued = async (...args) => {
    steered = args;
    return { accepted: true };
  };
  await f.console.handleUpdate(f.message("urgent", thread, 7777));
  const receipt = f.lastSend();
  const button = inlineMarkup(
    receipt.params.reply_markup,
  ).inline_keyboard.flat()[0]!;
  assert.equal(button.text, "Steer now");
  assert.equal(button.icon_custom_emoji_id, "5220197908342648622");
  await f.console.handleUpdate(
    f.callback(requiredField(button.callback_data), thread),
  );
  assert.deepEqual(steered, ["s1", `telegram:${OWNER}:7777`]);
  assert.equal(f.bridgeCalls.filter((x) => x[0] === "prompt").length, 1);
  assert.equal(
    requiredField(
      f.calls.filter((x) => x.method === "editMessageText").at(-1)!.params.text,
    ),
    "Steering now.",
  );
});
test("native new topic binds one DSH session without creating another Telegram topic", async (t) => {
  const f = fixture();
  t.after(() => f.console.close());
  let created = 0;
  f.bridge.create = async () => {
    created++;
    return "s1";
  };
  const event = f.message(undefined, 555, 1001);
  event.message.forum_topic_created = { name: "Native topic" };
  await Promise.all([
    f.console.handleUpdate(event),
    f.console.handleUpdate(f.message("first prompt", 555, 1002)),
  ]);
  assert.equal(created, 0);
  await f.console.handleUpdate(
    f.callback(f.token(f.lastSend(), "Confirm"), 555),
  );
  assert.equal(created, 1);
  assert.deepEqual(await f.console.getTopic("s1"), {
    chatId: OWNER,
    threadId: 555,
  });
  assert.equal(
    f.calls.filter((c) => c.method === "createForumTopic").length,
    0,
  );
  assert.equal(f.bridgeCalls.filter((c) => c[0] === "prompt").length, 1);
});
test("first prompt in unknown topic creates a session when creation event is absent", async (t) => {
  const f = fixture();
  t.after(() => f.console.close());
  await f.console.handleUpdate(f.message("hello", 556, 1003));
  assert.equal(await f.console.getTopic("s1"), undefined);
  await f.console.handleUpdate(
    f.callback(f.token(f.lastSend(), "Confirm"), 556),
  );
  assert.equal(required(await f.console.getTopic("s1")).threadId, 556);
  assert.equal(f.bridgeCalls.filter((c) => c[0] === "prompt").length, 1);
});
test("expired callback regenerates picker without mutating DSH", async (t) => {
  const f = fixture();
  t.after(() => f.console.close());
  const thread = await f.open();
  const card = f.calls.find(
    (c) =>
      c.method === "sendMessage" &&
      requiredField(c.params.text)?.startsWith("First\n"),
  );
  const stop = required(f.token(card, "Model"));
  required(f.console.actions.get(stop)).expires = 0;
  await f.console.handleUpdate(f.callback(stop, thread));
  assert.equal(f.bridgeCalls.filter((c) => c[0] === "stop").length, 0);
  assert.match(
    requiredField(
      f.calls
        .filter((c) => ["sendMessage", "editMessageText"].includes(c.method))
        .at(-1)!.params.text,
    ),
    /Choose provider/,
  );
});

test("approval allows once only and abort cleans pending decisions", async (t) => {
  const f = fixture();
  t.after(() => f.console.close());
  const thread = await f.open();
  let sentResolve!: () => void;
  const sent = new Promise<void>((r) => {
    sentResolve = r;
  });
  const original = f.console.api.call;
  f.console.api.call = async (
    method: TelegramMethod,
    params: TelegramParams = {},
  ) => {
    const result = await original(method, params);
    if (
      method === "sendMessage" &&
      requiredField(params.text)?.includes("Approval required")
    )
      sentResolve();
    return result;
  };
  const decision = f.console.approval("s1", {
    title: "Run command",
    command: "npm run build && echo <done>",
    reason: "Build the updated plugin",
  });
  await sent;
  const card = f.lastSend();
  assert.equal(card.params.disable_notification, false);
  const buttons = inlineMarkup(card.params.reply_markup).inline_keyboard.flat();
  assert.equal(buttons.find((b) => b.text === "Allow once")?.style, "success");
  assert.equal(buttons.find((b) => b.text === "Deny")?.style, "danger");
  assert.equal(
    inlineMarkup(card.params.reply_markup)
      .inline_keyboard.flat()
      .some((b) => /Always/.test(b.text)),
    false,
  );
  await f.console.handleUpdate(f.callback(f.token(card, "Allow once"), thread));
  assert.equal(await decision, "allowed-once");
  const settled = required(
    f.calls
      .filter(
        (c) =>
          c.method === "editMessageText" &&
          c.params.text?.includes("Approval: Allowed once"),
      )
      .at(-1),
  );
  assert.equal(settled.params.parse_mode, "HTML");
  assert.match(
    requiredField(settled.params.text),
    /npm run build &amp;&amp; echo &lt;done&gt;/,
  );
  assert.match(requiredField(settled.params.text), /Build the updated plugin/);
  assert.doesNotMatch(requiredField(settled.params.text), /Approval required/);
  assert.deepEqual(
    inlineMarkup(settled.params.reply_markup).inline_keyboard,
    [],
  );
  const second = f.console.approval("s1", { title: "Another" });
  f.controller.abort();
  assert.equal(await second, "cancelled");
  assert.equal(f.console.actions.size, 0);
  assert.equal(f.console.pending.size, 0);
});

test("deleted Telegram topic is recreated only on explicit opening", async (t) => {
  const f = fixture();
  t.after(() => f.console.close());
  const old = await f.open();
  const call = f.console.api.call;
  f.console.api.call = async (
    method: TelegramMethod,
    params: TelegramParams = {},
  ) => {
    if (
      method === "editMessageText" &&
      requiredField(params.text)?.startsWith("First\n")
    )
      throw new Error("message thread not found");
    return call(method, params);
  };
  await f.console.refresh("s1");
  assert.equal(await f.console.getTopic("s1"), undefined);
  await f.console.handleUpdate(f.message("not implicit", old));
  assert.equal(
    f.calls.filter((c) => c.method === "createForumTopic").length,
    1,
  );
  f.console.api.call = call;
  await f.console.open("s1", { chatId: OWNER, threadId: 0 });
  assert.notEqual(required(await f.console.getTopic("s1")).threadId, old);
});

test("compact card and /status omit raw counters, duplicate model, directory and Refresh", async (t) => {
  const f = fixture();
  t.after(() => f.console.close());
  f.setSessions([
    {
      id: "s1",
      title: "First",
      model: { model: "m" },
      activeModel: { model: "m" },
      context: { percent: 23.456 },
      cwd: "/secret",
      turns: 82,
      lastActivity: 123,
    },
  ]);
  const thread = await f.open();
  await f.console.handleUpdate(f.message("/status", thread));
  const status = f.lastSend();
  assert.equal(
    requiredField(status.params.text),
    "First\nModel: m\nIdle\nContext: 23.5%",
  );
  assert.equal(f.token(status, "Refresh"), undefined);
  assert.equal(f.token(status, "Stop"), undefined);
  assert.equal(f.token(status, "Details"), undefined);
  const initialCard = required(
    f.calls.find(
      (c) => c.method === "sendMessage" && c.params.text?.startsWith("First\n"),
    ),
  );
  assert.equal(initialCard.params.parse_mode, "HTML");
  assert.match(
    requiredField(initialCard.params.text),
    /<blockquote expandable>Directory: \/secret\n\ntrace/,
  );
  assert.equal(f.token(initialCard, "Details"), undefined);
  const pinned = required(f.calls.find((c) => c.method === "pinChatMessage"));
  assert.ok(pinned.params.message_id);
});

test("custom Stop is fallback-only and only active, including model pickers", async (t) => {
  const f = fixture();
  t.after(() => f.console.close());
  f.console.draftsUnsupported = true;
  const thread = await f.open();
  await f.console.providers("s1", { chatId: OWNER, threadId: thread });
  assert.equal(f.token(f.lastSend(), "Stop"), undefined);
  await f.console.onRun("s1", { turn: 1 });
  await f.console.providers("s1", { chatId: OWNER, threadId: thread });
  assert.ok(f.token(f.lastSend(), "Stop"));
  await f.console.models("s1", { chatId: OWNER, threadId: thread }, "p");
  assert.ok(f.token(f.lastSend(), "Stop"));
  await f.console.onRun("s1", { turn: 1, final: true, answer: "answer" });
  await f.console.providers("s1", { chatId: OWNER, threadId: thread });
  assert.equal(f.token(f.lastSend(), "Stop"), undefined);
  await f.console.handleUpdate(f.message("/stop", thread));
  assert.equal(f.bridgeCalls.filter((c) => c[0] === "stop").length, 0);
});

test("latest controls teleport and new turn clears legacy controls without editing old answers", async (t) => {
  const f = fixture();
  t.after(() => f.console.close());
  const thread = await f.open();
  f.data.set("console:run:s1:legacy", { messageId: 777, final: true });
  await f.console.onRun("s1", { turn: 1, final: true, answer: "old answer" });
  const oldFinal = f.data.get("console:run:s1:1")!.finalMessageIds![0]!;
  await f.console.onRun("s1", { turn: 2 });
  assert.ok(
    f.calls.some(
      (c) =>
        c.method === "editMessageReplyMarkup" && c.params.message_id === 777,
    ),
  );
  assert.ok(
    f.calls.some(
      (c) =>
        c.method === "editMessageReplyMarkup" &&
        c.params.message_id === oldFinal,
    ),
  );
  assert.ok(
    !f.calls.some(
      (c) => c.method === "editMessageText" && c.params.message_id === oldFinal,
    ),
  );
  assert.equal(
    f.data.get("console:topic:s1")!.latestControlMessageId,
    f.data.get("console:run:s1:2")!.messageId,
  );
  const stop = f.token(f.lastSend(), "Stop");
  await f.console.refresh("s1");
  const card = f.calls.filter((c) => c.method === "editMessageText").at(-1)!;
  assert.deepEqual(inlineMarkup(card.params.reply_markup).inline_keyboard, []);
  assert.equal(stop, undefined);
});

test("session listing creates no topics and opening creates only the tapped topic", async (t) => {
  const f = fixture();
  t.after(() => f.console.close());
  f.console.username = "Bot";
  f.setSessions(
    Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      title: `Session ${i}`,
      model: "m",
    })),
  );
  await f.console.handleUpdate(f.message("/sessions"));
  assert.equal(
    f.calls.filter((c) => c.method === "createForumTopic").length,
    0,
  );
  const rows = inlineMarkup(f.lastSend().params.reply_markup).inline_keyboard;
  assert.ok(
    rows
      .slice(0, 8)
      .every((row) => requiredField(row[0]!.callback_data) && !row[0]!.url),
  );
  await f.console.handleUpdate(
    f.callback(requiredField(rows[1]![0]!.callback_data)),
  );
  assert.equal(
    f.calls.filter((c) => c.method === "createForumTopic").length,
    1,
  );
  assert.ok(
    inlineMarkup(
      f.calls.filter((c) => c.method === "editMessageText").at(-1)!.params
        .reply_markup,
    ).inline_keyboard[0]![0]!.url,
  );
  await f.console.handleUpdate(f.message("/sessions"));
  assert.equal(
    f.calls.filter((c) => c.method === "createForumTopic").length,
    1,
  );
  assert.ok(
    inlineMarkup(f.lastSend().params.reply_markup)
      .inline_keyboard.slice(0, 8)
      .every((row) => requiredField(row[0]!.callback_data) && !row[0]!.url),
  );
  assert.ok(
    !f.calls.some(
      (c) =>
        c.method === "sendMessage" &&
        /^Open:/.test(requiredField(c.params.text)),
    ),
  );
});

test("unsupported draft edits same placeholder; transient draft error does not disable drafts", async (t) => {
  const f = fixture();
  t.after(() => f.console.close());
  await f.open();
  const original = f.console.api.call;
  f.console.api.call = async (
    method: TelegramMethod,
    params: TelegramParams = {},
  ) => {
    if (method === "sendMessageDraft") throw new Error("404 method not found");
    return original(method, params);
  };
  await f.console.onRun("s1", { turn: 1, answer: "partial" });
  const placeholder = f.data.get("console:run:s1:1")!.messageId;
  await f.console.onRun("s1", { turn: 1, answer: "final answer", final: true });
  assert.equal(
    f.calls.filter((c) => c.method === "editMessageText").at(-1)!.params
      .message_id,
    placeholder,
  );
  assert.equal(
    requiredField(
      f.calls.filter((c) => c.method === "editMessageText").at(-1)!.params.text,
    ),
    "final answer",
  );
  assert.ok(
    !f.calls.some(
      (c) =>
        c.method === "deleteMessage" && c.params.message_id === placeholder,
    ),
  );
});

test("long final chunks preserve all UTF16 text and controls only on last chunk", async (t) => {
  const f = fixture();
  t.after(() => f.console.close());
  await f.open();
  const answer = "a".repeat(4095) + "😀<&>" + "b".repeat(8000);
  const before = f.calls.length;
  await f.console.onRun("s1", { turn: 1, answer, final: true });
  const sends = f.calls.slice(before).filter((c) => c.method === "sendMessage");
  assert.equal(sends.map((c) => requiredField(c.params.text)).join(""), answer);
  assert.ok(
    sends.every(
      (c) =>
        requiredField(c.params.text).length <= 4096 &&
        !/[\uD800-\uDBFF]$/.test(requiredField(c.params.text)),
    ),
  );
  assert.ok(sends.slice(0, -1).every((c) => !c.params.reply_markup));
  assert.ok(sends.at(-1)!.params.reply_markup);
});

test("failed final send keeps placeholder and older answer, retry sends answer once", async (t) => {
  const f = fixture();
  t.after(() => f.console.close());
  await f.open();
  await f.console.onRun("s1", {
    turn: "old",
    final: true,
    answer: "old answer",
  });
  await f.console.onRun("s1", { turn: "new" });
  const original = f.console.api.call;
  f.console.api.call = async (
    method: TelegramMethod,
    params: TelegramParams = {},
  ) => {
    if (method === "sendMessage" && requiredField(params.text) === "new answer")
      throw new Error("network");
    return original(method, params);
  };
  await assert.rejects(
    f.console.onRun("s1", { turn: "new", final: true, answer: "new answer" }),
    /network/,
  );
  assert.ok(!f.calls.some((c) => c.method === "deleteMessage"));
  f.console.api.call = original;
  await f.console.onRun("s1", {
    turn: "new",
    final: true,
    answer: "new answer",
  });
  await f.console.onRun("s1", {
    turn: "new",
    final: true,
    answer: "new answer",
  });
  assert.equal(
    f.calls.filter(
      (c) =>
        c.method === "sendMessage" &&
        requiredField(c.params.text) === "new answer",
    ).length,
    1,
  );
});

test("unanswered approval buttons survive control movement and clean up on answer", async (t) => {
  const f = fixture();
  t.after(() => f.console.close());
  const thread = await f.open();
  let ready!: () => void;
  const sent = new Promise<void>((r) => {
    ready = r;
  });
  const original = f.console.api.call;
  f.console.api.call = async (
    method: TelegramMethod,
    params: TelegramParams = {},
  ) => {
    const result = await original(method, params);
    if (
      method === "sendMessage" &&
      requiredField(params.text)?.includes("Approval required")
    )
      ready();
    return result;
  };
  const decision = f.console.approval("s1", { title: "Run" });
  await sent;
  await f.console.serial("s1", async () => {});
  const approval = f.lastSend();
  const approvalId = [...f.console.pending][0]!.messageId;
  await f.console.onRun("s1", { turn: 1 });
  assert.ok(
    !f.calls.some(
      (c) =>
        c.method === "editMessageReplyMarkup" &&
        c.params.message_id === approvalId,
    ),
  );
  await f.console.handleUpdate(
    f.callback(f.token(approval, "Allow once"), thread),
  );
  assert.equal(await decision, "allowed-once");
});

test("native draft stop is owner/topic/draft bound; quiet heartbeat renews draft", async (t) => {
  const f = fixture();
  t.after(() => f.console.close());
  const thread = await f.open();
  await f.console.onRun("s1", { turn: 1 });
  const draftId = f.data.get("console:run:s1:1")!.draftId!;
  await f.console.refreshDrafts();
  assert.equal(
    f.calls.filter((c) => c.method === "sendMessageDraft").length,
    2,
  );
  for (const [chat, topic, draft] of [
    [123, thread, draftId],
    [OWNER, thread + 1, draftId],
    [OWNER, thread, draftId + 1],
  ] as const) {
    await f.console.handleUpdate({
      stopped_message_generation: {
        chat: { id: chat, type: "private" },
        message_thread_id: topic,
        draft_id: draft,
      },
    });
  }
  assert.equal(f.bridgeCalls.filter((c) => c[0] === "stop").length, 0);
  await f.console.handleUpdate({
    stopped_message_generation: {
      chat: { id: OWNER, type: "private" },
      message_thread_id: thread,
      draft_id: draftId,
    },
  });
  assert.equal(f.bridgeCalls.filter((c) => c[0] === "stop").length, 1);
});
