import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test, { type TestContext } from "node:test";
import { ApprovalRegistry } from "../../src/host/approvals.js";

const START = 1_000;
const EXPIRES = 2_000;

function binding() {
  return {
    sessionId: "session-private-approval-target",
    callId: "call-private-approval-target",
    ownerId: 71,
    ownerEpoch: 4,
    chatId: 71,
    threadId: 18,
    expiresAt: EXPIRES,
  };
}

function decision(id: string) {
  return {
    ...binding(),
    id,
    privateChat: true,
    outcome: "allowed-once" as const,
  };
}

function registryFor(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: START });
  const registry = new ApprovalRegistry({ now: () => Date.now() });
  t.after(() => registry.close());
  return registry;
}

function assertNonGranting(outcome: unknown) {
  assert.ok(
    outcome === "cancelled" || outcome === "unavailable",
    `Expected a non-granting cancellation outcome, received ${String(outcome)}`,
  );
}

test("approval IDs are opaque, nonsequential and unique even for identical bindings", (t) => {
  const registry = registryFor(t);
  const ids = new Set<string>();
  for (let index = 0; index < 128; index++) {
    const approval = registry.register(binding());
    assert.equal(typeof approval.id, "string");
    assert.ok(approval.id.length >= 16, "IDs need an opaque capability budget");
    assert.doesNotMatch(approval.id, /^\d+$/);
    assert.ok(!approval.id.includes(binding().sessionId));
    assert.ok(!approval.id.includes(binding().callId));
    assert.ok(!ids.has(approval.id));
    ids.add(approval.id);
  }
});

test("only the exact actor, private chat, session, call, topic and epoch can decide", async (t) => {
  const registry = registryFor(t);
  const approval = registry.register(binding());
  const valid = decision(approval.id);
  const invalid = [
    { ...valid, id: `${approval.id}-forged` },
    { ...valid, ownerId: valid.ownerId + 1 },
    { ...valid, privateChat: false },
    { ...valid, chatId: valid.chatId + 1 },
    { ...valid, sessionId: "session-other" },
    { ...valid, callId: "call-other" },
    { ...valid, threadId: valid.threadId + 1 },
    { ...valid, ownerEpoch: valid.ownerEpoch - 1 },
    { ...valid, ownerEpoch: valid.ownerEpoch + 1 },
  ];
  let settled = false;
  void approval.result.then(() => {
    settled = true;
  });
  for (const attempt of invalid) {
    assert.equal(registry.decide(attempt), false);
    await Promise.resolve();
    assert.equal(
      settled,
      false,
      "a failed binding must not consume the approval",
    );
  }
  assert.equal(registry.decide(valid), true);
  assert.equal(await approval.result, "allowed-once");
});

test("a capability cannot be transferred between two outstanding calls", async (t) => {
  const registry = registryFor(t);
  const first = registry.register(binding());
  const secondBinding = { ...binding(), callId: "call-second" };
  const second = registry.register(secondBinding);
  assert.equal(
    registry.decide({ ...decision(first.id), callId: secondBinding.callId }),
    false,
  );
  assert.equal(registry.decide(decision(first.id)), true);
  assert.equal(
    registry.decide({ ...decision(second.id), callId: secondBinding.callId }),
    true,
  );
  assert.equal(await first.result, "allowed-once");
  assert.equal(await second.result, "allowed-once");
});

for (const outcome of ["allowed-once", "rejected"] as const) {
  test(`approval settles ${outcome} once and ignores duplicate or opposite decisions`, async (t) => {
    const registry = registryFor(t);
    const approval = registry.register(binding());
    const request = { ...decision(approval.id), outcome };
    let settlements = 0;
    void approval.result.then(() => {
      settlements++;
    });
    assert.equal(registry.decide(request), true);
    assert.equal(registry.decide(request), false);
    assert.equal(
      registry.decide({
        ...request,
        outcome: outcome === "allowed-once" ? "rejected" : "allowed-once",
      }),
      false,
    );
    registry.cancel(approval.id);
    registry.revokeEpoch(binding().ownerEpoch);
    registry.close();
    t.mock.timers.tick(EXPIRES - START + 1);
    assert.equal(await approval.result, outcome);
    assert.equal(settlements, 1);
  });
}

test("explicit cancellation is terminal and cancellation of unknown IDs is harmless", async (t) => {
  const registry = registryFor(t);
  const approval = registry.register(binding());
  registry.cancel("unknown-capability");
  registry.cancel(approval.id);
  registry.cancel(approval.id);
  assertNonGranting(await approval.result);
  assert.equal(registry.decide(decision(approval.id)), false);
});

