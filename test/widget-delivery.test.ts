import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  WidgetDelivery,
  widgetDeliveryKey,
} from "../src/widgets/widget-delivery.js";
import { required } from "./fixture-assertions.js";
interface RegistryEntry {
  message_id: number;
  sent_at: string;
  content_hash: string;
}
interface ApiParams {
  html?: string;
  message_thread_id?: number;
  protect_content?: boolean;
  allow_queries?: boolean;
  message_id?: number;
}
type Call =
  [method: string, params: ApiParams] | [method: "persist", key: string];
// Check the recorded union at runtime rather than casting persisted keys to API output.
function callParams(call: Call | undefined): ApiParams {
  const params = required(call)[1];
  if (typeof params === "string")
    throw new Error("Expected an API call, not persistence");
  return params;
}
const compiled = (html: string) => ({
  html,
  hash: createHash("sha256").update(html).digest("hex"),
});
function fixture() {
  const state = new Map<string, RegistryEntry>();
  const calls: Call[] = [];
  let id = 0;
  const store = {
    async get(k: string) {
      return state.get(k);
    },
    async set(k: string, v: RegistryEntry) {
      calls.push(["persist", k]);
      state.set(k, v);
    },
  };
  const api = {
    async call(method: string, params: ApiParams) {
      calls.push([method, params]);
      if (method === "sendWidget") return { message_id: ++id };
      return true;
    },
  };
  return {
    state,
    calls,
    store,
    api,
    delivery: new WidgetDelivery({ api, store }),
  };
}
const args = {
  chatId: 123,
  threadId: 5,
  filename: "telegram_widget_test.html",
  // Legacy JS inference requires this runtime-optional destructured input.
  caption: undefined,
};
test("send, hash skip, replace order, persisted registry survives new instance", async () => {
  const f = fixture();
  const first = await f.delivery.deliver({
    ...args,
    compiled: compiled("<p>a</p>"),
  });
  assert.deepEqual(first, { status: "sent", messageId: 1 });
  assert.equal(callParams(f.calls[0]).html, "<p>a</p>");
  assert.equal(callParams(f.calls[0]).message_thread_id, 5);
  assert.equal(callParams(f.calls[0]).protect_content, true);
  assert.equal(callParams(f.calls[0]).allow_queries, false);
  assert.equal(
    (await f.delivery.deliver({ ...args, compiled: compiled("<p>a</p>") }))
      .status,
    "unchanged",
  );
  f.calls.length = 0;
  const restarted = new WidgetDelivery({ api: f.api, store: f.store });
  assert.equal(
    (await restarted.deliver({ ...args, compiled: compiled("<p>b</p>") }))
      .status,
    "replaced",
  );
  assert.deepEqual(
    f.calls.map((c) => c[0]),
    ["sendWidget", "deleteMessage", "persist"],
  );
  assert.equal(callParams(f.calls[1]).message_id, 1);
});
test("send failure keeps old widget and registry unchanged", async () => {
  const f = fixture();
  await f.delivery.deliver({ ...args, compiled: compiled("a") });
  const snapshot = [...f.state];
  f.calls.length = 0;
  f.api.call = async () => {
    throw new Error("send failed");
  };
  await assert.rejects(
    f.delivery.deliver({ ...args, compiled: compiled("b") }),
    /send failed/,
  );
  assert.deepEqual([...f.state], snapshot);
});
test("same-key concurrent duplicates serialize and hash skip", async () => {
  const f = fixture();
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      f.delivery.deliver({ ...args, compiled: compiled("a") }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "sent").length, 1);
  assert.equal(f.calls.filter((c) => c[0] === "sendWidget").length, 1);
  await f.delivery.deliver({ ...args, threadId: 6, compiled: compiled("a") });
  assert.equal(f.state.size, 2);
});
test("missing previous message ignored; other delete errors roll back new message", async () => {
  const f = fixture();
  await f.delivery.deliver({ ...args, compiled: compiled("a") });
  const call = f.api.call;
  f.api.call = async (m, p) => {
    if (m === "deleteMessage" && p.message_id === 1)
      throw new Error("Bad Request: message to delete not found");
    return call(m, p);
  };
  await f.delivery.deliver({ ...args, compiled: compiled("b") });
  const old = f.state.get(
    widgetDeliveryKey(args.chatId, args.threadId, args.filename),
  );
  f.api.call = async (m, p) => {
    if (m === "deleteMessage" && p.message_id === 2)
      throw new Error("Forbidden");
    return call(m, p);
  };
  await assert.rejects(
    f.delivery.deliver({ ...args, compiled: compiled("c") }),
    /Forbidden/,
  );
  assert.deepEqual(
    f.state.get(widgetDeliveryKey(args.chatId, args.threadId, args.filename)),
    old,
  );
});
test("reject forged compiled hash before send", async () => {
  const f = fixture();
  await assert.rejects(
    f.delivery.deliver({ ...args, compiled: { html: "a", hash: "forged" } }),
    /hash/,
  );
  assert.equal(f.calls.length, 0);
});
