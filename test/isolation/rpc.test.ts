import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "../../src/protocol/json.js";
import { createMemoryTransportPair } from "../../src/protocol/memory.js";
import { RpcPeer } from "../../src/protocol/rpc.js";
import {
  ControlledTransport,
  deadlockGuard,
  deferred,
  envelope,
  failure,
  field,
  record,
} from "./protocol-fixtures.js";

const generation = "test-generation";

test(
  "RPC request/result uses the versioned envelope and waits for a remote result",
  deadlockGuard,
  async (t) => {
    const transport = new ControlledTransport();
    const peer = new RpcPeer({ transport, generation });
    t.after(() => peer.close());
    const result = peer.request("session.list", { cursor: 2 });
    const request = record(await transport.nextSent());
    assert.equal(request.version, 1);
    assert.equal(request.generation, generation);
    assert.equal(request.type, "request");
    assert.ok(
      typeof field(request, "id") === "string" ||
        typeof field(request, "id") === "number",
    );
    assert.deepEqual(request.payload, {
      method: "session.list",
      params: { cursor: 2 },
    });
    assert.equal(
      peer.pendingCount,
      1,
      "transport admission is not RPC acknowledgement",
    );
    transport.receive(
      envelope("result", field(request, "id"), { sessions: [] }),
    );
    assert.deepEqual(await result, { sessions: [] });
    assert.equal(peer.pendingCount, 0);
  },
);

test(
  "RPC handles simultaneous bidirectional requests and correlates out-of-order results",
  deadlockGuard,
  async (t) => {
    const [leftTransport, rightTransport] = createMemoryTransportPair();
    const firstStarted = deferred<void>();
    const firstResult = deferred<JsonValue>();
    const left = new RpcPeer({
      transport: leftTransport,
      generation,
      handlers: {
        reverse: async (payload: JsonValue) => ({ reflected: payload }),
      },
    });
    const right = new RpcPeer({
      transport: rightTransport,
      generation,
      handlers: {
        slow: async () => {
          firstStarted.resolve();
          return firstResult.promise;
        },
        echo: async (payload: JsonValue) => payload,
      },
    });
    t.after(() => left.close());
    t.after(() => right.close());
    const slow = left.request("slow", null);
    await firstStarted.promise;
    const fast = left.request("echo", [1, { ok: true }]);
    const reverse = right.request("reverse", "from child");
    assert.deepEqual(await fast, [1, { ok: true }]);
    assert.deepEqual(await reverse, { reflected: "from child" });
    assert.equal(left.pendingCount, 1);
    firstResult.resolve("slow result");
    assert.equal(await slow, "slow result");
    assert.equal(left.pendingCount, 0);
    assert.equal(right.pendingCount, 0);
  },
);

test(
  "RPC unknown methods have a stable error code and cannot resolve prototype methods",
  deadlockGuard,
  async (t) => {
    const [a, b] = createMemoryTransportPair();
    const caller = new RpcPeer({ transport: a, generation });
    const server = new RpcPeer({ transport: b, generation, handlers: {} });
    t.after(() => caller.close());
    t.after(() => server.close());
    const first = await failure(caller.request("missing", null));
    const second = await failure(caller.request("missing", null));
    assert.equal(first.code, second.code);
    for (const method of ["toString", "constructor", "__proto__"]) {
      assert.equal(
        (await failure(caller.request(method, null))).code,
        first.code,
      );
    }
    assert.equal(caller.pendingCount, 0);
  },
);

test(
  "RPC handler errors are sanitized, stable and do not echo payload or stack",
  deadlockGuard,
  async (t) => {
    const [a, b] = createMemoryTransportPair();
    const secret = "fixture-private-token-DO-NOT-ECHO";
    const caller = new RpcPeer({ transport: a, generation });
    const server = new RpcPeer({
      transport: b,
      generation,
      handlers: {
        explode: async () => {
          throw new Error(`handler failed with ${secret}\n at privateHostPath`);
        },
      },
    });
    t.after(() => caller.close());
    t.after(() => server.close());
    const first = await failure(
      caller.request("explode", { credential: secret }),
    );
    const second = await failure(
      caller.request("explode", { credential: secret }),
    );
    assert.equal(first.code, second.code);
    assert.equal(first.message.includes(secret), false);
    assert.equal(first.message.includes("privateHostPath"), false);
    assert.equal(first.message.includes(" at "), false);
    assert.equal(caller.pendingCount, 0);
  },
);

