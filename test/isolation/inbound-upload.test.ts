import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHostPort } from "../../src/child/host-port.js";
import { HostAuthority } from "../../src/host/authority.js";
import { ApprovalRegistry } from "../../src/host/approvals.js";
import { ResourceRegistry } from "../../src/host/resources.js";
import type { ConsoleBridge } from "../../src/bot/contracts.js";
import type { JsonValue } from "../../src/protocol/json.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "inbound-upload-test-"));
  t.after(async () => {
    assert.equal(path.dirname(cwd), os.tmpdir());
    assert.ok(path.basename(cwd).startsWith("inbound-upload-test-"));
    await rm(cwd, { recursive: true, force: true });
  });
  const rows = new Map<string, JsonValue>([
    ["console:topic:s", { chatId: 7, threadId: 9 }],
  ]);
  const bridge: ConsoleBridge = {
    workspaces: async () => [],
    list: async () => [],
    metadata: async () => ({ cwd }),
    models: async () => [],
    newSessionSelection: async () => null,
    create: async () => "new",
    selectModel: async () => ({}),
    prompt: async () => true,
    steerQueued: async () => ({ accepted: true }),
    stop: async () => {},
    details: async () => "",
    files: async () => [],
    fileForTurn: async () => ({ name: "x", content: new Uint8Array() }),
  };
  const options = {
    bridge,
    store: {
      get: async (key: string) => rows.get(key),
      set: async (key: string, value: JsonValue) => {
        rows.set(key, value);
      },
    },
    credentials: { readRecord: async () => null },
    credentialKey: "telegram-console/bot",
    ownerId: 7,
    ownerEpoch: 1,
    generation: "g1",
    approvals: new ApprovalRegistry(),
    resources: new ResourceRegistry(),
  };
  const authority = new HostAuthority(options);
  const actor = { ownerId: 7, chatId: 7, threadId: 9, privateChat: true };
  const handlers = authority.handlers();
  const invoke = (
    action: string,
    fields: Record<string, JsonValue> = {},
    signal = new AbortController().signal,
  ) => {
    const handler = handlers[`uploads.${action}`];
    assert.ok(handler);
    return handler({ ownerEpoch: 1, actor, ...fields }, signal);
  };
  const begin = async (size: number, name = "original.TXT") => {
    const result = await invoke("begin", { sessionId: "s", name, size });
    assert.ok(result && typeof result === "object" && !Array.isArray(result));
    assert.equal(typeof result.id, "string");
    return result.id as string;
  };
  const chunk = (uploadId: string, bytes: Buffer, offset = 0) =>
    invoke("chunk", { uploadId, data: bytes.toString("base64"), offset });
  return { cwd, rows, options, authority, actor, invoke, begin, chunk };
}

test("child upload proxy transfers multiple full chunks through Host authority", async (t) => {
  const f = await fixture(t);
  const handlers = f.authority.handlers();
  const calls: string[] = [];
  const port = createHostPort({
    generation: "g1",
    ownerEpoch: 1,
    scope: () => ({ ...f.actor, operationId: "telegram:7:11" }),
    peer: {
      async request(method, payload) {
        calls.push(method);
        const handler = handlers[method];
        assert.ok(handler);
        return handler(payload, new AbortController().signal);
      },
    },
  });
  const bytes = Buffer.alloc(140000, 97);
  assert.ok(port.bridge.receiveFile);
  const saved = await port.bridge.receiveFile(
    "s",
    { name: "a.png", content: bytes },
    "telegram:7:11",
  );
  assert.deepEqual(await readFile(saved), bytes);
  assert.deepEqual(calls, [
    "uploads.begin",
    "uploads.chunk",
    "uploads.chunk",
    "uploads.chunk",
    "uploads.commit",
  ]);
});

test("upload authority rejects forged owner, epoch, chat and topic", async (t) => {
  const f = await fixture(t);
  const invalid: Record<string, JsonValue>[] = [
    { ownerEpoch: 0 },
    { actor: { ...f.actor, ownerId: 8 } },
    { actor: { ...f.actor, chatId: 8 } },
    { actor: { ...f.actor, threadId: 10 } },
    { actor: { ...f.actor, privateChat: false } },
    { sessionId: "unbound" },
  ];
  for (const fields of invalid)
    await assert.rejects(
      f.invoke("begin", { sessionId: "s", name: "a.txt", size: 1, ...fields }),
    );
  const id = await f.begin(1);
  await assert.rejects(
    f.invoke("chunk", {
      uploadId: id,
      data: "YQ==",
      offset: 0,
      actor: { ...f.actor, threadId: 10 },
    }),
  );
  f.rows.set("console:topic:s", { chatId: 7, threadId: 9, closed: true });
  await assert.rejects(f.chunk(id, Buffer.from("a")));
  assert.deepEqual(await readdir(f.cwd), []);
});

