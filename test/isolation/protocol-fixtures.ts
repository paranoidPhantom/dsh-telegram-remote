import assert from "node:assert/strict";
import type { JsonValue } from "../../src/protocol/json.js";
import type { WireTransport } from "../../src/protocol/rpc.js";

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export interface Failure {
  code: string;
  message: string;
}

export async function failure(promise: Promise<unknown>): Promise<Failure> {
  try {
    await promise;
  } catch (error: unknown) {
    assert.ok(error instanceof Error, "RPC failures must be Error objects");
    assert.ok("code" in error, "RPC failures need a stable code");
    assert.equal(typeof error.code, "string");
    assert.ok(typeof error.code === "string" && error.code.length > 0);
    return { code: error.code, message: error.message };
  }
  assert.fail("Expected rejection");
}

export function record(value: JsonValue): Record<string, JsonValue> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value;
}

export function field(
  value: Record<string, JsonValue>,
  key: string,
): JsonValue {
  const member = value[key];
  assert.ok(member !== undefined, `Missing envelope field: ${key}`);
  return member;
}

export function envelope(
  type: "request" | "result" | "error" | "cancel",
  id: JsonValue,
  payload: JsonValue,
  generation = "test-generation",
): JsonValue {
  return { version: 1, generation, id, type, payload };
}

/** Explicit frames and send gates: no timers, polling, or implicit acknowledgements. */
export class ControlledTransport implements WireTransport {
  readonly sent: JsonValue[] = [];
  readonly #messages = new Set<(message: JsonValue) => void>();
  readonly #closes = new Set<() => void>();
  readonly #unread: JsonValue[] = [];
  readonly #readers: Array<ReturnType<typeof deferred<JsonValue>>> = [];
  readonly #sendGate: Promise<void> | undefined;
  #closed = false;

  constructor(sendGate?: Promise<void>) {
    this.#sendGate = sendGate;
  }

  async send(message: JsonValue): Promise<void> {
    if (this.#closed) throw new Error("Transport closed");
    this.sent.push(message);
    const reader = this.#readers.shift();
    if (reader) reader.resolve(message);
    else this.#unread.push(message);
    await this.#sendGate;
  }

  nextSent(): Promise<JsonValue> {
    const message = this.#unread.shift();
    if (message !== undefined) return Promise.resolve(message);
    const reader = deferred<JsonValue>();
    this.#readers.push(reader);
    return reader.promise;
  }

  onMessage(listener: (message: JsonValue) => void): () => void {
    this.#messages.add(listener);
    return () => this.#messages.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#closes.add(listener);
    return () => this.#closes.delete(listener);
  }

  receive(message: JsonValue): void {
    for (const listener of this.#messages) listener(message);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closes) listener();
  }
}

export const deadlockGuard = { timeout: 2_000 };
