import test from "node:test";
import assert from "node:assert/strict";
import { OperationJournal } from "../../src/host/operations.js";
import type { JsonValue } from "../../src/protocol/json.js";

function store() {
  const data = new Map<string, JsonValue>();
  const writes: JsonValue[] = [];
  return {
    data,
    writes,
    async get(key: string) {
      return structuredClone(data.get(key));
    },
    async set(key: string, value: JsonValue) {
      writes.push(structuredClone(value));
      data.set(key, structuredClone(value));
    },
  };
}
const operation = {
  id: "telegram:1:2:create",
  ownerEpoch: 3,
  kind: "create",
  replay: "never" as const,
};

test("operation is journaled before side effects and completed result deduplicates restart", async () => {
  const storage = store();
  let calls = 0;
  const journal = new OperationJournal({ store: storage });
  const task = async (): Promise<JsonValue> => {
    calls++;
    assert.equal(storage.writes.length, 1);
    return { sessionId: "created" };
  };
  assert.deepEqual(await journal.execute(operation, task), {
    sessionId: "created",
  });
  assert.equal(storage.writes.length, 2);
  const restarted = new OperationJournal({ store: storage });
  assert.deepEqual(await restarted.execute(operation, task), {
    sessionId: "created",
  });
  assert.equal(calls, 1);
});

test("concurrent duplicate operation requests share one mutation", async () => {
  const storage = store();
  const journal = new OperationJournal({ store: storage });
  const gate = Promise.withResolvers<JsonValue>();
  let calls = 0;
  const task = () => {
    calls++;
    return gate.promise;
  };
  const first = journal.execute(operation, task);
  const second = journal.execute(operation, task);
  gate.resolve("created");
  assert.deepEqual(await Promise.all([first, second]), ["created", "created"]);
  assert.equal(calls, 1);
});

test("uncertain create result is never automatically re-executed after restart", async () => {
  const storage = store();
  let calls = 0;
  const journal = new OperationJournal({ store: storage });
  await assert.rejects(
    journal.execute(operation, async () => {
      calls++;
      throw Error("lost acknowledgement");
    }),
    /lost acknowledgement/,
  );
  const restarted = new OperationJournal({ store: storage });
  await assert.rejects(
    restarted.execute(operation, async () => {
      calls++;
      return "duplicate";
    }),
    /uncertain/i,
  );
  assert.equal(calls, 1);
});

test("failed completion persistence keeps non-idempotent mutation uncertain", async () => {
  const storage = store();
  let writes = 0;
  let calls = 0;
  const failing = {
    get: storage.get,
    set: async (key: string, value: JsonValue) => {
      if (++writes === 2) throw Error("receipt unavailable");
      await storage.set(key, value);
    },
  };
  const journal = new OperationJournal({ store: failing });
  await assert.rejects(
    journal.execute(operation, async () => {
      calls++;
      return "created";
    }),
    /receipt unavailable/,
  );
  const restarted = new OperationJournal({ store: storage });
  await assert.rejects(
    restarted.execute(operation, async () => {
      calls++;
      return "duplicate";
    }),
    /uncertain/i,
  );
  assert.equal(calls, 1);
});

test("idempotent prompt may resume with original operation identity", async () => {
  const storage = store();
  let calls = 0;
  const prompt = {
    ...operation,
    kind: "prompt",
    id: "telegram:1:2",
    replay: "idempotent" as const,
  };
  await assert.rejects(
    new OperationJournal({ store: storage }).execute(prompt, async () => {
      calls++;
      throw Error("disconnect");
    }),
  );
  assert.equal(
    await new OperationJournal({ store: storage }).execute(prompt, async () => {
      calls++;
      return "accepted";
    }),
    "accepted",
  );
  assert.equal(calls, 2);
});

test("journal failure prevents admission and conflicts cannot reuse operation authority", async () => {
  let calls = 0;
  const failed = new OperationJournal({
    store: {
      get: async () => undefined,
      set: async () => {
        throw Error("not durable");
      },
    },
  });
  await assert.rejects(
    failed.execute(operation, async () => {
      calls++;
      return true;
    }),
    /not durable/,
  );
  assert.equal(calls, 0);
  const journal = new OperationJournal({ store: store() });
  await journal.execute(operation, async () => true);
  await assert.rejects(
    journal.execute({ ...operation, ownerEpoch: 4 }, async () => false),
    /conflict|epoch/i,
  );
  await assert.rejects(
    journal.execute({ ...operation, kind: "stop" }, async () => false),
    /conflict|kind/i,
  );
});
