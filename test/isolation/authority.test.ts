import test from "node:test";
import assert from "node:assert/strict";
import { HostAuthority } from "../../src/host/authority.js";
import { ApprovalRegistry } from "../../src/host/approvals.js";
import { ResourceRegistry } from "../../src/host/resources.js";
import type { ConsoleBridge } from "../../src/bot/contracts.js";
import type { JsonValue } from "../../src/protocol/json.js";

function fixture() {
  const rows = new Map<string, JsonValue>([
    ["console:topic:s", { chatId: 7, threadId: 9 }],
  ]);
  let calls = 0;
  const bridge: ConsoleBridge = {
    workspaces: async () => [],
    list: async () => [],
    metadata: async () => ({}),
    models: async () => [],
    newSessionSelection: async () => null,
    create: async () => {
      calls++;
      return "new";
    },
    selectModel: async () => ({}),
    prompt: async () => {
      calls++;
      return true;
    },
    steerQueued: async () => ({ accepted: true }),
    stop: async () => {
      calls++;
    },
    details: async () => "",
    files: async () => [],
    fileForTurn: async () => ({ name: "x", content: new Uint8Array() }),
  };
  const store = {
    get: async (key: string) => rows.get(key),
    set: async (key: string, value: JsonValue) => {
      rows.set(key, value);
    },
    entries: async () => rows.entries(),
  };
  const options = {
    bridge,
    store,
    credentials: {
      readRecord: async () => ({ kind: "api-key", key: "fixture-secret" }),
    },
    credentialKey: "telegram-console/bot",
    ownerId: 7,
    ownerEpoch: 1,
    generation: "g1",
    approvals: new ApprovalRegistry(),
    resources: new ResourceRegistry(),
  };
  const authority = new HostAuthority(options);
  const actor = { ownerId: 7, chatId: 7, threadId: 9, privateChat: true };
  const invoke = (name: string, payload: JsonValue) => {
    const handler = authority.handlers()[name];
    assert.ok(handler);
    return handler(payload, new AbortController().signal);
  };
  return { authority, options, actor, invoke, rows, calls: () => calls };
}

