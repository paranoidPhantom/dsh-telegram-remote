import assert from "node:assert/strict";
import test from "node:test";
import {
  UpdateIngress,
  type UpdateIngressOptions,
} from "../../src/child/ingress.js";
import { Inbox, type InboxEntry } from "../../src/host/inbox.js";
import { jsonObject, type JsonValue } from "../../src/protocol/json.js";

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function until(check: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("condition not reached");
}
function fixture(maxEntries = 20) {
  const records = new Map<string, JsonValue>();
  const inbox = new Inbox({
    store: {
      get: async (key) => records.get(key),
      set: async (key, value) => {
        records.set(key, structuredClone(value));
      },
    },
    maxEntries,
  });
  const controller = new AbortController();
  const updates: JsonValue[][] = [];
  const offsets: number[] = [];
  const errors: unknown[] = [];
  const handled: JsonValue[] = [];
  const options: UpdateIngressOptions = {
    api: {
      call: async (_method, params, signal) => {
        if (jsonObject(params) && typeof params.offset === "number")
          offsets.push(params.offset);
        const batch = updates.shift();
        if (batch) return batch;
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return [];
      },
    },
    admit: async (update) => {
      assert.ok(jsonObject(update));
      assert.equal(typeof update.update_id, "number");
      return inbox.admit({
        updateId: Number(update.update_id),
        ownerEpoch: 1,
        operation: update,
      });
    },
    getOffset: () => inbox.offset(),
    pending: () => inbox.pending(),
    settle: (entry, outcome) =>
      inbox.settle(entry.updateId, entry.ownerEpoch, outcome),
    handle: async (operation) => {
      handled.push(operation);
    },
    classify: (operation) => ({
      key: jsonObject(operation) ? String(operation.topic) : "unknown",
      priority: jsonObject(operation) && operation.stop === true,
    }),
    signal: controller.signal,
    onError: (error) => {
      errors.push(error);
    },
    maxActive: 1,
    retryMs: 2,
  };
  return { inbox, controller, updates, offsets, errors, handled, options };
}
const update = (id: number, topic = "a", stop = false): JsonValue => ({
  update_id: id,
  topic,
  stop,
  requestId: `original-${id}`,
});

test("slow normal handler does not block polling or later same-topic priority Stop; no callback pre-ack", async () => {
  const f = fixture();
  const blocked = gate();
  f.updates.push([update(1)], [update(2, "a", true)]);
  f.options.handle = async (operation) => {
    f.handled.push(operation);
    if (jsonObject(operation) && operation.update_id === 1)
      await blocked.promise;
  };
  const running = new UpdateIngress(f.options).run();
  await until(() => f.handled.length === 2);
  assert.deepEqual(f.handled, [update(1), update(2, "a", true)]);
  assert.ok(f.offsets.includes(2));
  f.controller.abort();
  await running;
  blocked.release();
});

test("normal work stays topic ordered and bounded; replay refills without copying a queue", async () => {
  const f = fixture();
  const blocked = gate();
  for (let id = 1; id <= 5; id++) await f.options.admit(update(id));
  f.options.maxActive = 2;
  f.options.handle = async (operation) => {
    f.handled.push(operation);
    if (jsonObject(operation) && operation.update_id === 1)
      await blocked.promise;
  };
  const running = new UpdateIngress(f.options).run();
  await until(() => f.handled.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.handled.length, 1);
  blocked.release();
  await until(() => f.handled.length === 5);
  assert.deepEqual(
    f.handled,
    Array.from({ length: 5 }, (_, n) => update(n + 1)),
  );
  f.controller.abort();
  await running;
});

test("capacity failure does not acknowledge overflow or admit later batch entries", async () => {
  const f = fixture(1);
  const blocked = gate();
  f.updates.push([update(1), update(2), update(3)]);
  f.options.handle = async () => blocked.promise;
  const running = new UpdateIngress(f.options).run();
  await until(() => f.errors.length > 0);
  assert.equal(await f.inbox.offset(), 2);
  assert.deepEqual(
    (await f.inbox.pending()).map((entry) => entry.updateId),
    [1],
  );
  f.controller.abort();
  await running;
  blocked.release();
});

test("abort interrupts outstanding getUpdates and never starts replay after cancellation", async () => {
  const f = fixture();
  const running = new UpdateIngress(f.options).run();
  await until(() => f.offsets.length > 0);
  f.controller.abort();
  await running;
  assert.deepEqual(f.handled, []);
});

test("handler failure is durably failed and not hot replayed", async () => {
  const f = fixture();
  await f.options.admit(update(1));
  let calls = 0;
  f.options.handle = async () => {
    calls++;
    throw new Error("handler failed");
  };
  const running = new UpdateIngress(f.options).run();
  await until(() => f.errors.length === 1);
  await until(() => calls === 1);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(calls, 1);
  assert.deepEqual(await f.inbox.pending(), []);
  f.controller.abort();
  await running;
});

test("settlement failure stops dispatch instead of re-executing ambiguous work", async () => {
  const f = fixture();
  await f.options.admit(update(1));
  let calls = 0;
  f.options.handle = async () => {
    calls++;
  };
  f.options.settle = async (_entry: InboxEntry) => {
    throw new Error("storage unavailable");
  };
  const running = new UpdateIngress(f.options).run();
  await until(() => f.errors.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(calls, 1);
  f.controller.abort();
  await running;
});