test(
  "RPC error envelopes expose only code/message, not exception properties",
  deadlockGuard,
  async (t) => {
    const transport = new ControlledTransport();
    const server = new RpcPeer({
      transport,
      generation,
      handlers: {
        fail: async () => {
          throw Object.assign(new Error("fixture-secret"), {
            token: "fixture-secret",
          });
        },
      },
    });
    t.after(() => server.close());
    transport.receive(
      envelope("request", "inbound-error", { method: "fail", params: null }),
    );
    const response = record(await transport.nextSent());
    assert.equal(response.type, "error");
    assert.equal(response.id, "inbound-error");
    assert.equal(response.version, 1);
    assert.equal(response.generation, generation);
    const payload = record(field(response, "payload"));
    assert.deepEqual(Object.keys(payload).sort(), ["code", "message"]);
    assert.equal(typeof payload.code, "string");
    assert.equal(typeof payload.message, "string");
    assert.equal(JSON.stringify(response).includes("fixture-secret"), false);
  },
);

test(
  "RPC wire error result becomes a coded local rejection",
  deadlockGuard,
  async (t) => {
    const transport = new ControlledTransport();
    const peer = new RpcPeer({ transport, generation });
    t.after(() => peer.close());
    const rejected = failure(peer.request("operation", null));
    const request = record(await transport.nextSent());
    transport.receive(
      envelope("error", field(request, "id"), {
        code: "OPERATION_DENIED",
        message: "Denied",
      }),
    );
    assert.deepEqual(await rejected, {
      code: "OPERATION_DENIED",
      message: "Denied",
    });
    assert.equal(peer.pendingCount, 0);
  },
);

test(
  "RPC abort rejects caller, aborts handler and ignores its late result",
  deadlockGuard,
  async (t) => {
    const [a, b] = createMemoryTransportPair();
    const entered = deferred<AbortSignal>();
    const aborted = deferred<void>();
    const finish = deferred<JsonValue>();
    const caller = new RpcPeer({ transport: a, generation });
    const server = new RpcPeer({
      transport: b,
      generation,
      handlers: {
        wait: async (_payload: JsonValue, signal: AbortSignal) => {
          signal.addEventListener("abort", () => aborted.resolve(), {
            once: true,
          });
          entered.resolve(signal);
          return finish.promise;
        },
        barrier: async () => "ready",
      },
    });
    t.after(() => caller.close());
    t.after(() => server.close());
    const controller = new AbortController();
    const rejected = failure(
      caller.request("wait", null, { signal: controller.signal }),
    );
    const signal = await entered.promise;
    controller.abort();
    await rejected;
    await aborted.promise;
    assert.equal(signal.aborted, true);
    assert.equal(caller.pendingCount, 0);
    finish.resolve({ stale: true });
    assert.equal(await caller.request("barrier", null), "ready");
    assert.equal(caller.pendingCount, 0);
  },
);

test(
  "RPC already-aborted requests send nothing and allocate no pending entry",
  deadlockGuard,
  async (t) => {
    const transport = new ControlledTransport();
    const peer = new RpcPeer({ transport, generation });
    t.after(() => peer.close());
    const controller = new AbortController();
    controller.abort();
    await failure(peer.request("never", null, { signal: controller.signal }));
    assert.equal(transport.sent.length, 0);
    assert.equal(peer.pendingCount, 0);
  },
);

test(
  "RPC local close rejects every pending request and rejects new admission",
  deadlockGuard,
  async () => {
    const transport = new ControlledTransport();
    const peer = new RpcPeer({ transport, generation });
    const failures = [
      failure(peer.request("one", null)),
      failure(peer.request("two", null)),
    ];
    assert.equal(peer.pendingCount, 2);
    peer.close();
    peer.close();
    await Promise.all(failures);
    assert.equal(peer.pendingCount, 0);
    const sentAtClose = transport.sent.length;
    await failure(peer.request("after.close", null));
    assert.equal(transport.sent.length, sentAtClose);
  },
);

