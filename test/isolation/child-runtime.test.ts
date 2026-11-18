import { test } from "node:test";
import assert from "node:assert/strict";
import { ChildRuntime } from "../../src/child/runtime.js";
import { parseChildArguments } from "../../src/child/index.js";
import { ChildSupervisor } from "../../src/host/supervisor.js";
import { TelegramAdapter } from "../../src/telegram/adapter.js";
import type { JsonValue } from "../../src/protocol/json.js";
import type { RpcRequestOptions } from "../../src/protocol/rpc.js";

test("handler failure reports safe method and cause before generic RPC replacement", async () => {
  const events: JsonValue[] = [];
  const runtime = new ChildRuntime({
    generation: "g",
    build: "b",
    peer: {
      request: async (_method, payload) => {
        events.push(payload);
        return null;
      },
    },
  });
  await runtime.reportHandlerError(
    "run.push",
    Object.assign(new TypeError("SECRET token URL"), { code: 403 }),
  );
  const event = events[0] as Record<string, JsonValue>;
  assert.equal(event.rpcMethod, "run.push");
  assert.equal(event.code, "TELEGRAM_REJECTED");
  assert.equal(event.statusCode, 403);
  assert.equal(event.errorType, "TypeError");
  assert.ok(!JSON.stringify(events).includes("SECRET"));
  await runtime.shutdown();
});

test("child startup reports sanitized ordered stages and nonfatal command failure", async () => {
  const events: Record<string, JsonValue>[] = [];
  const order: string[] = [];
  const runtime = new ChildRuntime({
    generation: "startup-generation",
    build: "build",
    drainMs: 10,
    peer: {
      request: async (
        method: string,
        payload: JsonValue,
      ): Promise<JsonValue> => {
        if (method === "runtime.startup") {
          const event = payload as Record<string, JsonValue>;
          events.push(event);
          order.push(`${event.stage}:${event.outcome}`);
          assert.equal(event.generation, "startup-generation");
          assert.equal(event.ownerEpoch, 7);
          return null;
        }
        if (method === "credentials.read") return { token: "123:fake" };
        if (method === "runtime.acquireLease") return { acquired: true };
        if (method === "inbox.offset") return 0;
        if (method === "inbox.pending") return [];
        throw new Error("unsupported mock method");
      },
    },
    adapterFactory: (options) =>
      new TelegramAdapter({
        ...options,
        createApi: () => ({
          getMe: async () => {
            order.push("wire:getMe");
            return { id: 123 };
          },
          getWebhookInfo: async () => ({ url: "" }),
          setMyCommands: async ({ language_code }) => {
            if (language_code === "zh")
              throw Object.assign(new Error("secret URL token result"), {
                errorCode: 403,
              });
            return true;
          },
          getUpdates: async (_params, signal) =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                { once: true },
              );
            }),
        }),
      }),
  });
  try {
    assert.deepEqual(
      await runtime.handlers["runtime.initialize"]!(
        { ownerId: 1, ownerEpoch: 7, locale: "en", version: "test" },
        new AbortController().signal,
      ),
      { initialized: true },
    );
    // Command registration now runs independently of initialization/polling.
    for (
      let i = 0;
      i < 100 &&
      !events.some(
        (event) => event.stage === "commands" && event.outcome === "failed",
      );
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(order.indexOf("getMe:begin") < order.indexOf("wire:getMe"));
    assert.ok(
      events.some(
        (event) => event.stage === "surface" && event.outcome === "ok",
      ),
    );
    assert.ok(
      events.some(
        (event) => event.stage === "credential-read" && event.outcome === "ok",
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.stage === "setMyCommands" &&
          event.language === "zh" &&
          event.outcome === "failed" &&
          event.statusCode === 403,
      ),
    );
    assert.ok(
      events.some(
        (event) => event.stage === "commands" && event.outcome === "failed",
      ),
    );
    assert.ok(
      events.some(
        (event) => event.stage === "ingress" && event.outcome === "ok",
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(events),
      /secret|URL|token|result|123:fake/,
    );
  } finally {
    await runtime.shutdown();
  }
});

test("blocked command registration cannot block initialization or polling", async () => {
  let polling = false;
  let commands = false;
  const runtime = new ChildRuntime({
    generation: "g",
    build: "b",
    drainMs: 10,
    peer: {
      request: async (method): Promise<JsonValue> => {
        if (method === "credentials.read") return { token: "123:fake" };
        if (method === "runtime.acquireLease") return { acquired: true };
        if (method === "inbox.offset") return 0;
        if (method === "inbox.pending") return [];
        return null;
      },
    },
    adapterFactory: (options) =>
      new TelegramAdapter({
        ...options,
        createApi: () => ({
          getMe: async () => ({ id: 123 }),
          getWebhookInfo: async () => ({ url: "" }),
          setMyCommands: async () => {
            commands = true;
            return new Promise(() => {});
          },
          getUpdates: async () => {
            polling = true;
            return new Promise(() => {});
          },
        }),
      }),
  });
  try {
    const result = await Promise.race([
      runtime.handlers["runtime.initialize"]!(
        { ownerId: 1, ownerEpoch: 1, locale: "en", version: "test" },
        new AbortController().signal,
      ),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("initialization blocked on menu")),
          1000,
        );
        timer.unref();
      }),
    ]);
    assert.deepEqual(result, { initialized: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(polling, true);
    assert.equal(commands, true);
  } finally {
    await runtime.shutdown();
  }
});

