import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import { ChildRuntime } from "../../src/child/runtime.js";
import { HostAuthority } from "../../src/host/authority.js";
import { ApprovalRegistry } from "../../src/host/approvals.js";
import { ResourceRegistry } from "../../src/host/resources.js";
import type { ConsoleBridge } from "../../src/bot/contracts.js";
import {
  TelegramAdapter,
  type TelegramApiPort,
} from "../../src/telegram/adapter.js";
import { createMemoryTransportPair } from "../../src/protocol/memory.js";
import { RpcPeer, type RpcHandler } from "../../src/protocol/rpc.js";
import { ProtocolError, type JsonValue } from "../../src/protocol/json.js";
import { deferred, record } from "./protocol-fixtures.js";

// Unlike the direct-handler/unit mocks, this fixture runs the real console,
// ChildRuntime-created host port, RPC serialization and HostAuthority together.
// Only Telegram and the Host's DSH bridge/storage/lease/inbox are in memory.
class Channel<T> {
  private readonly values: T[] = [];
  private readonly readers: Array<ReturnType<typeof deferred<T>>> = [];
  push(value: T): void {
    const reader = this.readers.shift();
    if (reader) reader.resolve(value);
    else this.values.push(value);
  }
  next(): Promise<T> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
    const reader = deferred<T>();
    this.readers.push(reader);
    return reader.promise;
  }
}

const generation = "runtime-authority-generation";
const ownerEpoch = 4;
const ownerId = 7;
const threadId = 9;
const actor = { ownerId, chatId: ownerId, threadId, privateChat: true };
const fenceSchema = z.object({
  generation: z.literal(generation),
  ownerEpoch: z.literal(ownerEpoch),
});
const wire = (value: unknown): JsonValue =>
  z.json().parse(structuredClone(value));

