import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalRegistry } from "../../src/host/approvals.js";
import { ChildRuntime } from "../../src/child/runtime.js";
import type { ApprovalRequest } from "../../src/bot/contracts.js";
import type { JsonValue } from "../../src/protocol/json.js";

const binding = {
  sessionId: "session",
  callId: "call",
  ownerId: 7,
  ownerEpoch: 4,
  chatId: 7,
  threadId: 9,
  expiresAt: 2000,
};
const actor = { ...binding, privateChat: true };

test("reason is optional, post-rejection only, exactly bound and single-use", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const registry = new ApprovalRegistry();
  t.after(() => registry.close());
  const reasons: string[] = [];
  const handle = registry.register({
    ...binding,
    onReason: (reason) => {
      reasons.push(reason);
    },
  });
  const input = { ...actor, id: handle.id, reason: "No secrets in logs" };
  assert.equal(await registry.reason(input), false);
  assert.equal(
    registry.decide({ ...actor, id: handle.id, outcome: "rejected" }),
    true,
  );
  assert.equal(await handle.result, "rejected");
  for (const invalid of [
    { ...input, id: "forged" },
    { ...input, ownerId: 8 },
    { ...input, ownerEpoch: 5 },
    { ...input, sessionId: "other" },
    { ...input, callId: "other" },
    { ...input, chatId: 8 },
    { ...input, threadId: 10 },
    { ...input, privateChat: false },
  ])
    assert.equal(await registry.reason(invalid), false);
  // Forwarding completion cancels a now-settled approval, not its optional reason.
  registry.cancel(handle.id);
  assert.equal(
    await registry.reason({ ...input, reason: "x".repeat(1001) }),
    false,
  );
  assert.equal(await registry.reason(input), true);
  assert.equal(await registry.reason(input), false);
  assert.deepEqual(reasons, [input.reason]);
  assert.equal(
    registry.decide({ ...actor, id: handle.id, outcome: "allowed-once" }),
    false,
  );
  assert.equal(await handle.result, "rejected");
});

test("only rejected approvals with callbacks retain reasons", async (t) => {
  const registry = new ApprovalRegistry({ now: () => 1000 });
  t.after(() => registry.close());
  for (const outcome of ["allowed-once", "rejected"] as const) {
    const handle = registry.register(binding);
    registry.decide({ ...actor, id: handle.id, outcome });
    assert.equal(
      await registry.reason({ ...actor, id: handle.id, reason: "note" }),
      false,
    );
  }
  let calls = 0;
  const handle = registry.register({
    ...binding,
    onReason: () => {
      calls++;
    },
  });
  registry.decide({ ...actor, id: handle.id, outcome: "allowed-once" });
  assert.equal(
    await registry.reason({ ...actor, id: handle.id, reason: "note" }),
    false,
  );
  assert.equal(calls, 0);
});

for (const ending of [
  "expiry",
  "close",
  "revoke",
  "disconnect",
  "abort",
] as const) {
  test(`${ending} clears retained rejection reason authority`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
    const registry = new ApprovalRegistry();
    t.after(() => registry.close());
    let calls = 0;
    const controller = new AbortController();
    const handle = registry.register({
      ...binding,
      signal: controller.signal,
      onReason: () => {
        calls++;
      },
    });
    registry.decide({ ...actor, id: handle.id, outcome: "rejected" });
    if (ending === "expiry") t.mock.timers.tick(1000);
    if (ending === "close") registry.close();
    if (ending === "revoke") registry.revokeEpoch(binding.ownerEpoch);
    if (ending === "disconnect") registry.cancelEpoch(binding.ownerEpoch);
    if (ending === "abort") controller.abort();
    assert.equal(
      await registry.reason({ ...actor, id: handle.id, reason: "note" }),
      false,
    );
    assert.equal(calls, 0);
  });
}

test("callback failure and concurrent submissions cannot replay the callback", async (t) => {
  const registry = new ApprovalRegistry({ now: () => 1000 });
  t.after(() => registry.close());
  let calls = 0;
  const handle = registry.register({
    ...binding,
    onReason: async () => {
      calls++;
      throw new Error("private detail");
    },
  });
  registry.decide({ ...actor, id: handle.id, outcome: "rejected" });
  const input = { ...actor, id: handle.id, reason: "note" };
  assert.equal(await registry.reason(input), false);
  assert.equal(await registry.reason(input), false);
  assert.equal(calls, 1);
});

test("child reason closure retains the denial actor outside its ambient scope", async () => {
  const requests: Array<{ method: string; payload: JsonValue | undefined }> =
    [];
  const runtime = new ChildRuntime({
    peer: {
      request: async (method, payload) => {
        requests.push({ method, payload });
        return true;
      },
    },
    generation: "g",
    build: "b",
  });
  let request: ApprovalRequest | undefined;
  // Install only the narrow surface needed by this handler. This test deliberately
  // has no ambient actor; the callback actor is recorded just as handleUpdate does.
  const surface = {
    approval: async (_sessionId: string, req: ApprovalRequest) => {
      request = req;
      const actors: unknown = Reflect.get(runtime, "approvalActors");
      assert.ok(actors instanceof WeakMap);
      assert.ok(req.signal);
      actors.set(req.signal, {
        ownerId: 7,
        chatId: 7,
        threadId: 9,
        privateChat: true,
        operationId: "denial",
      });
      return "rejected";
    },
  };
  Reflect.set(runtime, "surface", surface);
  const handler = runtime.handlers["approval.request"];
  assert.ok(handler);
  assert.equal(
    await handler(
      {
        id: "opaque",
        sessionId: "session",
        callId: "call",
        request: { hasOnReason: true },
      },
      new AbortController().signal,
    ),
    "rejected",
  );
  assert.ok(request?.onReason);
  assert.equal(runtime.scope.getStore(), undefined);
  await runtime.scope.run(
    {
      ownerId: 99,
      chatId: 99,
      threadId: 99,
      privateChat: false,
      operationId: "unrelated",
    },
    () => request?.onReason?.("reason"),
  );
  const reason = requests.find((item) => item.method === "approvals.reason");
  assert.deepEqual(reason?.payload, {
    generation: "g",
    ownerEpoch: 0,
    id: "opaque",
    sessionId: "session",
    callId: "call",
    actor: { ownerId: 7, chatId: 7, threadId: 9, privateChat: true },
    reason: "reason",
  });
  Reflect.set(runtime, "surface", undefined);
  await runtime.shutdown();
});

test("child leaves onReason absent when Host has no optional callback", async () => {
  const runtime = new ChildRuntime({
    peer: { request: async () => true },
    generation: "g",
    build: "b",
  });
  Reflect.set(runtime, "surface", {
    approval: async (_sessionId: string, req: ApprovalRequest) => {
      assert.equal(req.onReason, undefined);
      return "cancelled";
    },
  });
  const handler = runtime.handlers["approval.request"];
  assert.ok(handler);
  await handler(
    { id: "opaque", sessionId: "session", callId: "call", request: {} },
    new AbortController().signal,
  );
  Reflect.set(runtime, "surface", undefined);
  await runtime.shutdown();
});
