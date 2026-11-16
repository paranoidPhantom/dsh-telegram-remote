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
  const selection = { provider: "p", model: "m", reasoningEffort: "high" };
  const bridge: Bridge = {
    async newSessionSelection(source) {
      bridgeCalls.push(["selection", source]);
      return selection;
    },
    async create() {
      bridgeCalls.push(["create"]);
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
  };
  const api = {
    async call(method: TelegramMethod, params: TelegramParams = {}) {
      calls.push({ method, params: params });
      return method === "sendMessage"
        ? { message_id: ++n }
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
  const cb = (token: string, thread = 0, owner = OWNER, messageId = 1) => ({
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
    required(calls.filter((x) => x.method === "sendMessage").at(-1));
  const token = (label: string) =>
    requiredField(
      inlineMarkup(last().params.reply_markup)
        .inline_keyboard.flat()
        .find((b) => b.text.includes(label))!.callback_data,
    );
  return { c, calls, bridgeCalls, data, bridge, api, msg, cb, last, token };
}
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
  assert.equal(edit.params.message_id, 1);
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