type ApiCall = { method: string; params: JsonValue };
function fixture(t: TestContext) {
  const rows = new Map<string, JsonValue>([
    [
      "console:topic:s",
      {
        chatId: ownerId,
        threadId,
        cardId: 50,
        topicTitle: "Old title",
      },
    ],
  ]);
  const bridgeCalls: Array<{ method: string; args: JsonValue }> = [];
  const bridge: ConsoleBridge = {
    workspaces: async () => [],
    list: async () => {
      bridgeCalls.push({ method: "list", args: [] });
      return [{ id: "s", title: "Host session" }];
    },
    metadata: async (id) => {
      bridgeCalls.push({ method: "metadata", args: [id] });
      return {
        id,
        title: "Host session",
        running: true,
        model: "fixture-model",
      };
    },
    models: async () => [],
    newSessionSelection: async () => null,
    create: async () => "new",
    selectModel: async () => ({ accepted: true }),
    prompt: async (id, text, requestId) => {
      bridgeCalls.push({ method: "prompt", args: [id, text, requestId] });
      return { accepted: true };
    },
    stop: async (id) => {
      bridgeCalls.push({ method: "stop", args: [id] });
      return { accepted: true };
    },
    steerQueued: async () => ({ accepted: true }),
    details: async () => "Host details",
    files: async () => [],
    fileForTurn: async () => ({ name: "fixture", content: new Uint8Array() }),
  };
  const store = {
    get: async (key: string) => {
      const value = rows.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    set: async (key: string, value: JsonValue) => {
      rows.set(key, structuredClone(value));
    },
    entries: async () =>
      [...rows].map(([key, value]): [string, JsonValue] => [
        key,
        structuredClone(value),
      ]),
  };
  const approvals = new ApprovalRegistry();
  const resources = new ResourceRegistry();
  const authority = new HostAuthority({
    bridge,
    store,
    approvals,
    resources,
    ownerId,
    ownerEpoch,
    generation,
    credentials: {
      readRecord: async () => ({
        kind: "api-key",
        key: "fixture-token-not-real",
      }),
    },
    credentialKey: "telegram-console/bot",
  });
  const errors: unknown[] = [];
  const requests: Array<{ method: string; payload: JsonValue }> = [];
  const apiCalls: ApiCall[] = [];
  const sends = new Channel<ApiCall>();
  const polls = new Channel<ReturnType<typeof deferred<JsonValue>>>();
  const pendingReads = new Channel<ReturnType<typeof deferred<JsonValue>>>();
  const admissions = new Channel<number>();
  const settlements = new Channel<{ updateId: number; outcome: string }>();
  const inbox = new Map<number, JsonValue>();
  let offset = 0;
  let messageId = 100;
  let adapterSignal: AbortSignal | undefined;
  const gated = (
    channel: Channel<ReturnType<typeof deferred<JsonValue>>>,
    signal: AbortSignal,
  ): Promise<JsonValue> => {
    if (signal.aborted) return Promise.resolve([]);
    const gate = deferred<JsonValue>();
    const abort = () => gate.resolve([]);
    signal.addEventListener("abort", abort, { once: true });
    channel.push(gate);
    return gate.promise.finally(() =>
      signal.removeEventListener("abort", abort),
    );
  };
  const capture = (method: string, params: unknown): ApiCall => {
    const call = { method, params: wire(params) };
    apiCalls.push(call);
    return call;
  };
  const fakeApi: TelegramApiPort = {
    getMe: async () => ({ id: 321, username: "fixture_bot" }),
    getWebhookInfo: async () => ({ url: "" }),
    setMyCommands: async (params) => {
      capture("setMyCommands", params);
      return true;
    },
    getUpdates: async (params) => {
      capture("getUpdates", params);
      assert.ok(adapterSignal);
      return gated(polls, adapterSignal);
    },
    sendMessage: async (params) => {
      const call = capture("sendMessage", params);
      sends.push(call);
      return { message_id: ++messageId };
    },
    editMessageText: async (params) => {
      capture("editMessageText", params);
      return { message_id: 50 };
    },
    editMessageReplyMarkup: async (params) => {
      capture("editMessageReplyMarkup", params);
      return true;
    },
    sendMessageDraft: async (params) => {
      capture("sendMessageDraft", params);
      return true;
    },
    sendChatAction: async (params) => {
      capture("sendChatAction", params);
      return true;
    },
    editForumTopic: async (params) => {
      capture("editForumTopic", params);
      return true;
    },
    pinChatMessage: async (params) => {
      capture("pinChatMessage", params);
      return true;
    },
    answerCallbackQuery: async (params) => {
      capture("answerCallbackQuery", params);
      return true;
    },
    deleteMessage: async (params) => {
      capture("deleteMessage", params);
      return true;
    },
  };
  const handlers: Record<string, RpcHandler> = {};
  // Match src/index.ts's outer payload fence: RpcPeer's envelope fence alone
  // cannot detect a missing/wrong generation in createHostPort bridge payloads.
  const add = (method: string, handler: RpcHandler) => {
    handlers[method] = async (payload, signal) => {
      requests.push({ method, payload: structuredClone(payload) });
      if (!fenceSchema.safeParse(payload).success)
        throw new ProtocolError("AUTHORITY_DENIED", "Host authority denied");
      return handler(payload, signal);
    };
  };
  for (const [method, handler] of Object.entries(authority.handlers()))
    add(method, handler);
  add("runtime.acquireLease", async () => ({ acquired: true }));
  add("inbox.offset", async () => offset);
  add("inbox.pending", async (_payload, signal) => gated(pendingReads, signal));
  add("inbox.admit", async (payload) => {
    const p = z
      .object({
        update: z.object({ update_id: z.number().int() }).passthrough(),
      })
      .parse(payload);
    const updateId = p.update.update_id;
    if (inbox.has(updateId)) return "duplicate";
    inbox.set(updateId, {
      updateId,
      ownerEpoch,
      operation: wire(p.update),
      status: "pending",
    });
    offset = updateId + 1;
    admissions.push(updateId);
    return "admitted";
  });
  add("inbox.settle", async (payload) => {
    const p = z
      .object({ updateId: z.number(), outcome: z.string() })
      .parse(payload);
    inbox.delete(p.updateId);
    settlements.push(p);
    return null;
  });
  const [hostTransport, childTransport] = createMemoryTransportPair();
  const host = new RpcPeer({
    transport: hostTransport,
    generation,
    handlers,
    timeoutMs: 2000,
  });
  let runtime: ChildRuntime;
  const childHandlers: Record<string, RpcHandler> = {};
  for (const method of [
    "runtime.initialize",
    "settings.update",
    "run.push",
    "session.refresh",
    "approval.request",
  ]) {
    childHandlers[method] = async (payload, signal) => {
      const handler = runtime.handlers[method];
      assert.ok(handler);
      return handler(payload, signal);
    };
  }
  const child = new RpcPeer({
    transport: childTransport,
    generation,
    handlers: childHandlers,
    timeoutMs: 2000,
  });
  let now = 0;
  runtime = new ChildRuntime({
    peer: child,
    generation,
    build: "fixture-build",
    onError: (error) => errors.push(error),
    adapterFactory: (options) => {
      adapterSignal = options.signal;
      return new TelegramAdapter({
        ...options,
        createApi: () => fakeApi,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      });
    },
  });
  t.after(async () => {
    await runtime.shutdown();
    authority.close();
    approvals.close();
    host.close();
    child.close();
  });
  const initialize = (configuredOwner = ownerId) =>
    host.request("runtime.initialize", {
      ownerId: configuredOwner,
      ownerEpoch,
      locale: "en",
      version: "fixture",
    });
  const dispatch = async (update: JsonValue) => {
    const id = z.object({ update_id: z.number() }).parse(update).update_id;
    (await polls.next()).resolve([update]);
    assert.equal(await admissions.next(), id);
    (await pendingReads.next()).resolve(
      [...inbox.values()].map((entry) => structuredClone(entry)),
    );
    const settlement = await settlements.next();
    assert.equal(settlement.updateId, id);
    assert.equal(settlement.outcome, "completed");
  };
  return {
    runtime,
    fakeApi,
    host,
    child,
    authority,
    approvals,
    rows,
    bridgeCalls,
    requests,
    apiCalls,
    sends,
    errors,
    initialize,
    waitPolling: () => polls.next(),
    dispatch,
  };
}

async function eventually(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(condition(), "background command registration did not settle");
}

test("startup refreshes owner command menus without blocking polling and locale changes refresh them", async (t) => {
  const f = fixture(t);
  await f.initialize();
  await f.waitPolling();
  const menus = () => f.apiCalls.filter((c) => c.method === "setMyCommands");
  await eventually(() => menus().length === 4);
  assert.equal(menus().length, 4);
  const schema = z.object({
    scope: z.object({ type: z.literal("chat"), chat_id: z.literal(ownerId) }),
    language_code: z.string(),
    commands: z.array(
      z.object({
        command: z.string(),
        description: z.string().min(1).max(256),
      }),
    ),
  });
  for (const call of menus()) {
    const menu = schema.parse(call.params);
    assert.deepEqual(
      menu.commands.map((c) => c.command),
      [
        "start",
        "sessions",
        "new",
        "status",
        "stop",
        "files",
        "version",
        "help",
      ],
    );
    assert.equal(menu.commands[0]?.description, "Open sessions");
  }
  assert.deepEqual(
    menus().map((c) => schema.parse(c.params).language_code),
    ["", "en", "zh", "ru"],
  );
  assert.ok(
    f.apiCalls.findIndex((c) => c.method === "getUpdates") <
      f.apiCalls.findLastIndex((c) => c.method === "setMyCommands"),
  );
  await f.host.request("settings.update", { locale: "ru-RU" });
  assert.equal(menus().length, 8);
  assert.equal(
    schema.parse(menus().at(-1)?.params).commands[0]?.description,
    "Открыть список сессий",
  );
  await f.host.request("settings.update", { locale: "ru-RU" });
  assert.equal(menus().length, 8);
  assert.deepEqual(f.errors, []);
});
test("locked owner does not register a Telegram command menu", async (t) => {
  const f = fixture(t);
  await f.initialize(0);
  await f.waitPolling();
  assert.equal(
    f.apiCalls.some((c) => c.method === "setMyCommands"),
    false,
  );
});

test("menu registration failure reports error without preventing startup and polling", async (t) => {
  const f = fixture(t);
  f.fakeApi.setMyCommands = async () => {
    throw new Error("menu rejected");
  };
  await f.initialize();
  await f.waitPolling();
  await eventually(() => f.errors.length === 1);
  assert.equal(f.errors.length, 1);
  assert.ok(f.apiCalls.some((c) => c.method === "getUpdates"));
});

const message = (
  updateId: number,
  text: string,
  thread = threadId,
): JsonValue => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    from: { id: ownerId },
    chat: { id: ownerId, type: "private" },
    message_thread_id: thread,
    text,
  },
});