test("abort settles pending approval without a Telegram decision", async (t) => {
  const registry = registryFor(t);
  const controller = new AbortController();
  const approval = registry.register({
    ...binding(),
    signal: controller.signal,
  });
  controller.abort();
  assertNonGranting(await approval.result);
  assert.equal(registry.decide(decision(approval.id)), false);
  t.mock.timers.tick(EXPIRES - START + 1);
  assert.equal(registry.decide(decision(approval.id)), false);
});

test("settling approvals removes owned abort listeners", async (t) => {
  const registry = registryFor(t);
  for (const ending of [
    "decision",
    "cancel",
    "expiry",
    "revoke",
    "close",
  ] as const) {
    const controller = new AbortController();
    const baseline = getEventListeners(controller.signal, "abort").length;
    const approval = registry.register({
      ...binding(),
      signal: controller.signal,
    });
    if (ending === "decision") registry.decide(decision(approval.id));
    if (ending === "cancel") registry.cancel(approval.id);
    if (ending === "expiry") t.mock.timers.tick(EXPIRES - START);
    if (ending === "revoke") registry.revokeEpoch(binding().ownerEpoch);
    if (ending === "close") registry.close();
    await approval.result;
    assert.equal(
      getEventListeners(controller.signal, "abort").length,
      baseline,
    );
    controller.abort();
    assert.equal(registry.decide(decision(approval.id)), false);
    t.mock.timers.setTime(START);
  }
});

test("already-aborted registration never leaves a usable approval", async (t) => {
  const registry = registryFor(t);
  const controller = new AbortController();
  controller.abort();
  const approval = registry.register({
    ...binding(),
    signal: controller.signal,
  });
  assert.equal(registry.decide(decision(approval.id)), false);
  assertNonGranting(await approval.result);
});

test("expiry settles autonomously at the exact deadline and rejects late callbacks", async (t) => {
  const registry = registryFor(t);
  const approval = registry.register(binding());
  let settled = false;
  void approval.result.then(() => {
    settled = true;
  });
  t.mock.timers.tick(EXPIRES - START - 1);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assertNonGranting(await approval.result);
  assert.equal(registry.decide(decision(approval.id)), false);
});

test("expired registrations and clock-advanced callbacks fail closed without waiting for a timer", async (t) => {
  const registry = registryFor(t);
  const expired = registry.register({ ...binding(), expiresAt: START });
  assert.equal(registry.decide(decision(expired.id)), false);
  assertNonGranting(await expired.result);

  const pending = registry.register(binding());
  t.mock.timers.setTime(EXPIRES);
  assert.equal(registry.decide(decision(pending.id)), false);
  assertNonGranting(await pending.result);
});

test("revoking one owner epoch cancels all its approvals but not another epoch", async (t) => {
  const registry = registryFor(t);
  const first = registry.register(binding());
  const second = registry.register({ ...binding(), callId: "call-second" });
  const current = registry.register({ ...binding(), ownerEpoch: 5 });
  registry.revokeEpoch(4);
  registry.revokeEpoch(4);
  assertNonGranting(await first.result);
  assertNonGranting(await second.result);
  assert.equal(registry.decide(decision(first.id)), false);
  assert.equal(
    registry.decide({ ...decision(second.id), callId: "call-second" }),
    false,
  );
  assert.equal(
    registry.decide({ ...decision(current.id), ownerEpoch: 5 }),
    true,
  );
  assert.equal(await current.result, "allowed-once");
});

test("close settles every pending approval and permanently closes admission", async (t) => {
  const registry = registryFor(t);
  const first = registry.register(binding());
  const second = registry.register({ ...binding(), callId: "call-second" });
  registry.close();
  registry.close();
  assertNonGranting(await first.result);
  assertNonGranting(await second.result);
  assert.equal(registry.decide(decision(first.id)), false);
  assert.equal(
    registry.decide({ ...decision(second.id), callId: "call-second" }),
    false,
  );
  // Post-close rejection may be synchronous or a terminal unavailable handle;
  // neither is allowed to create a capability that can grant approval.
  let afterClose: ReturnType<ApprovalRegistry["register"]> | undefined;
  try {
    afterClose = registry.register(binding());
  } catch (error: unknown) {
    assert.ok(error instanceof Error);
  }
  if (afterClose !== undefined) {
    assert.equal(registry.decide(decision(afterClose.id)), false);
    assertNonGranting(await afterClose.result);
  }
});