test("upload chunks require sequential offsets, canonical bounded base64 and declared size", async (t) => {
  const f = await fixture(t);
  const id = await f.begin(65538);
  for (const fields of [
    { offset: 1, data: "YQ==" },
    { offset: 0, data: "" },
    { offset: 0, data: "YQ" },
    { offset: 0, data: "YQ==\n" },
    { offset: 0, data: Buffer.alloc(65537).toString("base64") },
    { offset: 0, data: "A".repeat(87385) },
  ])
    await assert.rejects(f.invoke("chunk", { uploadId: id, ...fields }));
  await f.chunk(id, Buffer.alloc(65536, 1));
  await assert.rejects(f.chunk(id, Buffer.from([2]), 0));
  await assert.rejects(f.chunk(id, Buffer.from([2, 3, 4]), 65536));
  await f.chunk(id, Buffer.from([2, 3]), 65536);
  const saved = await f.invoke("commit", {
    uploadId: id,
    requestId: "chunked",
  });
  assert.equal(typeof saved, "string");
  const bytes = await readFile(saved as string);
  assert.equal(bytes.length, 65538);
  assert.deepEqual(bytes.subarray(65536), Buffer.from([2, 3]));
});

test("incomplete commits fail without consuming upload, release invalidates it", async (t) => {
  const f = await fixture(t);
  const id = await f.begin(2);
  await f.chunk(id, Buffer.from([1]));
  await assert.rejects(
    f.invoke("commit", { uploadId: id, requestId: "incomplete" }),
  );
  assert.deepEqual(await readdir(f.cwd), []);
  await f.chunk(id, Buffer.from([2]), 1);
  assert.equal(await f.invoke("release", { uploadId: id }), null);
  await assert.rejects(
    f.invoke("commit", { uploadId: id, requestId: "released" }),
  );
  await assert.rejects(f.chunk(id, Buffer.from([1])));
});

test("commit saves bytes only in Host cwd and journal replay returns original path", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from("original media bytes");
  async function save(requestId: string, data = bytes) {
    const id = await f.begin(data.length, "../../original.TXT");
    await f.chunk(id, data);
    return f.invoke("commit", {
      uploadId: id,
      requestId,
      cwd: "/child-chosen-path",
      path: "/child-chosen-file",
    });
  }
  const saved = await save("original-request");
  assert.equal(typeof saved, "string");
  assert.equal(
    path.dirname(saved as string),
    path.join(await realpath(f.cwd), ".dsh-telegram-remote"),
  );
  assert.equal(path.extname(saved as string), ".txt");
  assert.ok(!path.basename(saved as string).includes("original"));
  assert.deepEqual(await readFile(saved as string), bytes);
  assert.equal(await save("original-request"), saved);
  await assert.rejects(save("original-request", Buffer.from("changed media")));
  assert.equal((await readdir(path.dirname(saved as string))).length, 1);
});

test("upload limits reject oversize allocation and cap concurrent pending transfers", async (t) => {
  const f = await fixture(t);
  for (const size of [-1, 10 * 1024 * 1024 + 1])
    await assert.rejects(f.begin(size));
  await assert.rejects(f.begin(1, "a".repeat(1025)));
  const ids = await Promise.all([
    f.begin(0),
    f.begin(0),
    f.begin(0),
    f.begin(0),
  ]);
  await assert.rejects(f.begin(0));
  await f.invoke("release", { uploadId: ids[0]! });
  await f.begin(0);
});

test("pre-aborted upload RPCs do not mutate pending transfer state", async (t) => {
  const f = await fixture(t);
  const id = await f.begin(1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.invoke(
      "chunk",
      { uploadId: id, data: "AQ==", offset: 0 },
      controller.signal,
    ),
  );
  await f.chunk(id, Buffer.from([1]));
  await assert.rejects(
    f.invoke(
      "commit",
      { uploadId: id, requestId: "cancelled" },
      controller.signal,
    ),
  );
  assert.deepEqual(await readdir(f.cwd), []);
  const saved = await f.invoke("commit", {
    uploadId: id,
    requestId: "accepted",
  });
  assert.equal(typeof saved, "string");
});

test("close and owner rotation invalidate retained upload capabilities", async (t) => {
  const f = await fixture(t);
  const id = await f.begin(1);
  f.authority.close();
  await assert.rejects(f.chunk(id, Buffer.from([1])));
  await assert.rejects(f.begin(0));
  f.authority.setOwner({ ownerId: 7, ownerEpoch: 2, generation: "g2" });
  await assert.rejects(
    f.invoke("chunk", { ownerEpoch: 2, uploadId: id, data: "AQ==", offset: 0 }),
  );
  await assert.rejects(f.begin(0));
  const fresh = await f.invoke("begin", {
    ownerEpoch: 2,
    sessionId: "s",
    name: "x.bin",
    size: 0,
  });
  assert.ok(fresh && typeof fresh === "object" && !Array.isArray(fresh));
  f.authority.setOwner({ ownerId: 8, ownerEpoch: 3, generation: "g3" });
  await assert.rejects(
    f.invoke("commit", {
      ownerEpoch: 3,
      actor: { ownerId: 8, chatId: 8, threadId: 9, privateChat: true },
      uploadId: fresh.id!,
      requestId: "rotated",
    }),
  );
});
