import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeJson,
  encodeJson,
  ProtocolError,
  type JsonValue,
} from "../../src/protocol/json.js";
import { createMemoryTransportPair } from "../../src/protocol/memory.js";
import { deadlockGuard, deferred } from "./protocol-fixtures.js";

function protocolFailure(action: () => unknown): string {
  try {
    action();
  } catch (error: unknown) {
    assert.ok(error instanceof ProtocolError);
    assert.equal(typeof error.code, "string");
    assert.ok(error.code.length > 0);
    return error.code;
  }
  assert.fail("Expected a ProtocolError instead of JSON coercion");
}

function nested(depth: number): JsonValue {
  let value: JsonValue = null;
  for (let index = 0; index < depth; index++) value = [value];
  return value;
}

for (const [name, value] of [
  ["null", null],
  ["booleans", [true, false]],
  ["finite numbers", [0, -1, 1.25, Number.MAX_VALUE]],
  ["strings", ["", "中文 😀", '\u0000\n"\\']],
  ["nested plain objects", { values: [null, { ok: true }] }],
] satisfies ReadonlyArray<readonly [string, JsonValue]>) {
  test(`JSON roundtrips ${name} without coercion`, () => {
    assert.deepEqual(decodeJson(encodeJson(value)), value);
  });
}

test("JSON accepts null-prototype dictionaries without prototype pollution", () => {
  const dictionary = Object.create(null) as Record<string, JsonValue>;
  dictionary.answer = 42;
  dictionary.__proto__ = { polluted: true };
  const result = decodeJson(encodeJson(dictionary));
  assert.equal(
    encodeJson(result),
    '{"answer":42,"__proto__":{"polluted":true}}',
  );
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
});

class LiveSession {
  readonly id = "session";
  toJSON(): JsonValue {
    return { id: this.id };
  }
}

const invalidValues: ReadonlyArray<readonly [string, unknown]> = [
  ["undefined", undefined],
  ["undefined object field", { value: undefined }],
  ["undefined array entry", [undefined]],
  ["sparse array", new Array<null>(2)],
  ["function", () => null],
  ["function object field", { callback: () => null }],
  ["symbol", Symbol("not-json")],
  ["bigint", 1n],
  ["NaN", Number.NaN],
  ["positive infinity", Number.POSITIVE_INFINITY],
  ["negative infinity", Number.NEGATIVE_INFINITY],
  ["nested non-finite number", { value: [Number.NaN] }],
  ["class instance with toJSON", new LiveSession()],
  ["Buffer", Buffer.from("not wire bytes")],
  ["Error", new Error("private stack")],
  ["Date", new Date(0)],
  ["Map", new Map([["key", "value"]])],
  ["Set", new Set([1])],
  ["typed array", new Uint8Array([1, 2])],
  ["AbortSignal", new AbortController().signal],
  ["Promise", Promise.resolve(null)],
  ["custom prototype", Object.create({ inherited: true })],
];

for (const [name, value] of invalidValues) {
  test(`JSON rejects ${name} with a stable ProtocolError code`, () => {
    const firstCode = protocolFailure(() => encodeJson(value));
    assert.equal(
      protocolFailure(() => encodeJson(value)),
      firstCode,
    );
  });
}

test("JSON rejects nested live objects even if JSON.stringify would serialize them", () => {
  protocolFailure(() => encodeJson({ session: new LiveSession() }));
  protocolFailure(() => encodeJson([new AbortController().signal]));
});

test("JSON rejects object and array cycles, but accepts shared acyclic children", () => {
  const object: Record<string, unknown> = {};
  object.self = object;
  const array: unknown[] = [];
  array.push(array);
  protocolFailure(() => encodeJson(object));
  protocolFailure(() => encodeJson(array));
  const child = { value: 1 };
  assert.deepEqual(decodeJson(encodeJson({ left: child, right: child })), {
    left: { value: 1 },
    right: { value: 1 },
  });
});

test("JSON accepts nesting 32 and rejects nesting beyond 32 on both paths", () => {
  const accepted = nested(32);
  assert.deepEqual(decodeJson(encodeJson(accepted)), accepted);
  protocolFailure(() => encodeJson(nested(33)));
  protocolFailure(() => decodeJson(JSON.stringify(nested(33))));
});

