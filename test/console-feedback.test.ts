import { inlineMarkup, requiredField } from "./console-param-checks.js";
import test from "node:test";
import assert from "node:assert/strict";
import { FixtureConsole as TelegramConsole } from "./console-constructor.js";
import type {
  TelegramMethod,
  TelegramParams,
  ConsoleDocument,
} from "../src/bot/contracts.js";
import { toolLogPages } from "../src/rendering/console-render.js";

import type { TestContext } from "node:test";
import {
  required,
  type ApiCall,
  type ApiParams,
  type Button,
  type Selection,
  type SelectionResult,
  type State,
} from "./console-fixture-types.js";
interface FeedbackState extends State {
  chatId?: number;
  threadId?: number;
  logMessageIds?: number[];
}
interface Tool {
  callId: string;
  name: string;
  summary: string;
  status: string;
  result?: string;
}
function fixture(t: TestContext) {
  const calls: ApiCall[] = [],
    data = new Map<string, FeedbackState>();
  let next = 100;
  const metadata = {
    title: "Session",
    selection: { provider: "p", model: "old" },
  };
  const bridge = {
    async metadata() {
      return structuredClone(metadata);
    },
    async models() {
      return ["p", "other"].flatMap((provider) =>
        Array.from({ length: 10 }, (_, i) => ({
          provider,
          id: i ? `m${i}` : "old",
        })),
      );
    },
    async selectModel(
      id: string,
      selection: Selection,
    ): Promise<SelectionResult> {
      metadata.selection = selection;
      return { ok: true };
    },
  };
  const api = {
    async call(method: TelegramMethod, params: TelegramParams = {}) {
      calls.push({ method, params: params });
      return method === "sendMessage" ? { message_id: ++next } : true;
    },
  };
  const store = {
    async get(key: string) {
      return structuredClone(data.get(key));
    },
    async set(key: string, value: FeedbackState) {
      data.set(key, structuredClone(value));
    },
    async entries() {
      return [...data];
    },
  };
  const console = new TelegramConsole({
    signal: undefined,
    api,
    bridge,
    store,
    ownerId: 1,
  });
  t.after(() => console.close());
  data.set("console:topic:s", { chatId: 1, threadId: 2 });
  const ctx = { chatId: 1, threadId: 2 };
  const buttons = (call: ApiCall | undefined) =>
    inlineMarkup(required(call).params.reply_markup).inline_keyboard.flat();
  const last = () =>
    required(
      calls
        .filter(
          (c) => c.method === "sendMessage" || c.method === "editMessageText",
        )
        .at(-1),
    );
  const click = (button: Button | undefined, messageId = 101) =>
    console.handleUpdate({
      callback_query: {
        id: `q${next++}`,
        from: { id: 1 },
        data: requiredField(required(button).callback_data),
        message: {
          message_id: messageId,
          chat: { id: 1, type: "private" },
          message_thread_id: 2,
        },
      },
    });
  return { console, calls, data, metadata, bridge, ctx, buttons, last, click };
}

test("picker navigation and selections edit one message, page and provider identity retained", async (t) => {
  const f = fixture(t);
  await f.console.providers("s", f.ctx);
  await f.click(f.buttons(f.last()).find((b) => b.text.includes("p")));
  assert.equal(
    requiredField(
      f.buttons(f.last()).find((b) => b.text.includes("old"))!.text,
    ),
    "✓ old",
  );
  await f.click(f.buttons(f.last()).find((b) => b.text.includes("Next")));
  const selected = required(f.buttons(f.last()).find((b) => b.text === "m9"));
  const action = required(
    f.console.actions.get(requiredField(selected.callback_data)),
  );
  assert.equal(action.type, "select");
  assert.ok("page" in action);
  assert.equal(action.page, 1);
  await f.click(selected);
  assert.match(requiredField(f.last().params.text), /page 2/);
  assert.equal(
    requiredField(f.buttons(f.last()).find((b) => b.text.includes("m9"))!.text),
    "✓ m9",
  );
  await f.click(f.buttons(f.last()).find((b) => b.text.includes("Providers")));
  await f.click(f.buttons(f.last()).find((b) => b.text === "other"));
  assert.ok(f.buttons(f.last()).every((b) => !b.text.startsWith("✓")));
  assert.equal(f.calls.filter((c) => c.method === "sendMessage").length, 1);
  assert.ok(
    f.calls
      .filter((c) => c.method === "editMessageText")
      .every((c) => c.params.message_id === 101),
  );
  assert.equal(
    f.calls.filter((c) => c.method === "answerCallbackQuery").length,
    5,
  );
});

test("selection requires ACK and refreshed metadata; failure keeps prior checkmark without new message", async (t) => {
  const f = fixture(t);
  await f.console.models("s", f.ctx, "p");
  f.bridge.selectModel = async () => ({ ok: true });
  await f.click(f.buttons(f.last()).find((b) => b.text === "m1"));
  assert.match(requiredField(f.last().params.text), /has not confirmed/);
  assert.equal(
    requiredField(
      f.buttons(f.last()).find((b) => b.text.includes("old"))!.text,
    ),
    "✓ old",
  );
  assert.equal(f.calls.filter((c) => c.method === "sendMessage").length, 1);
});