test(
  "runtime bridge payload generation passes the index outer fence for /sessions, metadata and prompt",
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t);
    await f.initialize();
    await f.dispatch(message(1, "/sessions", 0));
    await f.dispatch(message(2, "hello Host"));
    assert.deepEqual(
      f.bridgeCalls.filter((call) =>
        ["list", "metadata", "prompt"].includes(call.method),
      ),
      [
        { method: "list", args: [] },
        { method: "metadata", args: ["s"] },
        { method: "prompt", args: ["s", "hello Host", "telegram:7:2"] },
      ],
    );
    for (const request of f.requests.filter((entry) =>
      entry.method.startsWith("bridge."),
    )) {
      assert.equal(record(request.payload).generation, generation);
      assert.equal(record(request.payload).ownerEpoch, ownerEpoch);
    }
    assert.deepEqual(f.errors, []);
  },
);

test(
  "native stopped generation without from stops only the current owner topic and draft",
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t);
    await f.initialize();
    await f.host.request("run.push", {
      sessionId: "s",
      view: { turn: 1, status: "running", partialAnswer: "Thinking" },
    });
    const draft = f.apiCalls.find((call) => call.method === "sendMessageDraft");
    assert.ok(draft);
    const draftId = z
      .object({ draft_id: z.number().int().positive() })
      .parse(draft.params).draft_id;
    const stopped = (
      id: number,
      chatId: number,
      thread: number,
      draft: number | string,
      type = "private",
    ): JsonValue => ({
      update_id: id,
      stopped_message_generation: {
        chat: { id: chatId, type },
        message_thread_id: thread,
        draft_id: draft,
      },
    });
    await f.dispatch(stopped(10, 8, threadId, draftId));
    await f.dispatch(stopped(11, ownerId, 99, draftId));
    await f.dispatch(stopped(12, ownerId, threadId, draftId + 1));
    await f.dispatch(stopped(13, ownerId, threadId, draftId, "supergroup"));
    assert.deepEqual(
      f.bridgeCalls.filter((call) => call.method === "stop"),
      [],
    );
    // Actual Telegram native Stop updates use a decimal string (including IDs
    // above signed 32-bit); normalize before classification and authorization.
    await f.dispatch(stopped(14, ownerId, threadId, String(draftId)));
    assert.deepEqual(
      f.bridgeCalls.filter((call) => call.method === "stop"),
      [{ method: "stop", args: ["s"] }],
    );
    const request = f.requests.find((entry) => entry.method === "bridge.stop");
    assert.ok(request);
    assert.deepEqual(record(request.payload).actor, actor);
    assert.equal(record(request.payload).operationId, "telegram:4:14:stop:s");
    assert.deepEqual(f.errors, []);
  },
);

