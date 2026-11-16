import { inlineMarkup, requiredField } from "./console-param-checks.js";
import test from "node:test";
import assert from "node:assert/strict";
import { FixtureConsole as TelegramConsole } from "./console-constructor.js";
import type {
  TelegramMethod,
  TelegramParams,
  ConsoleDocument,
} from "../src/bot/contracts.js";
import type { TestContext } from "node:test";
import {
  required,
  type ApiCall,
  type ApiParams,
  type Bridge,
  type BridgeCall,
  type State,
} from "./console-fixture-types.js";
const OWNER = 5491328220;
function fixture(t: TestContext) {
  const calls: ApiCall[] = [],
    bridgeCalls: BridgeCall[] = [],
    data = new Map<string, State>();
  let n = 0;
  let sentId = 0;
  const selection = { provider: "p", model: "m", reasoningEffort: "high" };
  const bridge: Bridge = {
    async details() {
      return "";
    },
    async workspaces() {
      return Array.from({ length: 12 }, (_, i) => ({
        id: `w${i}`,
        title: `Project ${i}`,
        path: `/workspace/${i}`,
      }));
    },
    async newSessionSelection(source) {
      bridgeCalls.push(["selection", source]);
      return selection;
    },
    async create(workspaceId) {
      bridgeCalls.push(["create", workspaceId]);
      return "new";
    },
    async selectModel(...args) {
      bridgeCalls.push(["select", ...args]);
      return { ok: true };
    },
    async metadata(id) {
      return { id, title: "Session", selection, running: true };
    },
    async prompt(...args) {
      bridgeCalls.push(["prompt", ...args]);
    },
    async stop() {
      bridgeCalls.push(["stop"]);
    },
    async list() {
      return [];
    },
    async models() {
      return [
        { provider: "p", id: "m" },
        ...Array.from({ length: 12 }, (_, i) => ({
          provider: "q",
          id: `other-${i}`,
        })),
      ];
    },
  };
  const api = {
    async call(method: TelegramMethod, params: TelegramParams = {}) {
      calls.push({ method, params: params });
      return method === "sendMessage"
        ? { message_id: (sentId = ++n) }
        : method === "createForumTopic"
          ? { message_thread_id: 500 }
          : true;
    },
  };
  const c = new TelegramConsole({
    signal: undefined,
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
  });
  c.username = "Bot";
  t.after(() => c.close());
  const msg = (text: string, thread = 0, id = ++n) => ({
    message: {
      from: { id: OWNER },
      chat: { id: OWNER, type: "private" },
      message_id: id,
      message_thread_id: thread,
      text,
    },
  });
  const cb = (
    token: string,
    thread = 0,
    owner = OWNER,
    messageId = sentId,
  ) => ({
    callback_query: {
      id: String(++n),
      from: { id: owner },
      data: token,
      message: {
        chat: { id: OWNER, type: "private" },
        message_thread_id: thread,
        message_id: messageId,
      },
    },
  });
  const last = () =>
    required(
      calls
        .filter(
          (x) => x.method === "sendMessage" || x.method === "editMessageText",
        )
        .at(-1),
    );
  const token = (label: string) =>
    requiredField(
      inlineMarkup(last().params.reply_markup)
        .inline_keyboard.flat()
        .find((b) => b.text.includes(label))!.callback_data,
    );
  return { c, calls, bridgeCalls, data, bridge, api, msg, cb, last, token };
}
test("new-session picker selects reasoning effort and can restore model default", async (t) => {
  const f = fixture(t);
  f.bridge.models = async () => [
    {
      provider: "p",
      id: "m",
      reasoning: {
        efforts: [
          { id: "low", name: "Low" },
          { id: "high", name: "High" },
        ],
        defaultEffort: "low",
      },
    },
  ];
  await f.c.handleUpdate(f.msg("/new"));
  await f.c.handleUpdate(f.cb(f.token("Model")));
  await f.c.handleUpdate(f.cb(f.token("✓ p")));
  await f.c.handleUpdate(f.cb(f.token("Reasoning effort: Low")));
  assert.match(requiredField(f.last().params.text), /m · low/);
  assert.ok(
    inlineMarkup(f.last().params.reply_markup)
      .inline_keyboard.flat()
      .some((b) => b.text === "✓ Reasoning effort: Low"),
  );
  await f.c.handleUpdate(f.cb(f.token("Default")));
  assert.doesNotMatch(requiredField(f.last().params.text), /m · low/);
  assert.equal(f.bridgeCalls.filter((x) => x[0] === "select").length, 0);
  await f.c.handleUpdate(f.cb(f.token("Confirm")));
  assert.deepEqual(
    f.bridgeCalls.find((x) => x[0] === "select"),
    ["select", "new", { provider: "p", model: "m" }],
  );
});