test("child emits getMe transport failure before propagation", async () => {
  const events: Record<string, JsonValue>[] = [];
  const runtime = new ChildRuntime({
    generation: "g",
    build: "b",
    peer: {
      request: async (
        method: string,
        payload: JsonValue,
      ): Promise<JsonValue> => {
        if (method === "runtime.startup") {
          events.push(payload as Record<string, JsonValue>);
          return null;
        }
        if (method === "credentials.read") return { token: "123:fake" };
        throw Error("unexpected method");
      },
    },
    adapterFactory: (options) =>
      new TelegramAdapter({
        ...options,
        createApi: () => ({
          getMe: async () => {
            throw Object.assign(Error("private transport details"), {
              cause: { code: "ECONNREFUSED" },
            });
          },
        }),
      }),
  });
  try {
    await assert.rejects(
      runtime.handlers["runtime.initialize"]!(
        { ownerId: 1, ownerEpoch: 2, locale: "en", version: "test" },
        new AbortController().signal,
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.stage === "getMe" &&
          event.outcome === "failed" &&
          event.code === "ECONNREFUSED",
      ),
    );
    assert.ok(!events.some((event) => event.stage === "lease"));
    assert.doesNotMatch(JSON.stringify(events), /private|transport details/);
  } finally {
    await runtime.shutdown();
  }
});

test("startup diagnostics remain bounded when a peer ignores RPC deadlines", async () => {
  const calls: RpcRequestOptions[] = [];
  const runtime = new ChildRuntime({
    generation: "g",
    build: "b",
    peer: {
      request: async (_method, _payload, options) => {
        calls.push(options!);
        return new Promise(() => {});
      },
    },
    adapterFactory: () => {
      throw Object.assign(Error("private factory detail"), {
        code: "ENOTFOUND",
      });
    },
  });
  const start = performance.now();
  try {
    await assert.rejects(
      runtime.handlers["runtime.initialize"]!(
        { ownerId: 1, ownerEpoch: 2, locale: "en", version: "test" },
        new AbortController().signal,
      ),
    );
    assert.ok(performance.now() - start < 2000);
    assert.equal(calls.length, 1);
    assert.ok(
      calls.every((call) => call.timeoutMs === 250 && call.signal?.aborted),
    );
  } finally {
    await runtime.shutdown();
  }
});

test("startup diagnostics stop after unknown-method rejection without hiding startup failure", async () => {
  let calls = 0;
  const runtime = new ChildRuntime({
    generation: "g",
    build: "b",
    peer: {
      request: async () => {
        calls++;
        throw Error("unknown diagnostic method");
      },
    },
    adapterFactory: () => {
      throw Error("factory failure");
    },
  });
  try {
    await assert.rejects(
      runtime.handlers["runtime.initialize"]!(
        { ownerId: 1, ownerEpoch: 2, locale: "en", version: "test" },
        new AbortController().signal,
      ),
      /factory failure/,
    );
    assert.equal(calls, 1);
  } finally {
    await runtime.shutdown();
  }
});

test("child entry requires explicit generation and build without secrets", () => {
  assert.deepEqual(
    parseChildArguments([
      "--telegram-generation",
      "g",
      "--telegram-build",
      "b",
    ]),
    { generation: "g", build: "b" },
  );
  assert.throws(() => parseChildArguments(["--telegram-generation", "g"]));
  assert.deepEqual(
    parseChildArguments(["--telegram-generation=g", "--telegram-build=b"]),
    { generation: "g", build: "b" },
  );
  assert.throws(() =>
    parseChildArguments([
      "--telegram-generation=g",
      "--telegram-generation",
      "g",
      "--telegram-build=b",
    ]),
  );
});

test(
  "actual launcher starts child entry and completes hello without Telegram",
  { timeout: 10000 },
  async () => {
    const supervisor = new ChildSupervisor({
      entry: new URL("../../src/child/index.js", import.meta.url),
      generation: "entry-generation",
      build: "entry-build",
      startupTimeoutMs: 3000,
      shutdownTimeoutMs: 2000,
      maxRestarts: 0,
    });
    try {
      await supervisor.start();
      assert.equal(supervisor.state, "running");
      assert.notEqual(supervisor.pid, process.pid);
    } finally {
      await supervisor.close();
    }
    assert.equal(supervisor.state, "closed");
  },
);

test("child rejects work before initialization and shutdown is idempotent", async () => {
  const calls: string[] = [];
  const runtime = new ChildRuntime({
    peer: {
      request: async (method) => {
        calls.push(method);
        return null;
      },
    },
    generation: "g",
    build: "b",
    drainMs: 10,
  });
  const run = runtime.handlers["run.push"];
  assert.ok(run);
  await assert.rejects(
    run({ sessionId: "s", view: { turn: 1 } }, new AbortController().signal),
    /not initialized/,
  );
  assert.deepEqual(calls, []);
  const first = runtime.shutdown();
  assert.equal(runtime.controller.signal.aborted, true);
  assert.equal(runtime.shutdown(), first);
  await first;
});

test("child validates run views before any remote work", async () => {
  const runtime = new ChildRuntime({
    peer: { request: async () => null },
    generation: "g",
    build: "b",
  });
  const run = runtime.handlers["run.push"];
  assert.ok(run);
  await assert.rejects(
    run(
      { sessionId: "s", view: { turn: { bad: true } } },
      new AbortController().signal,
    ),
  );
  await runtime.shutdown();
});
