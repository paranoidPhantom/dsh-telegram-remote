import assert from "node:assert/strict";
import test from "node:test";
import { Inbox } from "../../src/host/inbox.js";
import type { JsonValue } from "../../src/protocol/json.js";

type Write = { key: string; value: JsonValue };
type StoreHook = (write: Write, ordinal: number) => Promise<void>;

function gate() {
  let release: () => void = () => {
    throw new Error("gate not initialized");
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// Reads, writes and reopen all cross a serialization boundary. Tests must not
// pass just because an implementation mutates an object retained by the store.
class CloneStore {
  private readonly records = new Map<string, JsonValue>();
  readonly writes: Write[] = [];
  beforeSet: StoreHook | undefined;
  afterSet: StoreHook | undefined;
  attempts = 0;

  async get(key: string): Promise<JsonValue | undefined> {
    const value = this.records.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async set(key: string, value: JsonValue): Promise<void> {
    const write = { key, value: structuredClone(value) };
    const ordinal = ++this.attempts;
    await this.beforeSet?.(write, ordinal);
    this.records.set(key, structuredClone(write.value));
    this.writes.push(structuredClone(write));
    await this.afterSet?.(write, ordinal);
  }

  clone(): CloneStore {
    const copy = new CloneStore();
    for (const [key, value] of this.records) {
      copy.records.set(key, structuredClone(value));
    }
    return copy;
  }
}

function admission(updateId = 101, ownerEpoch = 3) {
  return {
    updateId,
    ownerEpoch,
    operation: {
      kind: "prompt",
      sessionId: "session-a",
      text: `inbox-operation-${updateId}`,
    },
  };
}

type AdmissionSnapshot = {
  updateId: number;
  ownerEpoch: number;
  operation: JsonValue;
};

async function pendingAdmissions(inbox: Inbox): Promise<AdmissionSnapshot[]> {
  // InboxEntry may add journal/status metadata; only the public admission
  // identity and original operation are fixed by this API blueprint.
  return (await inbox.pending()).map((entry: AdmissionSnapshot) => ({
    updateId: entry.updateId,
    ownerEpoch: entry.ownerEpoch,
    operation: entry.operation,
  }));
}

async function observesRejection(promise: Promise<unknown>) {
  // Attach immediately: concurrent admission may reject before a gate releases.
  return promise.then(
    () => false,
    () => true,
  );
}

test("inbox persists the operation before any recovered offset may acknowledge it", async () => {
  const store = new CloneStore();
  const input = admission();
  let inspectedWrites = 0;
  store.afterSet = async () => {
    inspectedWrites++;
    const recovered = new Inbox({ store: store.clone() });
    if ((await recovered.offset()) > input.updateId) {
      assert.deepEqual(await pendingAdmissions(recovered), [input]);
    }
  };
  const inbox = new Inbox({ store });
  assert.equal(await inbox.admit(input), "admitted");
  assert.ok(inspectedWrites > 0);
  assert.equal(await inbox.offset(), input.updateId + 1);
  assert.deepEqual(await pendingAdmissions(inbox), [input]);
  const recovered = new Inbox({ store: store.clone() });
  assert.equal(await recovered.offset(), input.updateId + 1);
  assert.deepEqual(await pendingAdmissions(recovered), [input]);
});

test("inbox deduplicates identical identity before and after settlement and recovery", async () => {
  const store = new CloneStore();
  const input = admission();
  const inbox = new Inbox({ store });
  assert.equal(await inbox.admit(input), "admitted");
  assert.equal(await inbox.admit(structuredClone(input)), "duplicate");
  assert.deepEqual(await pendingAdmissions(inbox), [input]);
  const offset = await inbox.offset();
  await inbox.settle(input.updateId, input.ownerEpoch, "completed");
  assert.deepEqual(await pendingAdmissions(inbox), []);
  assert.equal(await inbox.admit(input), "duplicate");
  assert.equal(await inbox.offset(), offset);
  const recovered = new Inbox({ store: store.clone() });
  assert.equal(await recovered.admit(input), "duplicate");
  assert.deepEqual(await pendingAdmissions(recovered), []);
  assert.equal(await recovered.offset(), offset);
});

test("same update ID with a conflicting operation or owner epoch is rejected", async () => {
  const inbox = new Inbox({ store: new CloneStore() });
  const input = admission();
  await inbox.admit(input);
  const offset = await inbox.offset();
  await assert.rejects(
    inbox.admit({
      ...input,
      operation: { ...input.operation, text: "different action" },
    }),
  );
  await assert.rejects(inbox.admit({ ...input, ownerEpoch: 4 }));
  assert.equal(await inbox.offset(), offset);
  assert.deepEqual(await pendingAdmissions(inbox), [input]);
});

for (const outcome of ["completed", "failed", "uncertain"] as const) {
  test(`settled ${outcome} records are not pending or replayed on reopening`, async () => {
    const store = new CloneStore();
    const input = admission();
    const inbox = new Inbox({ store });
    await inbox.admit(input);
    await inbox.settle(input.updateId, input.ownerEpoch, outcome);
    assert.deepEqual(await pendingAdmissions(inbox), []);
    const recovered = new Inbox({ store: store.clone() });
    assert.deepEqual(await pendingAdmissions(recovered), []);
    assert.equal(await recovered.admit(input), "duplicate");
    assert.equal(await recovered.offset(), input.updateId + 1);
  });
}

test("entry capacity rejects overflow without advancing offset and settlement frees capacity", async () => {
  const store = new CloneStore();
  const inbox = new Inbox({ store, maxEntries: 2 });
  const first = admission(101);
  const second = admission(102);
  const third = admission(103);
  await inbox.admit(first);
  await inbox.admit(second);
  const fullOffset = await inbox.offset();
  assert.equal(await inbox.admit(first), "duplicate");
  await assert.rejects(inbox.admit(third));
  assert.equal(await inbox.offset(), fullOffset);
  assert.deepEqual(await pendingAdmissions(inbox), [first, second]);
  const full = new Inbox({ store: store.clone(), maxEntries: 2 });
  await assert.rejects(full.admit(third));
  assert.equal(await full.offset(), fullOffset);
  await inbox.settle(first.updateId, first.ownerEpoch, "completed");
  assert.equal(await inbox.admit(third), "admitted");
  assert.deepEqual(await pendingAdmissions(inbox), [second, third]);
  assert.equal(await inbox.admit(first), "duplicate");
});

test("byte capacity rejects an oversized operation without storage writes or offset advance", async () => {
  const store = new CloneStore();
  const inbox = new Inbox({ store, maxBytes: 4_096 });
  const beforeOffset = await inbox.offset();
  const beforeWrites = store.writes.length;
  await assert.rejects(
    inbox.admit({
      ...admission(),
      operation: { kind: "prompt", text: "x".repeat(8_192) },
    }),
  );
  assert.equal(await inbox.offset(), beforeOffset);
  assert.equal(store.writes.length, beforeWrites);
  assert.deepEqual(await pendingAdmissions(inbox), []);
  assert.equal(await inbox.admit(admission()), "admitted");
});

test("byte capacity is aggregate across unresolved entries, not only a per-operation limit", async () => {
  const store = new CloneStore();
  const inbox = new Inbox({ store, maxEntries: 100, maxBytes: 4_096 });
  const admitted: ReturnType<typeof admission>[] = [];
  let overflowed = false;
  for (let index = 0; index < 32; index++) {
    const input = admission(101 + index);
    input.operation.text = `${index}:` + "x".repeat(700);
    const offsetBefore = await inbox.offset();
    try {
      await inbox.admit(input);
      admitted.push(input);
    } catch (error: unknown) {
      assert.ok(error instanceof Error);
      overflowed = true;
      assert.equal(await inbox.offset(), offsetBefore);
      break;
    }
  }
  assert.ok(admitted.length > 0, "at least one operation fits the byte budget");
  assert.equal(overflowed, true, "unresolved bytes must have a finite bound");
  assert.deepEqual(await pendingAdmissions(inbox), admitted);
});

test("failure of each admission write never acknowledges the failed update", async () => {
  const input = admission();
  const probeStore = new CloneStore();
  await new Inbox({ store: probeStore }).admit(input);
  assert.ok(probeStore.attempts > 0);

  for (
    let failedOrdinal = 1;
    failedOrdinal <= probeStore.attempts;
    failedOrdinal++
  ) {
    const store = new CloneStore();
    const inbox = new Inbox({ store });
    const offsetBefore = await inbox.offset();
    store.beforeSet = async (_write, ordinal) => {
      if (ordinal === failedOrdinal)
        throw new Error("injected storage failure");
    };
    await assert.rejects(inbox.admit(input), /injected storage failure/);
    assert.equal(await inbox.offset(), offsetBefore);
    const recovered = new Inbox({ store: store.clone() });
    assert.equal(await recovered.offset(), offsetBefore);
    // An entry may already be durable when a separate cursor write fails. It
    // must either be absent or recoverable, never silently acknowledged/lost.
    const pending = await pendingAdmissions(recovered);
    assert.ok(pending.length === 0 || pending.length === 1);
    if (pending.length === 1) assert.deepEqual(pending, [input]);
  }
});

test("storage read failure fails admission before any write and leaves recovery empty", async () => {
  const store = new CloneStore();
  const failingStore = {
    get: async (_key: string): Promise<JsonValue | undefined> => {
      throw new Error("injected read failure");
    },
    set: (key: string, value: JsonValue) => store.set(key, value),
  };
  const inbox = new Inbox({ store: failingStore });
  await assert.rejects(inbox.admit(admission()), /injected read failure/);
  assert.equal(store.writes.length, 0);
  const recovered = new Inbox({ store: store.clone() });
  assert.deepEqual(await pendingAdmissions(recovered), []);
  assert.ok((await recovered.offset()) <= admission().updateId);
});

test("a failed write does not poison subsequent serialized admission", async () => {
  const store = new CloneStore();
  const inbox = new Inbox({ store });
  const offsetBefore = await inbox.offset();
  store.beforeSet = async () => {
    throw new Error("injected write failure");
  };
  await assert.rejects(inbox.admit(admission()), /injected write failure/);
  assert.equal(await inbox.offset(), offsetBefore);
  store.beforeSet = undefined;
  assert.equal(await inbox.admit(admission()), "admitted");
  assert.equal(await inbox.offset(), 102);
  assert.deepEqual(await pendingAdmissions(inbox), [admission()]);
});

test("concurrent duplicate admissions serialize behind the first durable write", async () => {
  const store = new CloneStore();
  const entered = gate();
  const released = gate();
  store.beforeSet = async (_write, ordinal) => {
    if (ordinal === 1) {
      entered.release();
      await released.promise;
    }
  };
  const inbox = new Inbox({ store });
  const first = inbox.admit(admission());
  await entered.promise;
  const second = inbox.admit(admission());
  let secondSettled = false;
  void second.then(
    () => {
      secondSettled = true;
    },
    () => {
      secondSettled = true;
    },
  );
  await Promise.resolve();
  assert.equal(store.attempts, 1);
  assert.equal(secondSettled, false);
  released.release();
  assert.deepEqual(await Promise.all([first, second]), [
    "admitted",
    "duplicate",
  ]);
  assert.deepEqual(await pendingAdmissions(inbox), [admission()]);
});

test("concurrent unique admissions cannot overbook capacity", async () => {
  const store = new CloneStore();
  const entered = gate();
  const released = gate();
  store.beforeSet = async (_write, ordinal) => {
    if (ordinal === 1) {
      entered.release();
      await released.promise;
    }
  };
  const inbox = new Inbox({ store, maxEntries: 1 });
  const first = inbox.admit(admission(101));
  await entered.promise;
  const secondRejected = observesRejection(inbox.admit(admission(102)));
  await Promise.resolve();
  assert.equal(store.attempts, 1);
  released.release();
  assert.equal(await first, "admitted");
  assert.equal(await secondRejected, true);
  assert.equal(await inbox.offset(), 102);
  assert.deepEqual(await pendingAdmissions(inbox), [admission(101)]);
});

test("concurrent out-of-order admissions cannot regress the persisted offset", async () => {
  const store = new CloneStore();
  const inbox = new Inbox({ store });
  const inputs = [admission(103), admission(101), admission(102)];
  assert.deepEqual(
    await Promise.all(inputs.map((input) => inbox.admit(input))),
    ["admitted", "admitted", "admitted"],
  );
  assert.equal(await inbox.offset(), 104);
  const recovered = new Inbox({ store: store.clone() });
  assert.equal(await recovered.offset(), 104);
  const pending = await pendingAdmissions(recovered);
  assert.equal(pending.length, inputs.length);
  for (const input of inputs)
    assert.ok(pending.some((entry) => entry.updateId === input.updateId));
});

test("a stale epoch cannot settle or replace a current-epoch operation after recovery", async () => {
  const store = new CloneStore();
  const input = admission(101, 4);
  await new Inbox({ store }).admit(input);
  const recovered = new Inbox({ store: store.clone() });
  const offset = await recovered.offset();
  await assert.rejects(recovered.settle(input.updateId, 3, "completed"));
  await assert.rejects(recovered.admit({ ...input, ownerEpoch: 3 }));
  assert.equal(await recovered.offset(), offset);
  assert.deepEqual(await pendingAdmissions(recovered), [input]);
  await recovered.settle(input.updateId, input.ownerEpoch, "completed");
  assert.deepEqual(await pendingAdmissions(recovered), []);
});

test("inbox snapshots admitted operations and never exposes mutable storage aliases", async () => {
  const store = new CloneStore();
  const input = admission();
  const expected = structuredClone(input);
  const inbox = new Inbox({ store });
  await inbox.admit(input);
  input.operation.text = "mutated caller object";
  assert.deepEqual(await pendingAdmissions(inbox), [expected]);
  const view = await pendingAdmissions(inbox);
  view.splice(0, view.length);
  assert.deepEqual(await pendingAdmissions(inbox), [expected]);
  const recovered = new Inbox({ store: store.clone() });
  assert.deepEqual(await pendingAdmissions(recovered), [expected]);
});