test("/new confirms snapshot exactly once and edits same confirmation with direct URL", async (t) => {
  const f = fixture(t);
  await f.c.handleUpdate(f.msg("/new"));
  assert.equal(f.bridgeCalls.filter((x) => x[0] === "create").length, 0);
  const token = f.token("Confirm");
  await Promise.all([
    f.c.handleUpdate(f.cb(token)),
    f.c.handleUpdate(f.cb(token)),
  ]);
  assert.equal(f.bridgeCalls.filter((x) => x[0] === "create").length, 1);
  assert.deepEqual(
    f.bridgeCalls.find((x) => x[0] === "select"),
    ["select", "new", { provider: "p", model: "m", reasoningEffort: "high" }],
  );
  const edit = f.calls.filter((x) => x.method === "editMessageText").at(-1)!;
  assert.equal(edit.params.message_id, 2);
  assert.equal(
    inlineMarkup(edit.params.reply_markup).inline_keyboard[0]![0]!.url,
    "https://t.me/Bot/500",
  );
});
test("native first prompts queue all request ids until confirm, without another topic", async (t) => {
  const f = fixture(t);
  await f.c.handleUpdate(f.msg("first", 33, 70));
  const token = f.token("Confirm");
  await f.c.handleUpdate(f.msg("second", 33, 71));
  assert.equal(f.bridgeCalls.filter((x) => x[0] === "create").length, 0);
  await f.c.handleUpdate(f.cb(token, 33));
  assert.deepEqual(
    f.bridgeCalls.filter((x) => x[0] === "prompt"),
    [
      ["prompt", "new", "first", `telegram:${OWNER}:70`],
      ["prompt", "new", "second", `telegram:${OWNER}:71`],
    ],
  );
  assert.equal(
    f.calls.filter((x) => x.method === "createForumTopic").length,
    0,
  );
  assert.equal(required(await f.c.getTopic("new")).threadId, 33);
});
test("expired confirmation cannot create orphan; new prompt renews retained queue", async (t) => {
  const f = fixture(t);
  await f.c.handleUpdate(f.msg("first", 33, 70));
  const token = f.token("Confirm");
  required(f.c.actions.get(token)).expires = 0;
  await f.c.handleUpdate(f.cb(token, 33));
  assert.equal(f.bridgeCalls.filter((x) => x[0] === "create").length, 0);
  await f.c.handleUpdate(f.msg("second", 33, 71));
  await f.c.handleUpdate(f.cb(f.token("Confirm"), 33));
  assert.deepEqual(
    f.bridgeCalls.filter((x) => x[0] === "prompt").map((x) => x[2]),
    ["first", "second"],
  );
});
test("selection failure publishes no link or Telegram topic", async (t) => {
  const f = fixture(t);
  f.bridge.selectModel = async () => ({ ok: false, reason: "denied" });
  await f.c.handleUpdate(f.msg("/new"));
  await f.c.handleUpdate(f.cb(f.token("Confirm")));
  assert.equal(
    f.calls.filter((x) => x.method === "createForumTopic").length,
    0,
  );
  const edit = f.calls.filter((x) => x.method === "editMessageText").at(-1)!;
  assert.match(requiredField(edit.params.text), /setup failed/);
  assert.deepEqual(inlineMarkup(edit.params.reply_markup).inline_keyboard, []);
});
test("close is owner-only Telegram deletion; active DSH run remains and late events stay tombstoned", async (t) => {
  const f = fixture(t);
  await f.c.open("new", { chatId: OWNER, threadId: 0 });
  await f.c.sessionActions.requestClose("new", {
    chatId: OWNER,
    threadId: 500,
  });
  const token = f.token("Delete");
  await f.c.handleUpdate(f.cb(token, 500, 123));
  assert.equal(
    f.calls.filter((x) => x.method === "deleteForumTopic").length,
    0,
  );
  f.c.active.set("new", { draftId: 1, view: { turn: 1 } });
  await f.c.handleUpdate(f.cb(token, 500));
  assert.equal(f.bridgeCalls.filter((x) => x[0] === "stop").length, 0);
  assert.equal(f.c.active.has("new"), false);
  assert.equal(required(await f.c.mapping("new")).closed, true);
  const count = f.calls.length;
  await f.c.onRun("new", { turn: 1, answer: "late" });
  await f.c.refresh("new");
  assert.equal(f.calls.length, count);
  await f.c.open("new", { chatId: OWNER, threadId: 0 });
  assert.ok(await f.c.getTopic("new"));
});
test("failed delete keeps mapping and delivery active", async (t) => {
  const f = fixture(t);
  await f.c.open("new", { chatId: OWNER, threadId: 0 });
  f.c.active.set("new", { draftId: 1, view: { turn: 1 } });
  const original = f.api.call;
  f.api.call = async (method, params) => {
    if (method === "deleteForumTopic") throw new Error("denied");
    return original(method, params);
  };
  await assert.rejects(
    f.c.sessionActions.confirmClose({ id: "new", targetThreadId: 500 }),
    /denied/,
  );
  assert.ok(await f.c.getTopic("new"));
  assert.equal(f.c.active.has("new"), true);
});
test("native rejection deletes only its topic, discards prompts and fences late events", async (t) => {
  const f = fixture(t);
  await f.c.handleUpdate(f.msg("first", 33, 70));
  const confirm = f.token("Confirm");
  const cancel = f.token("Cancel");
  await f.c.handleUpdate(f.cb(cancel, 34));
  await f.c.handleUpdate(f.cb(cancel, 33, 123));
  assert.equal(
    f.calls.some((c) => c.method === "deleteForumTopic"),
    false,
  );
  await f.c.handleUpdate(f.cb(cancel, 33));
  assert.deepEqual(
    f.calls.find((c) => c.method === "deleteForumTopic")?.params,
    { chat_id: OWNER, message_thread_id: 33 },
  );
  const sends = f.calls.filter((c) => c.method === "sendMessage").length;
  await f.c.handleUpdate(f.cb(confirm, 33));
  await f.c.handleUpdate(f.msg("late", 33, 71));
  assert.equal(
    f.bridgeCalls.some((c) => c[0] === "create" || c[0] === "prompt"),
    false,
  );
  assert.equal(f.calls.filter((c) => c.method === "sendMessage").length, sends);
});
test("failed native deletion keeps confirmation retryable; /new cancellation preserves source topic", async (t) => {
  const f = fixture(t);
  await f.c.handleUpdate(f.msg("first", 33, 70));
  const cancel = f.token("Cancel");
  const call = f.api.call;
  f.api.call = async (method, params) => {
    if (method === "deleteForumTopic") throw new Error("denied");
    return call(method, params);
  };
  await assert.rejects(
    f.c.sessionActions.confirm(
      required(f.c.sessionActions.initiations.values().next().value),
      { chatId: OWNER, threadId: 33 },
      71,
      true,
    ),
    /denied/,
  );
  assert.ok(f.c.actions.has(cancel));
  f.api.call = call;
  await f.c.handleUpdate(f.cb(cancel, 33));
  await f.c.handleUpdate(f.msg("/new", 44));
  const count = f.calls.filter((c) => c.method === "deleteForumTopic").length;
  await f.c.handleUpdate(f.cb(f.token("Cancel"), 44));
  assert.equal(
    f.calls.filter((c) => c.method === "deleteForumTopic").length,
    count,
  );
});
test("pending picker selects without creating, paginates in place and confirms chosen model with queued prompt", async (t) => {
  const f = fixture(t);
  await f.c.handleUpdate(f.msg("first", 33, 70));
  await f.c.handleUpdate(f.cb(f.token("Model"), 33));
  assert.ok(
    inlineMarkup(f.last().params.reply_markup)
      .inline_keyboard.flat()
      .some((b) => b.text === "✓ p"),
  );
  await f.c.handleUpdate(f.cb(f.token("q"), 33));
  await f.c.handleUpdate(f.cb(f.token("Next"), 33));
  await f.c.handleUpdate(f.cb(f.token("other-11"), 33));
  assert.match(requiredField(f.last().params.text), /✓ other-11/);
  assert.equal(
    f.bridgeCalls.some((c) => c[0] === "create" || c[0] === "select"),
    false,
  );
  assert.ok(
    f.calls
      .filter((c) => c.method === "editMessageText")
      .every((c) => c.params.message_id === 1),
  );
  await f.c.handleUpdate(f.msg("second", 33, 72));
  await f.c.handleUpdate(f.cb(f.token("Confirm"), 33));
  assert.deepEqual(
    f.bridgeCalls.find((c) => c[0] === "select"),
    ["select", "new", { provider: "q", model: "other-11" }],
  );
  assert.deepEqual(
    f.bridgeCalls.filter((c) => c[0] === "prompt").map((c) => c[2]),
    ["first", "second"],
  );
});
test("closed native topic explicitly reopens existing binding without new DSH session", async (t) => {
  const f = fixture(t);
  await f.c.save("new", { chatId: OWNER, threadId: 500, topicClosed: true });
  await f.c.open("new", { chatId: OWNER, threadId: 0 });
  assert.equal(
    f.calls.filter((x) => x.method === "reopenForumTopic").length,
    1,
  );
  assert.equal(f.bridgeCalls.filter((x) => x[0] === "create").length, 0);
});

