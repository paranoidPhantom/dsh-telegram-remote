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

test("classifier failure settles failed exactly once and does not block later good entries", async () => {
  const f = fixture();
  for (let id = 1; id <= 3; id++) await f.options.admit(update(id));
  const classify = f.options.classify;
  const settle = f.options.settle;
  const classificationError = new Error("invalid operation");
  const settlements: Array<[number, string]> = [];
  let badClassifications = 0;
  f.options.classify = (operation) => {
    if (jsonObject(operation) && operation.update_id === 1) {
      badClassifications++;
      throw classificationError;
    }
    return classify(operation);
  };
  f.options.settle = async (entry, outcome) => {
    settlements.push([entry.updateId, outcome]);
    await settle(entry, outcome);
  };
  const ingress = new UpdateIngress(f.options);
  const running = ingress.run();
  try {
    await until(() => settlements.length === 3);
    await until(() => ingress.diagnostics().active === 0);
    assert.deepEqual(f.handled, [update(2), update(3)]);
    assert.deepEqual(settlements, [
      [1, "failed"],
      [2, "completed"],
      [3, "completed"],
    ]);
    assert.equal(badClassifications, 1);
    assert.deepEqual(f.errors, [classificationError]);
    assert.equal(ingress.diagnostics().errorCount, 1);
    assert.deepEqual(await f.inbox.pending(), []);
  } finally {
    f.controller.abort();
    await running;
    await ingress.drain();
  }
});

test("classifier failure settlement owns a bounded slot and remains tracked through abort and drain", async () => {
  const f = fixture();
  for (let id = 1; id <= 3; id++) await f.options.admit(update(id));
  const blocked = gate();
  const settle = f.options.settle;
  const settlements: Array<[number, string]> = [];
  f.options.classify = () => {
    throw new Error("invalid operation");
  };
  f.options.settle = async (entry, outcome) => {
    settlements.push([entry.updateId, outcome]);
    await blocked.promise;
    await settle(entry, outcome);
  };
  const ingress = new UpdateIngress(f.options);
  const running = ingress.run();
  try {
    await until(() => settlements.length === 1);
    // Observe multiple refills while settlement is blocked.
    let scans = 0;
    const pending = f.options.pending;
    f.options.pending = async () => {
      scans++;
      return pending();
    };
    await until(() => scans >= 3);
    assert.equal(ingress.diagnostics().active, 1);
    assert.equal(ingress.diagnostics().normalActive, 1);
    assert.deepEqual(settlements, [[1, "failed"]]);
    assert.deepEqual(f.handled, []);
    f.controller.abort();
    await running;
    let drained = false;
    const draining = ingress.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    assert.equal(drained, false);
    blocked.release();
    await draining;
    assert.deepEqual(settlements, [[1, "failed"]]);
    assert.equal(ingress.diagnostics().active, 0);
  } finally {
    f.controller.abort();
    blocked.release();
    await running;
    await ingress.drain();
  }
});

test("classifier failure settlement failure halts ingress without replay or handler execution", async () => {
  const f = fixture();
  await f.options.admit(update(1));
  await f.options.admit(update(2));
  const classify = f.options.classify;
  const classificationError = new Error("invalid operation");
  const settlementError = new Error("storage unavailable");
  const settlements: Array<[number, string]> = [];
  f.options.classify = (operation) => {
    if (jsonObject(operation) && operation.update_id === 1)
      throw classificationError;
    return classify(operation);
  };
  f.options.settle = async (entry, outcome) => {
    settlements.push([entry.updateId, outcome]);
    throw settlementError;
  };
  const ingress = new UpdateIngress(f.options);
  const running = ingress.run();
  try {
    // A settlement failure must stop polling too, without external abort.
    await running;
    await ingress.drain();
    assert.equal(ingress.diagnostics().halted, true);
    assert.deepEqual(f.errors, [classificationError, settlementError]);
    assert.equal(ingress.diagnostics().errorCount, 2);
    assert.deepEqual(settlements, [[1, "failed"]]);
    assert.deepEqual(f.handled, []);
    assert.deepEqual(
      (await f.inbox.pending()).map((entry) => entry.updateId),
      [1, 2],
    );
  } finally {
    f.controller.abort();
    await running;
    await ingress.drain();
  }
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