test(
  "Host session.refresh supplies read-only actor scope outside an admitted update instead of rendering offline",
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t);
    await f.initialize();
    assert.equal(f.runtime.scope.getStore(), undefined);
    await f.host.request("session.refresh", { sessionId: "s" });
    assert.deepEqual(f.bridgeCalls, [{ method: "metadata", args: ["s"] }]);
    const request = f.requests.find(
      (entry) => entry.method === "bridge.metadata",
    );
    assert.ok(request);
    assert.deepEqual(record(request.payload).actor, actor);
    assert.equal(record(request.payload).operationId, undefined);
    assert.ok(
      f.apiCalls.some(
        (call) =>
          call.method === "editMessageText" &&
          JSON.stringify(call.params).includes("Host session"),
      ),
    );
    assert.ok(
      !f.apiCalls.some((call) =>
        JSON.stringify(call.params).includes("offline"),
      ),
    );
    assert.ok(
      !f.requests.some((entry) =>
        [
          "bridge.prompt",
          "bridge.stop",
          "bridge.selectModel",
          "bridge.create",
        ].includes(entry.method),
      ),
    );
    assert.deepEqual(f.errors, []);
  },
);

test(
  "real approval callback rejects forged actor and settles the Host registry exactly once",
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t);
    await f.initialize();
    const expiresAt = Date.now() + 60000;
    const approval = f.approvals.register({
      sessionId: "s",
      callId: "call-1",
      ownerId,
      ownerEpoch,
      chatId: ownerId,
      threadId,
      expiresAt,
    });
    const presentation = f.host.request("approval.request", {
      id: approval.id,
      sessionId: "s",
      callId: "call-1",
      expiresAt,
      request: { name: "bash", arguments: { command: "fixture command" } },
    });
    // Attach immediately so cleanup cancellation never becomes an unhandled rejection.
    const observedPresentation = presentation.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const sent = await f.sends.next();
    const params = z
      .object({
        reply_markup: z.object({
          inline_keyboard: z.array(
            z.array(z.object({ callback_data: z.string() })),
          ),
        }),
      })
      .parse(sent.params);
    const token = params.reply_markup.inline_keyboard[0]?.[0]?.callback_data;
    assert.ok(token);
    const callback = (id: number, user: number): JsonValue => ({
      update_id: id,
      callback_query: {
        id: `callback-${id}`,
        from: { id: user },
        data: token,
        message: {
          message_id: 101,
          chat: { id: ownerId, type: "private" },
          message_thread_id: threadId,
        },
      },
    });
    await f.dispatch(callback(20, 8));
    assert.equal(
      f.requests.filter((entry) => entry.method === "approvals.decide").length,
      0,
    );
    await assert.rejects(
      f.child.request("approvals.decide", {
        generation,
        ownerEpoch,
        id: approval.id,
        sessionId: "s",
        callId: "call-1",
        actor: { ...actor, ownerId: 8 },
        outcome: "allowed-once",
      }),
      { code: "HANDLER_ERROR" },
    );
    await f.dispatch(callback(21, ownerId));
    assert.deepEqual(await observedPresentation, { value: "allowed-once" });
    assert.equal(await approval.result, "allowed-once");
    const decisions = f.requests.filter(
      (entry) =>
        entry.method === "approvals.decide" &&
        record(entry.payload).actor !== undefined &&
        record(record(entry.payload).actor ?? null).ownerId === ownerId,
    );
    assert.equal(decisions.length, 1);
    assert.deepEqual(record(decisions[0]?.payload ?? null).actor, actor);
    await f.dispatch(callback(22, ownerId));
    assert.equal(
      f.requests.filter((entry) => entry.method === "approvals.decide").length,
      2,
      "one forged RPC plus exactly one genuine callback decision",
    );
    assert.equal(
      await f.child.request("approvals.decide", {
        generation,
        ownerEpoch,
        id: approval.id,
        sessionId: "s",
        callId: "call-1",
        actor,
        outcome: "rejected",
      }),
      false,
    );
    assert.equal(await approval.result, "allowed-once");
    assert.deepEqual(f.errors, []);
  },
);
