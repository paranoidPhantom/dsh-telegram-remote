import test from "node:test";
import assert from "node:assert/strict";
import {
  createHostPort,
  type ActorOperationScope,
} from "../../src/child/host-port.js";
import type { JsonValue } from "../../src/protocol/json.js";

const actor: ActorOperationScope = {
  ownerId: 7,
  chatId: 7,
  threadId: 3,
  privateChat: true,
  operationId: "update:42",
};
function fixture(
  reply: (method: string, payload: JsonValue) => JsonValue | Promise<JsonValue>,
  scope: () => ActorOperationScope | undefined = () => actor,
) {
  const calls: Array<{ method: string; payload: JsonValue }> = [];
  const port = createHostPort({
    generation: "g",
    ownerEpoch: 2,
    scope,
    peer: {
      async request(method, payload) {
        calls.push({ method, payload });
        return reply(method, payload);
      },
    },
  });
  return { ...port, calls };
}

test("child bridge fences operations and preserves original prompt identity", async () => {
  const port = fixture(() => null);
  await port.bridge.prompt("s", "hello", "original:1");
  assert.deepEqual(port.calls[0], {
    method: "bridge.prompt",
    payload: {
      generation: "g",
      ownerEpoch: 2,
      actor: { ownerId: 7, chatId: 7, threadId: 3, privateChat: true },
      operationId: "original:1",
      id: "s",
      text: "hello",
      requestId: "original:1",
    },
  });
  const denied = fixture(
    () => null,
    () => undefined,
  );
  await assert.rejects(denied.bridge.create(), /scope/i);
  assert.equal(denied.calls.length, 0);
});

test("child DTO decoding validates consumed fields without unchecked wire casts", async () => {
  const port = fixture((method) =>
    method === "bridge.list"
      ? [{ id: "s", model: { id: "m" }, context: { percent: 10 } }]
      : [{ provider: "p", id: 4 }],
  );
  assert.equal((await port.bridge.list())[0]?.id, "s");
  await assert.rejects(port.bridge.models(), /response/i);
});

test("reasoning catalog and explicit/default selections survive the child boundary", async () => {
  const reasoning: JsonValue = {
    efforts: [
      { id: "low", name: "Low" },
      { id: "high", name: "High", description: "More thinking" },
    ],
    defaultEffort: "low",
  };
  const port = fixture((method) =>
    method === "bridge.models"
      ? [{ provider: "p", id: "m", reasoning }]
      : { ok: true },
  );
  assert.deepEqual((await port.bridge.models())[0]?.reasoning, reasoning);
  await port.bridge.selectModel("s", {
    provider: "p",
    model: "m",
    reasoningEffort: "high",
  });
  await port.bridge.selectModel("s", { provider: "p", model: "m" });
  const selections = port.calls.slice(1).map((call) => {
    const payload = call.payload;
    assert(payload && typeof payload === "object" && !Array.isArray(payload));
    return payload.selection;
  });
  assert.deepEqual(selections, [
    { provider: "p", model: "m", reasoningEffort: "high" },
    { provider: "p", model: "m" },
  ]);
  const malformed = fixture(() => [
    {
      provider: "p",
      id: "m",
      reasoning: { efforts: [{ id: 4, name: "Bad" }] },
    },
  ]);
  await assert.rejects(malformed.bridge.models(), /response/i);
});

test("file download checks chunks, preserves turn scope and releases resource", async () => {
  const port = fixture((method): JsonValue =>
    method === "bridge.fileForTurn"
      ? { id: "resource", name: "a.txt", size: 3 }
      : method === "resources.read"
        ? { data: "YWJj", offset: 0, total: 3, eof: true }
        : null,
  );
  const file = await port.bridge.fileForTurn("s", "turn:2", "a.txt");
  assert.deepEqual(file.content, new Uint8Array([97, 98, 99]));
  assert.equal(file.name, "a.txt");
  assert.deepEqual(
    port.calls.map((call) => call.method),
    ["bridge.fileForTurn", "resources.read", "resources.release"],
  );
  const broken = fixture((method) =>
    method === "bridge.files"
      ? [{ id: "r", name: "a", size: 3 }]
      : method === "resources.read"
        ? { data: "YQ==", offset: 1, total: 3, eof: true }
        : null,
  );
  await assert.rejects(broken.bridge.files("s"), /resource/i);
  assert.equal(broken.calls.at(-1)?.method, "resources.release");
});