test("concurrent selections serialize after prompt callback answers without nested queue deadlock", async (t) => {
  const f = fixture(t);
  await f.console.models("s", f.ctx, "p");
  const rows = f.buttons(f.last());
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const began = new Promise<void>((r) => {
    started = r;
  });
  const order: string[] = [];
  f.bridge.selectModel = async (id, selection) => {
    order.push(selection.model);
    if (selection.model === "m1") {
      started();
      await gate;
    }
    f.metadata.selection = selection;
    return { ok: true };
  };
  const first = f.click(rows.find((b) => b.text === "m1"));
  await began;
  const second = f.click(rows.find((b) => b.text === "m2"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    f.calls.filter((c) => c.method === "answerCallbackQuery").length,
    2,
  );
  assert.deepEqual(order, ["m1"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["m1", "m2"]);
  assert.equal(
    requiredField(f.buttons(f.last()).find((b) => b.text.includes("m2"))!.text),
    "✓ m2",
  );
});

test("ordered durable multi-tool log updates retain final log separate from answer and draft", async (t) => {
  const f = fixture(t);
  const tools: Tool[] = [
    { callId: "a", name: "Read", summary: "source", status: "running" },
    { callId: "b", name: "Test", summary: "unit suite", status: "running" },
  ];
  await f.console.onRun("s", { turn: 1, partialAnswer: "", toolLog: tools });
  const delivery = required(f.data.get("console:run:s:1")),
    logId = delivery.logMessageIds![0]!;
  tools[0]!.status = "completed";
  tools[0]!.result = "<source>";
  tools[1]!.status = "failed";
  tools[1]!.result = "failure";
  tools.push({
    callId: "latest",
    name: "Latest",
    summary: "waiting",
    status: "running",
  });
  await f.console.onRun("s", { turn: 1, partialAnswer: "", toolLog: tools });
  const progress = f.calls
    .filter(
      (c) => c.method === "editMessageText" && c.params.message_id === logId,
    )
    .at(-1)!;
  assert.match(
    requiredField(progress.params.text),
    /<blockquote expandable>Tools.*1\. ✓ Read.*2\. ✗ Test/s,
  );
  assert.ok(!requiredField(progress.params.text).includes("&lt;source&gt;"));
  assert.ok(!f.buttons(progress).some((b) => b.text.includes("Stop")));
  await f.console.onRun("s", {
    turn: 1,
    final: true,
    answer: "done",
    toolLog: tools,
  });
  const finalLog = f.calls
    .filter(
      (c) => c.method === "editMessageText" && c.params.message_id === logId,
    )
    .at(-1)!;
  assert.match(requiredField(finalLog.params.text), /finished/);
  assert.deepEqual(f.buttons(finalLog), []);
  assert.ok(
    !f.calls.some(
      (c) => c.method === "deleteMessage" && c.params.message_id === logId,
    ),
  );
  const drafts = f.calls.filter((c) => c.method === "sendMessageDraft");
  assert.ok(drafts.length > 0);
  assert.deepEqual(
    drafts.map((c) => requiredField(c.params.text)),
    ["🔧 Test — unit suite", "🔧 Latest — waiting"],
  );
  assert.ok(
    drafts.every((c) =>
      requiredField(c.params.entities).some(
        (entity) =>
          entity.type === "custom_emoji" &&
          entity.custom_emoji_id === "5220046725493828505" &&
          entity.offset === 0 &&
          entity.length === 2,
      ),
    ),
  );
  assert.equal(
    f.calls.filter(
      (c) =>
        c.method === "sendMessage" && requiredField(c.params.text) === "done",
    ).length,
    1,
  );
  assert.ok([...f.data.values()].every((value) => !("toolLog" in value)));
});

test("unsupported drafts keep separate answer preview without removing active log Stop", async (t) => {
  const f = fixture(t),
    original = f.console.api.call;
  f.console.api.call = async (
    method: TelegramMethod,
    params: TelegramParams = {},
  ) => {
    if (method === "sendMessageDraft") throw new Error("404 method not found");
    return original(method, params);
  };
  const toolLog = [
    { callId: "a", name: "Read", status: "running" },
    { callId: "latest", name: "Latest", status: "running" },
  ];
  await f.console.onRun("s", { turn: 1, answer: "partial", toolLog });
  const delivery = required(f.data.get("console:run:s:1"));
  assert.notEqual(delivery.messageId, delivery.logMessageIds![0]!);
  assert.equal(
    required(f.data.get("console:topic:s")).latestControlMessageId,
    delivery.logMessageIds![0]!,
  );
  assert.ok(
    !f.calls.some(
      (c) =>
        c.method === "editMessageReplyMarkup" &&
        c.params.message_id === delivery.logMessageIds![0]!,
    ),
  );
  await f.console.onRun("s", {
    turn: 1,
    final: true,
    answer: "done",
    toolLog: toolLog.map((tool) => ({ ...tool, status: "completed" })),
  });
  const log = f.calls
    .filter(
      (c) =>
        c.method === "editMessageText" &&
        c.params.message_id === delivery.logMessageIds![0]!,
    )
    .at(-1)!;
  assert.match(requiredField(log.params.text), /✓ Read/);
  assert.deepEqual(f.buttons(log), []);
  const answer = f.calls
    .filter(
      (c) =>
        c.method === "editMessageText" &&
        c.params.message_id === delivery.messageId,
    )
    .at(-1)!;
  assert.equal(requiredField(answer.params.text), "done");
});

test("latest tool stays in draft until the next tool flushes it and final retains every tool", async (t) => {
  const f = fixture(t);
  const first = {
    callId: "first",
    name: "FirstTool",
    summary: "first action",
    status: "running",
  };
  const second = {
    callId: "second",
    name: "SecondTool",
    summary: "second action",
    status: "running",
  };
  await f.console.onRun("s", { turn: 1, partialAnswer: "", toolLog: [first] });
  assert.deepEqual(
    required(f.data.get("console:run:s:1")).logMessageIds || [],
    [],
  );
  assert.ok(
    !f.calls.some(
      (c) =>
        c.params.parse_mode === "HTML" &&
        requiredField(c.params.text).includes("FirstTool"),
    ),
  );
  const draft = f.calls.filter((c) => c.method === "sendMessageDraft").at(-1)!;
  assert.equal(requiredField(draft.params.text), "🔧 FirstTool — first action");
  assert.deepEqual(requiredField(draft.params.entities), [
    {
      type: "custom_emoji",
      offset: 0,
      length: 2,
      custom_emoji_id: "5220046725493828505",
    },
    { type: "code", offset: 15, length: 12 },
  ]);

  first.status = "completed";
  await f.console.onRun("s", {
    turn: 1,
    partialAnswer: "",
    toolLog: [first, second],
  });
  const logId = required(f.data.get("console:run:s:1")).logMessageIds![0]!;
  const flushed = f.calls
    .filter(
      (c) => c.method === "editMessageText" && c.params.message_id === logId,
    )
    .at(-1)!;
  assert.match(requiredField(flushed.params.text), /✓ FirstTool/);
  assert.ok(!requiredField(flushed.params.text).includes("SecondTool"));
  assert.equal(
    requiredField(
      f.calls.filter((c) => c.method === "sendMessageDraft").at(-1)!.params
        .text,
    ),
    "🔧 SecondTool — second action",
  );

  second.status = "completed";
  await f.console.onRun("s", {
    turn: 1,
    final: true,
    answer: "done",
    toolLog: [first, second],
  });
  const finalLog = f.calls
    .filter(
      (c) => c.method === "editMessageText" && c.params.message_id === logId,
    )
    .at(-1)!;
  assert.match(
    requiredField(finalLog.params.text),
    /1\. ✓ FirstTool.*2\. ✓ SecondTool/s,
  );
  assert.match(requiredField(finalLog.params.text), /finished/);
  assert.deepEqual(f.buttons(finalLog), []);
  assert.equal(
    f.calls.filter(
      (c) =>
        c.method === "sendMessage" && requiredField(c.params.text) === "done",
    ).length,
    1,
  );
  assert.ok(
    !f.calls.some(
      (c) => c.method === "deleteMessage" && c.params.message_id === logId,
    ),
  );
});

test("large escaped logs paginate without dropping earlier tools and persist every page id", async (t) => {
  const f = fixture(t);
  const toolLog = Array.from({ length: 80 }, (_, i) => ({
    callId: `${i}`,
    name: `tool-${i}`,
    status: "completed",
    summary: "<".repeat(200),
    result: "&".repeat(500),
  }));
  const pages = toolLogPages(toolLog);
  assert.ok(pages.length > 1);
  assert.ok(pages.every((page) => page.length <= 4096));
  for (let i = 0; i < toolLog.length; i++)
    assert.equal(pages.join("\n").split(`tool-${i} ·`).length - 1, 1);
  assert.match(pages[0]!, /truncated/);
  await f.console.onRun("s", { turn: 1, toolLog });
  assert.equal(
    required(f.data.get("console:run:s:1")).logMessageIds!.length,
    pages.length,
  );
  await f.console.onRun("s", { turn: 1, final: true, answer: "done", toolLog });
  const ids = required(required(f.data.get("console:run:s:1")).logMessageIds);
  for (const messageId of ids) {
    const edit = f.calls
      .filter(
        (c) =>
          c.method === "editMessageText" && c.params.message_id === messageId,
      )
      .at(-1)!;
    assert.deepEqual(f.buttons(edit), []);
    assert.ok(
      !f.calls.some(
        (c) =>
          c.method === "deleteMessage" && c.params.message_id === messageId,
      ),
    );
  }
});