test("authority fences forged epoch, actor and topic before bridge mutation", async () => {
  const f = fixture();
  for (const payload of [
    { ownerEpoch: 0, actor: f.actor, id: "s", operationId: "a" },
    {
      ownerEpoch: 1,
      actor: { ...f.actor, ownerId: 8 },
      id: "s",
      operationId: "a",
    },
    {
      ownerEpoch: 1,
      actor: { ...f.actor, threadId: 8 },
      id: "s",
      operationId: "a",
    },
  ])
    await assert.rejects(f.invoke("bridge.stop", payload));
  assert.equal(f.calls(), 0);
});
test("create is confirmed and journaled, recovered running create stays uncertain", async () => {
  const f = fixture();
  const p = {
    ownerEpoch: 1,
    actor: f.actor,
    confirmed: true,
    operationId: "create-1",
  };
  assert.equal(await f.invoke("bridge.create", p), "new");
  assert.equal(await f.invoke("bridge.create", p), "new");
  assert.equal(f.calls(), 1);
  await assert.rejects(
    f.invoke("bridge.create", { ...p, confirmed: false, operationId: "other" }),
  );
  const key = "console:operation:create-1";
  const record = f.rows.get(key);
  assert.ok(record && typeof record === "object" && !Array.isArray(record));
  f.rows.set(key, { ...record, state: "running" });
  const restored = new HostAuthority(f.options);
  const handler = restored.handlers()["bridge.create"];
  assert.ok(handler);
  await assert.rejects(handler(p, new AbortController().signal), /uncertain/i);
  assert.equal(f.calls(), 1);
});
test("storage namespace never exposes settings, credentials or operation journal", async () => {
  const f = fixture();
  for (const namespace of ["settings", "credentials", "operation"])
    await assert.rejects(
      f.invoke("storage.namespace", {
        ownerEpoch: 1,
        actor: f.actor,
        action: "get",
        namespace,
        key: "secret",
      }),
    );
  assert.equal(f.authority.handlers()["store.get"], undefined);
});
test("prompt reuses original request and rejects changed payload identity", async () => {
  const f = fixture();
  const p = {
    ownerEpoch: 1,
    actor: f.actor,
    id: "s",
    requestId: "original",
    text: "hello",
  };
  await f.invoke("bridge.prompt", p);
  await f.invoke("bridge.prompt", p);
  assert.equal(f.calls(), 1);
  await assert.rejects(f.invoke("bridge.prompt", { ...p, text: "changed" }));
  assert.equal(f.calls(), 1);
});
test("storage uses full allowlisted keys and rejects wrong topic writes", async () => {
  const f = fixture();
  await f.invoke("storage.namespace", {
    ownerEpoch: 1,
    generation: "g1",
    namespace: "run",
    action: "set",
    key: "console:run:s:1",
    value: { chatId: 7, threadId: 9 },
  });
  await assert.rejects(
    f.invoke("storage.namespace", {
      ownerEpoch: 1,
      actor: f.actor,
      namespace: "topic",
      action: "set",
      key: "settings:adminUserId",
      value: 8,
    }),
  );
  await assert.rejects(
    f.invoke("storage.namespace", {
      ownerEpoch: 1,
      actor: f.actor,
      namespace: "topic",
      action: "set",
      key: "console:topic:s",
      value: { chatId: 8, threadId: 9 },
    }),
  );
});
test("background storage fences generation and owner-scopes keys and rows", async () => {
  const f = fixture();
  const p = {
    ownerEpoch: 1,
    generation: "g1",
    namespace: "run",
    action: "set",
    key: "console:run:s:2",
    value: { chatId: 7, threadId: 22 },
  };
  await f.invoke("storage.namespace", p);
  await assert.rejects(
    f.invoke("storage.namespace", { ...p, generation: "old" }),
  );
  await assert.rejects(
    f.invoke("storage.namespace", { ...p, value: { chatId: 8, threadId: 22 } }),
  );
  await assert.rejects(
    f.invoke("storage.namespace", {
      ...p,
      namespace: "poll",
      key: "poll-offset",
      value: 1,
    }),
  );
  await f.invoke("storage.namespace", {
    ...p,
    namespace: "controls",
    key: "console:controls:7:22",
    value: 1,
  });
  await assert.rejects(
    f.invoke("storage.namespace", {
      ...p,
      namespace: "controls",
      key: "console:controls:8:22",
      value: 1,
    }),
  );
  await f.invoke("storage.namespace", {
    ...p,
    namespace: "widget",
    key: 'widget:["7","22","x"]',
    value: {},
  });
  await assert.rejects(
    f.invoke("storage.namespace", {
      ...p,
      namespace: "widget",
      key: 'widget:["8","22","x"]',
      value: {},
    }),
  );
});
test("file batch capacity failure rolls back only its allocations immediately", async () => {
  const f = fixture();
  const retained = f.options.resources.add({
    generation: "g1",
    ownerEpoch: 1,
    name: "retained",
    bytes: Buffer.from("kept"),
  });
  const content = new Uint8Array(8 * 1024 * 1024);
  f.options.bridge.files = async () =>
    ["a", "b", "c"].map((name) => ({ name, content }));
  const payload = { ownerEpoch: 1, actor: f.actor, id: "s" };
  await assert.rejects(f.invoke("bridge.files", payload), /budget/i);
  f.options.bridge.files = async () => [{ name: "single", content }];
  const result = await f.invoke("bridge.files", payload);
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
  const descriptor = result[0];
  assert.ok(
    descriptor && typeof descriptor === "object" && !Array.isArray(descriptor),
  );
  assert.equal(descriptor.name, "single");
  assert.equal(descriptor.size, content.length);
  assert.equal(typeof descriptor.id, "string");
  const second = await f.invoke("bridge.files", payload);
  assert.ok(Array.isArray(second));
  assert.equal(second.length, 1);
  assert.equal(
    f.options.resources.read({
      ...retained,
      generation: "g1",
      ownerEpoch: 1,
      offset: 0,
      length: 4,
    }).data,
    Buffer.from("kept").toString("base64"),
  );
});

test("credentials require current generation and closed services are fenced", async () => {
  const f = fixture();
  await assert.rejects(
    f.invoke("credentials.read", { ownerEpoch: 1, generation: "old" }),
  );
  assert.deepEqual(
    await f.invoke("credentials.read", { ownerEpoch: 1, generation: "g1" }),
    { token: "fixture-secret" },
  );
  f.authority.close();
  await assert.rejects(
    f.invoke("credentials.read", { ownerEpoch: 1, generation: "g1" }),
  );
});

test("workspace catalog and creation remain owner-fenced and registered-ID only", async () => {
  const f = fixture();
  f.options.bridge.workspaces = async () => [
    { id: "registered", title: "Project", path: "/workspace" },
  ];
  let selected: string | undefined;
  f.options.bridge.create = async (workspaceId) => {
    selected = workspaceId;
    return "new";
  };
  const p = {
    ownerEpoch: 1,
    actor: f.actor,
    confirmed: true,
    operationId: "workspace-create",
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(await f.invoke("bridge.workspaces", p))),
    [{ id: "registered", title: "Project", path: "/workspace" }],
  );
  await assert.rejects(
    f.invoke("bridge.workspaces", { ...p, actor: { ...f.actor, ownerId: 8 } }),
  );
  await assert.rejects(
    f.invoke("bridge.create", { ...p, workspaceId: "/arbitrary/path" }),
  );
  await assert.rejects(
    f.invoke("bridge.create", {
      ...p,
      workspaceId: "registered",
      confirmed: false,
    }),
  );
  assert.equal(
    await f.invoke("bridge.create", { ...p, workspaceId: "registered" }),
    "new",
  );
  assert.equal(selected, "registered");
});