for (const text of [
  "",
  "{",
  "undefined",
  "NaN",
  "Infinity",
  "[1,]",
  "{} trailing",
]) {
  test(`JSON decode rejects malformed text ${JSON.stringify(text)}`, () => {
    const firstCode = protocolFailure(() => decodeJson(text));
    assert.equal(
      protocolFailure(() => decodeJson(text)),
      firstCode,
    );
  });
}

test("JSON decode rejects numeric overflow rather than returning Infinity", () => {
  protocolFailure(() => decodeJson("1e400"));
  protocolFailure(() => decodeJson('{"nested":[-1e400]}'));
});

test("JSON byte limits count UTF-8 encoded bytes, including JSON quoting", () => {
  const text = '"😀é"';
  const exact = Buffer.byteLength(text, "utf8");
  assert.equal(exact, 8);
  assert.equal(encodeJson("😀é", exact), text);
  assert.equal(decodeJson(text, exact), "😀é");
  protocolFailure(() => encodeJson("😀é", exact - 1));
  protocolFailure(() => decodeJson(text, exact - 1));
  protocolFailure(() => decodeJson(` ${text}`, exact));
});

test("JSON enforces its default 256 KiB budget at the exact boundary", () => {
  const bytes = 256 * 1024;
  const fits = "x".repeat(bytes - 2);
  assert.equal(Buffer.byteLength(encodeJson(fits)), bytes);
  assert.equal(decodeJson(JSON.stringify(fits)), fits);
  protocolFailure(() => encodeJson(`${fits}x`));
  protocolFailure(() => decodeJson(JSON.stringify(`${fits}x`)));
});

test(
  "memory transport snapshots at send admission, not send completion",
  deadlockGuard,
  async (t) => {
    const [sender, receiver] = createMemoryTransportPair();
    t.after(() => sender.close());
    t.after(() => receiver.close());
    const delivered = deferred<JsonValue>();
    let sendReturned = false;
    receiver.onMessage((message: JsonValue) => {
      assert.equal(sendReturned, true, "delivery must not be reentrant");
      delivered.resolve(message);
    });
    const input = { nested: { value: 1 }, list: [1, 2] };
    const sending = sender.send(input);
    sendReturned = true;
    input.nested.value = 99;
    input.list.push(3);
    const message = await delivered.promise;
    await sending;
    assert.deepEqual(message, { nested: { value: 1 }, list: [1, 2] });
    assert.notEqual(message, input);
  },
);

test(
  "memory transport validates JSON instead of silently coercing non-finite numbers",
  deadlockGuard,
  async (t) => {
    const [sender, receiver] = createMemoryTransportPair();
    t.after(() => sender.close());
    t.after(() => receiver.close());
    let deliveries = 0;
    receiver.onMessage(() => deliveries++);
    await assert.rejects(sender.send({ value: Number.NaN }), ProtocolError);
    assert.equal(deliveries, 0);
  },
);

test(
  "memory transport message unsubscription takes effect before the next delivery",
  deadlockGuard,
  async (t) => {
    const [sender, receiver] = createMemoryTransportPair();
    t.after(() => sender.close());
    t.after(() => receiver.close());
    let detachedCalls = 0;
    const detach = receiver.onMessage(() => detachedCalls++);
    detach();
    detach();
    const delivered = deferred<JsonValue>();
    receiver.onMessage((message: JsonValue) => delivered.resolve(message));
    await sender.send("barrier");
    assert.equal(await delivered.promise, "barrier");
    assert.equal(detachedCalls, 0);
  },
);

test(
  "memory transport clones each send and both directions independently",
  deadlockGuard,
  async (t) => {
    const [left, right] = createMemoryTransportPair();
    t.after(() => left.close());
    t.after(() => right.close());
    const leftMessage = deferred<JsonValue>();
    const rightMessage = deferred<JsonValue>();
    left.onMessage((message: JsonValue) => leftMessage.resolve(message));
    right.onMessage((message: JsonValue) => rightMessage.resolve(message));
    const value = { child: { value: 1 } };
    const firstSend = left.send(value);
    value.child.value = 2;
    const secondSend = right.send(value);
    value.child.value = 3;
    assert.deepEqual(await rightMessage.promise, { child: { value: 1 } });
    assert.deepEqual(await leftMessage.promise, { child: { value: 2 } });
    await Promise.all([firstSend, secondSend]);
  },
);