test(
  "RPC transport close rejects pending callers and aborts running handlers",
  deadlockGuard,
  async (t) => {
    const transport = new ControlledTransport();
    const entered = deferred<AbortSignal>();
    const aborted = deferred<void>();
    const finish = deferred<JsonValue>();
    const peer = new RpcPeer({
      transport,
      generation,
      handlers: {
        wait: async (_payload: JsonValue, signal: AbortSignal) => {
          signal.addEventListener("abort", () => aborted.resolve(), {
            once: true,
          });
          entered.resolve(signal);
          return finish.promise;
        },
      },
    });
    t.after(() => peer.close());
    const pending = failure(peer.request("outbound", null));
    transport.receive(
      envelope("request", "running", { method: "wait", params: null }),
    );
    const signal = await entered.promise;
    transport.close();
    await pending;
    await aborted.promise;
    assert.equal(signal.aborted, true);
    assert.equal(peer.pendingCount, 0);
    finish.resolve(null);
  },
);

test(
  "RPC local close aborts inbound work without waiting for the handler",
  deadlockGuard,
  async () => {
    const transport = new ControlledTransport();
    const entered = deferred<AbortSignal>();
    const finish = deferred<JsonValue>();
    const peer = new RpcPeer({
      transport,
      generation,
      handlers: {
        wait: async (_payload: JsonValue, signal: AbortSignal) => {
          entered.resolve(signal);
          return finish.promise;
        },
      },
    });
    transport.receive(
      envelope("request", "close-work", { method: "wait", params: null }),
    );
    const signal = await entered.promise;
    peer.close();
    assert.equal(signal.aborted, true);
    finish.resolve(null);
  },
);

test(
  "RPC inbound cancel aborts the matching handler only",
  deadlockGuard,
  async (t) => {
    const transport = new ControlledTransport();
    const signals = new Map<string, AbortSignal>();
    const first = deferred<void>();
    const second = deferred<void>();
    const finish = deferred<JsonValue>();
    const peer = new RpcPeer({
      transport,
      generation,
      handlers: {
        wait: async (payload: JsonValue, signal: AbortSignal) => {
          assert.equal(typeof payload, "string");
          assert.ok(typeof payload === "string");
          signals.set(payload, signal);
          if (payload === "first") first.resolve();
          else second.resolve();
          return finish.promise;
        },
      },
    });
    t.after(() => peer.close());
    transport.receive(
      envelope("request", "first", { method: "wait", params: "first" }),
    );
    transport.receive(
      envelope("request", "second", { method: "wait", params: "second" }),
    );
    await Promise.all([first.promise, second.promise]);
    transport.receive(envelope("cancel", "first", null));
    assert.equal(signals.get("first")?.aborted, true);
    assert.equal(signals.get("second")?.aborted, false);
    transport.receive(envelope("cancel", "unknown", null));
    assert.equal(signals.get("second")?.aborted, false);
    finish.resolve(null);
  },
);

const malformedFrames: ReadonlyArray<readonly [string, JsonValue]> = [
  ["null", null],
  ["array", []],
  ["missing fields", {}],
  [
    "wrong version",
    {
      version: 2,
      generation,
      id: "bad",
      type: "request",
      payload: { method: "danger", params: null },
    },
  ],
  [
    "wrong generation",
    envelope(
      "request",
      "bad",
      { method: "danger", params: null },
      "old-generation",
    ),
  ],
  [
    "unknown type",
    {
      version: 1,
      generation,
      id: "bad",
      type: "execute",
      payload: { method: "danger", params: null },
    },
  ],
  [
    "object id",
    {
      version: 1,
      generation,
      id: {},
      type: "request",
      payload: { method: "danger", params: null },
    },
  ],
  ["missing params", envelope("request", "bad", { method: "danger" })],
  [
    "non-string method",
    envelope("request", "bad", { method: 3, params: null }),
  ],
  ["non-object request payload", envelope("request", "bad", "danger")],
  [
    "oversized envelope",
    envelope("request", "bad", {
      method: "danger",
      params: "x".repeat(256 * 1024),
    }),
  ],
];

