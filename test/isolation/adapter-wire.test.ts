import test from "node:test";
import assert from "node:assert/strict";
import { TelegramAdapter } from "../../src/telegram/adapter.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const credential = { kind: "api-key", key: "123:fixture" };

test("adapter wire dispatch is allowlisted and retains chat scheduling", async () => {
  let time = 0;
  let reads = 0;
  const sends: number[] = [];
  const adapter = new TelegramAdapter({
    credentials: {
      readRecord: async () => {
        reads++;
        return credential;
      },
    },
    credentialKey: "bot",
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    createApi: () => ({
      sendMessage: async () => {
        sends.push(time);
        return {};
      },
    }),
  });
  for (const method of [
    "constructor",
    "toString",
    "request",
    "notAMethod",
    "logOut",
  ]) {
    await assert.rejects(
      adapter.callWire(method, {}),
      /Unsupported Telegram wire method/,
    );
  }
  assert.equal(reads, 0);
  await adapter.callWire("sendMessage", { chat_id: 1, text: "first" });
  await adapter.callWire("sendMessage", { chat_id: 1, text: "second" });
  assert.deepEqual(sends, [0, 1100]);
});

test("queued semaphore request reads rotated credentials only after admission", async () => {
  let token = "123:old-fixture";
  let reads = 0;
  const admitted: string[] = [];
  const pending = Array.from({ length: 5 }, () => deferred<unknown>());
  const ready = deferred<void>();
  const adapter = new TelegramAdapter({
    credentials: {
      readRecord: async () => {
        reads++;
        return { kind: "api-key", key: token };
      },
    },
    credentialKey: "bot",
    createApi: (key) => ({
      sendMessage: async () => {
        const index = admitted.length;
        admitted.push(key);
        if (admitted.length === 4) ready.resolve();
        return pending[index]?.promise;
      },
    }),
  });
  const sends = Array.from({ length: 5 }, (_, i) =>
    adapter.call("sendMessage", { chat_id: i + 1, text: "fixture" }),
  );
  await ready.promise;
  assert.equal(reads, 4);
  assert.equal(adapter.outboundWaiters.length, 1);
  token = "123:rotated-fixture";
  pending[0]?.resolve({});
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads, 5);
  assert.deepEqual(admitted, [
    "123:old-fixture",
    "123:old-fixture",
    "123:old-fixture",
    "123:old-fixture",
    "123:rotated-fixture",
  ]);
  for (const result of pending) result.resolve({});
  await Promise.all(sends);
  assert.equal(adapter.outboundActive, 0);
});

test("credentials revoked during cooldown prevent a queued network call and release slot", async () => {
  let record: typeof credential | undefined = credential;
  let reads = 0;
  let created = 0;
  const waiting = deferred<void>();
  const resume = deferred<void>();
  let time = 0;
  const adapter = new TelegramAdapter({
    credentials: {
      readRecord: async () => {
        reads++;
        return record;
      },
    },
    credentialKey: "bot",
    now: () => time,
    sleep: async (ms) => {
      waiting.resolve();
      await resume.promise;
      time += ms;
    },
    createApi: () => {
      created++;
      return { sendMessage: async () => ({}) };
    },
  });
  adapter.cooldownUntil = 1000;
  // request() bypasses the chat lane, but must still respect global cooldown.
  const request = adapter.request("sendMessage", {
    chat_id: 1,
    text: "fixture",
  });
  await waiting.promise;
  assert.equal(adapter.outboundActive, 1);
  assert.equal(reads, 0);
  record = undefined;
  resume.resolve();
  await assert.rejects(request, /credential is not configured/);
  assert.equal(reads, 1);
  assert.equal(created, 0);
  assert.equal(adapter.outboundActive, 0);
});
