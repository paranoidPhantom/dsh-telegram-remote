import test from "node:test";
import assert from "node:assert/strict";
import { ResourceRegistry } from "../../src/host/resources.js";

const context = { generation: "child-1", ownerEpoch: 3 };

test("resource handles are opaque, scoped and chunked without exposing buffers on wire", async () => {
  const resources = new ResourceRegistry();
  const descriptor = resources.add({
    ...context,
    name: "report.pdf",
    bytes: Buffer.from("finished file"),
  });
  assert.ok(descriptor.id.length >= 20);
  assert.equal(descriptor.name, "report.pdf");
  assert.equal(descriptor.size, 13);
  assert.equal(JSON.stringify(descriptor).includes("finished file"), false);
  const chunk = resources.read({
    ...context,
    id: descriptor.id,
    offset: 0,
    length: 8,
  });
  assert.deepEqual(chunk, {
    data: Buffer.from("finished").toString("base64"),
    offset: 0,
    total: 13,
    eof: false,
  });
  assert.equal(
    resources.read({ ...context, id: descriptor.id, offset: 8, length: 8 }).eof,
    true,
  );
  resources.close();
});

test("resource reads reject forged generation/epoch, bounds and expired handles", () => {
  let now = 100;
  const resources = new ResourceRegistry({ now: () => now, ttlMs: 10 });
  const descriptor = resources.add({
    ...context,
    name: "a",
    bytes: Buffer.from("a"),
  });
  const request = { ...context, id: descriptor.id, offset: 0, length: 1 };
  assert.throws(
    () => resources.read({ ...request, generation: "stale" }),
    /resource|generation/i,
  );
  assert.throws(
    () => resources.read({ ...request, ownerEpoch: 4 }),
    /resource|epoch/i,
  );
  assert.throws(
    () => resources.read({ ...request, offset: -1 }),
    /offset|range/i,
  );
  assert.throws(
    () => resources.read({ ...request, length: 65537 }),
    /chunk|range|length/i,
  );
  now = 110;
  assert.throws(() => resources.read(request), /expired|resource/i);
});

test("resource registry bounds total bytes and revokes obsolete activation data", () => {
  const resources = new ResourceRegistry({ maxBytes: 5, maxResources: 2 });
  const descriptor = resources.add({
    ...context,
    name: "a",
    bytes: Buffer.from("123"),
  });
  assert.throws(
    () => resources.add({ ...context, name: "b", bytes: Buffer.from("456") }),
    /budget|capacity/i,
  );
  resources.revokeGeneration(context.generation);
  assert.throws(
    () =>
      resources.read({ ...context, id: descriptor.id, offset: 0, length: 1 }),
    /resource/i,
  );
  resources.add({ ...context, name: "b", bytes: Buffer.from("12345") });
  resources.close();
  assert.throws(
    () => resources.add({ ...context, name: "b", bytes: Buffer.from("") }),
    /closed/i,
  );
});