for (const [name, frame] of malformedFrames) {
  test(
    `RPC rejects ${name} before dispatching a handler`,
    deadlockGuard,
    async (t) => {
      const transport = new ControlledTransport();
      let calls = 0;
      const peer = new RpcPeer({
        transport,
        generation,
        handlers: {
          danger: async () => {
            calls++;
            return null;
          },
        },
      });
      t.after(() => peer.close());
      transport.receive(frame);
      peer.close();
      assert.equal(calls, 0);
      assert.equal(peer.pendingCount, 0);
    },
  );
}

for (const [name, patch] of [
  ["old generation", { generation: "old-generation" }],
  ["future version", { version: 2 }],
  ["unknown type", { type: "surprise" }],
  ["missing payload", {}],
] satisfies ReadonlyArray<readonly [string, Record<string, JsonValue>]>) {
  test(
    `RPC ${name} cannot forge completion of a live request`,
    deadlockGuard,
    async (t) => {
      const transport = new ControlledTransport();
      const peer = new RpcPeer({ transport, generation });
      t.after(() => peer.close());
      const outcome = peer.request("work", null).then(
        (value: JsonValue) => ({ kind: "result" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const request = record(await transport.nextSent());
      const frame: Record<string, JsonValue> = {
        version: 1,
        generation,
        id: field(request, "id"),
        type: "result",
        ...patch,
      };
      if (name !== "missing payload") frame.payload = "forged";
      transport.receive(frame);
      // Both dropping the bad frame and closing fail-closed are valid policies.
      peer.close();
      assert.equal((await outcome).kind, "error");
    },
  );
}

for (const [name, payload] of [
  ["null", null],
  ["missing message", { code: "DENIED" }],
  ["non-string code", { code: 4, message: "Denied" }],
  ["non-string message", { code: "DENIED", message: {} }],
] satisfies ReadonlyArray<readonly [string, JsonValue]>) {
  test(
    `RPC malformed error payload (${name}) cannot masquerade as a result`,
    deadlockGuard,
    async (t) => {
      const transport = new ControlledTransport();
      const peer = new RpcPeer({ transport, generation });
      t.after(() => peer.close());
      const rejected = failure(peer.request("work", null));
      const request = record(await transport.nextSent());
      transport.receive(envelope("error", field(request, "id"), payload));
      peer.close();
      await rejected;
      assert.equal(peer.pendingCount, 0);
    },
  );
}

test(
  "RPC ignores unmatched and duplicate results without changing another request",
  deadlockGuard,
  async (t) => {
    const transport = new ControlledTransport();
    const peer = new RpcPeer({ transport, generation });
    t.after(() => peer.close());
    const first = peer.request("first", null);
    const firstFrame = record(await transport.nextSent());
    transport.receive(envelope("result", "unmatched", "wrong"));
    assert.equal(peer.pendingCount, 1);
    transport.receive(envelope("result", field(firstFrame, "id"), "first"));
    assert.equal(await first, "first");
    const second = peer.request("second", null);
    const secondFrame = record(await transport.nextSent());
    assert.notEqual(field(secondFrame, "id"), field(firstFrame, "id"));
    transport.receive(envelope("result", field(firstFrame, "id"), "duplicate"));
    assert.equal(peer.pendingCount, 1);
    transport.receive(envelope("result", field(secondFrame, "id"), "second"));
    assert.equal(await second, "second");
  },
);

test(
  "RPC validates outbound request and result byte budgets",
  deadlockGuard,
  async (t) => {
    const transport = new ControlledTransport();
    const peer = new RpcPeer({ transport, generation });
    t.after(() => peer.close());
    await failure(peer.request("large", "x".repeat(256 * 1024)));
    assert.equal(transport.sent.length, 0);
    assert.equal(peer.pendingCount, 0);

    const [a, b] = createMemoryTransportPair();
    const caller = new RpcPeer({ transport: a, generation });
    const server = new RpcPeer({
      transport: b,
      generation,
      handlers: { large: async () => "x".repeat(256 * 1024) },
    });
    t.after(() => caller.close());
    t.after(() => server.close());
    await failure(caller.request("large", null));
    assert.equal(caller.pendingCount, 0);
  },
);

test(
  "RPC transport send failure settles pending state without automatic retry",
  deadlockGuard,
  async (t) => {
    class FailedTransport extends ControlledTransport {
      attempts = 0;
      override async send(_message: JsonValue): Promise<void> {
        this.attempts++;
        throw new Error("fixture transport disconnected");
      }
    }
    const transport = new FailedTransport();
    const peer = new RpcPeer({ transport, generation });
    t.after(() => peer.close());
    await failure(peer.request("non-idempotent.create", null));
    assert.equal(transport.attempts, 1);
    assert.equal(peer.pendingCount, 0);
  },
);

test(
  "RPC maxPending rejects overflow and admits again after settlement",
  deadlockGuard,
  async (t) => {
    const transport = new ControlledTransport();
    const peer = new RpcPeer({ transport, generation, maxPending: 2 });
    t.after(() => peer.close());
    const first = peer.request("first", null);
    const firstFrame = record(await transport.nextSent());
    const second = peer.request("second", null);
    const secondFrame = record(await transport.nextSent());
    assert.equal(peer.pendingCount, 2);
    const overflow = await failure(peer.request("overflow", null));
    assert.equal(transport.sent.length, 2);
    assert.equal(peer.pendingCount, 2);
    assert.equal(
      (await failure(peer.request("overflow", null))).code,
      overflow.code,
    );
    transport.receive(envelope("result", field(firstFrame, "id"), 1));
    assert.equal(await first, 1);
    const third = peer.request("third", null);
    const thirdFrame = record(await transport.nextSent());
    transport.receive(envelope("result", field(thirdFrame, "id"), 3));
    transport.receive(envelope("result", field(secondFrame, "id"), 2));
    assert.deepEqual(await Promise.all([second, third]), [2, 3]);
    assert.equal(peer.pendingCount, 0);
  },
);

test(
  "RPC defaults to 64 outstanding requests without retrying overflow",
  deadlockGuard,
  async (t) => {
    const transport = new ControlledTransport();
    const peer = new RpcPeer({ transport, generation });
    t.after(() => peer.close());
    const pending: Array<ReturnType<typeof failure>> = [];
    for (let index = 0; index < 64; index++) {
      pending.push(failure(peer.request("blocked", index)));
    }
    assert.equal(peer.pendingCount, 64);
    await failure(peer.request("overflow", null));
    assert.equal(transport.sent.length, 64);
    peer.close();
    await Promise.all(pending);
    assert.equal(peer.pendingCount, 0);
  },
);

test(
  "RPC defaults to a 4 MiB queued-byte budget independently of maxPending",
  deadlockGuard,
  async (t) => {
    const gate = deferred<void>();
    const transport = new ControlledTransport(gate.promise);
    const peer = new RpcPeer({ transport, generation });
    t.after(() => {
      gate.resolve();
      peer.close();
    });
    const pending: Array<ReturnType<typeof failure>> = [];
    for (let index = 0; index < 20; index++) {
      pending.push(failure(peer.request("blocked", "x".repeat(205_000))));
    }
    assert.equal(peer.pendingCount, 20);
    await failure(peer.request("overflow", "x".repeat(205_000)));
    assert.equal(peer.pendingCount, 20);
    gate.resolve();
    peer.close();
    await Promise.all(pending);
    assert.equal(peer.pendingCount, 0);
  },
);

test(
  "RPC byte backpressure accounts for sends waiting on transport admission",
  deadlockGuard,
  async (t) => {
    const gate = deferred<void>();
    const transport = new ControlledTransport(gate.promise);
    const peer = new RpcPeer({ transport, generation, maxQueuedBytes: 1024 });
    t.after(() => {
      gate.resolve();
      peer.close();
    });
    const first = failure(peer.request("blocked", "x".repeat(600)));
    await transport.nextSent();
    await failure(peer.request("overflow", "x".repeat(600)));
    assert.equal(peer.pendingCount, 1);
    assert.equal(transport.sent.length, 1);
    gate.resolve();
    peer.close();
    await first;
    assert.equal(peer.pendingCount, 0);
  },
);