test("workspace selection paginates in place, preserves model and queued native prompts", async (t) => {
  const f = fixture(t);
  await f.c.handleUpdate(f.msg("first", 33, 70));
  const messageId = f.last().method === "sendMessage" ? 1 : 0;
  const workspaceToken = f.token("Workspace");
  await f.c.handleUpdate(f.cb(workspaceToken, 34));
  await f.c.handleUpdate(f.cb(workspaceToken, 33, 123));
  assert.equal(f.calls.filter((x) => x.method === "editMessageText").length, 0);
  await f.c.handleUpdate(f.cb(workspaceToken, 33));
  await f.c.handleUpdate(f.cb(f.token("Next"), 33));
  await f.c.handleUpdate(f.cb(f.token("Project 11"), 33));
  assert.match(requiredField(f.last().params.text), /Project 11/);
  assert.ok(
    inlineMarkup(f.last().params.reply_markup)
      .inline_keyboard.flat()
      .some((b) => b.text.startsWith("✓ Project 11")),
  );
  await f.c.handleUpdate(f.cb(f.token("Model"), 33));
  assert.match(requiredField(f.last().params.text), /Project 11/);
  assert.ok(
    f.calls
      .filter((x) => x.method === "editMessageText")
      .every((x) => x.params.message_id === messageId),
  );
  await f.c.handleUpdate(f.msg("second", 33, 71));
  assert.equal(
    f.bridgeCalls.some((x) => x[0] === "create"),
    false,
  );
  await f.c.handleUpdate(f.cb(f.token("Confirm"), 33));
  assert.deepEqual(
    f.bridgeCalls.find((x) => x[0] === "create"),
    ["create", "w11"],
  );
  assert.deepEqual(
    f.bridgeCalls.filter((x) => x[0] === "prompt").map((x) => x[3]),
    [`telegram:${OWNER}:70`, `telegram:${OWNER}:71`],
  );
  assert.equal(
    f.calls.some((x) => x.method === "createForumTopic"),
    false,
  );
});
test("removed workspace cannot create; default remains explicitly selectable", async (t) => {
  const f = fixture(t);
  await f.c.handleUpdate(f.msg("/new"));
  await f.c.handleUpdate(f.cb(f.token("Workspace")));
  await f.c.handleUpdate(f.cb(f.token("Project 0")));
  f.bridge.workspaces = async () => [];
  await f.c.handleUpdate(f.cb(f.token("Confirm")));
  assert.equal(
    f.bridgeCalls.some((x) => x[0] === "create"),
    false,
  );
  assert.match(requiredField(f.last().params.text), /no longer available/);
  await f.c.handleUpdate(f.msg("/new"));
  await f.c.handleUpdate(f.cb(f.token("Workspace")));
  await f.c.handleUpdate(f.cb(f.token("DSH default")));
  await f.c.handleUpdate(f.cb(f.token("Confirm")));
  assert.deepEqual(
    f.bridgeCalls.find((x) => x[0] === "create"),
    ["create", undefined],
  );
});