test("store is namespaced and rejects arbitrary keys; credentials are private read only", async () => {
  const port = fixture((method) =>
    method === "credentials.read" ? { token: "fixture-token" } : null,
  );
  await port.store.set("console:topic:s", { chatId: 7, threadId: 3 });
  await assert.rejects(port.store.get("settings:adminUserId"), /key/i);
  assert.deepEqual(await port.credentials.readRecord("telegram-console/bot"), {
    kind: "api-key",
    key: "fixture-token",
  });
  await assert.rejects(port.credentials.readRecord("other"), /credential/i);
});

test("resource cancellation releases handles without forwarding an aborted signal to cleanup", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const port = createHostPort({
    generation: "g",
    ownerEpoch: 2,
    signal: controller.signal,
    peer: {
      async request(method, _payload, options) {
        calls.push(method);
        if (method === "bridge.fileForTurn") {
          controller.abort();
          return { id: "r", name: "a", size: 1 };
        }
        assert.equal(options?.signal, undefined);
        return null;
      },
    },
  });
  await assert.rejects(port.bridge.fileForTurn("s", 1, "a"));
  assert.deepEqual(calls, ["bridge.fileForTurn", "resources.release"]);
});

test("failed batch chunk releases every descriptor even when one release fails", async () => {
  const port = fixture((method, payload) => {
    if (method === "bridge.files")
      return [
        { id: "first", name: "a", size: 1 },
        { id: "second", name: "b", size: 1 },
        { id: "third", name: "c", size: 1 },
      ];
    if (method === "resources.read") throw new Error("failed chunk");
    if (
      method === "resources.release" &&
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      payload.id === "second"
    )
      throw new Error("failed release");
    return null;
  });
  await assert.rejects(port.bridge.files("s"));
  assert.deepEqual(
    port.calls
      .filter((call) => call.method === "resources.release")
      .map((call) => call.payload),
    ["first", "second", "third"].map((id) => ({
      generation: "g",
      ownerEpoch: 2,
      actor: { ownerId: 7, chatId: 7, threadId: 3, privateChat: true },
      id,
    })),
  );
  assert.equal(
    port.calls.filter((call) => call.method === "resources.read").length,
    1,
  );
});

test("cancelled batch releases every descriptor without cancelled cleanup requests", async () => {
  const controller = new AbortController();
  const released: string[] = [];
  const port = createHostPort({
    generation: "g",
    ownerEpoch: 2,
    signal: controller.signal,
    peer: {
      async request(method, payload, options) {
        if (method === "bridge.files") {
          controller.abort();
          return [
            { id: "first", name: "a", size: 1 },
            { id: "second", name: "b", size: 1 },
          ];
        }
        assert.equal(method, "resources.release");
        assert.equal(options?.signal, undefined);
        assert.ok(
          payload && typeof payload === "object" && !Array.isArray(payload),
        );
        assert.equal(payload.generation, "g");
        assert.equal(payload.ownerEpoch, 2);
        assert.equal(typeof payload.id, "string");
        released.push(String(payload.id));
        return null;
      },
    },
  });
  await assert.rejects(port.bridge.files("s"));
  assert.deepEqual(released, ["first", "second"]);
});

test("resource descriptors reject excessive allocations before reading", async () => {
  const port = fixture(() => ({ id: "r", name: "huge", size: 10485761 }));
  await assert.rejects(port.bridge.fileForTurn("s", 1, "huge"), /response/i);
  assert.deepEqual(
    port.calls.map((call) => call.method),
    ["bridge.fileForTurn"],
  );
});

test("workspace catalog validates DTOs and create carries only the selected workspace identity", async () => {
  const port = fixture((method) =>
    method === "bridge.workspaces"
      ? [{ id: "w", title: "Project", path: "/workspace" }]
      : "created",
  );
  assert.deepEqual(await port.bridge.workspaces(), [
    { id: "w", title: "Project", path: "/workspace" },
  ]);
  assert.equal(await port.bridge.create("w"), "created");
  assert.deepEqual(port.calls.at(-1), {
    method: "bridge.create",
    payload: {
      generation: "g",
      ownerEpoch: 2,
      actor: { ownerId: 7, chatId: 7, threadId: 3, privateChat: true },
      operationId: "update:42:create",
      confirmed: true,
      workspaceId: "w",
    },
  });
  const malformed = fixture(() => [{ id: "w", title: "Project", path: 123 }]);
  await assert.rejects(malformed.bridge.workspaces(), /response/i);
});
