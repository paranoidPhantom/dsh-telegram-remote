import assert from "node:assert/strict";
import test from "node:test";
import { ChildRuntime } from "../../src/child/runtime.js";
import { UpdateIngress } from "../../src/child/ingress.js";
import { ChildSupervisor } from "../../src/host/supervisor.js";
import {
  RuntimeDiagnosticsPoller,
  runtimeDiagnosticsSchema,
} from "../../src/host/diagnostics.js";
import { TelegramAdapter } from "../../src/telegram/adapter.js";

test("ingress exposes aggregate active and last-observed pending counts only", async () => {
  const controller = new AbortController();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => {};
  const handled = new Promise<void>((resolve) => {
    started = resolve;
  });
  const ingress = new UpdateIngress({
    signal: controller.signal,
    maxActive: 1,
    retryMs: 1000,
    api: { call: async () => [] },
    admit: async () => "ignored",
    getOffset: async () => 0,
    pending: async () =>
      [1, 2].map((updateId) => ({ updateId, ownerEpoch: 1, operation: null })),
    classify: () => ({ key: "same", priority: false }),
    handle: async () => {
      started();
      await gate;
    },
    settle: async () => {},
    onError: () => {},
  });
  assert.equal(ingress.diagnostics().active, 0);
  const work = ingress.run();
  try {
    await handled;
    assert.deepEqual(ingress.diagnostics(), {
      active: 1,
      normalActive: 1,
      priorityActive: 0,
      pending: 1,
      halted: false,
    });
  } finally {
    controller.abort();
    release();
    await work;
    await ingress.drain();
  }
  assert.equal(ingress.diagnostics().active, 0);
});

const sample = {
  childPid: 123,
  build: "build",
  generation: "g",
  uptimeMs: 100,
  rpcPending: 0,
  ingress: null,
  outbound: {
    active: 0,
    pending: 0,
    lanes: 0,
    lanePending: 0,
    cooldownUntil: 0,
    rateLimitCount: 0,
    rateLimitLastWaitMs: 0,
    rateLimitMaxWaitMs: 0,
  },
  eventToSend: { lastMs: null, maxMs: null },
};

test("runtime diagnostics is read-only, content-free and available before initialization", async () => {
  let calls = 0;
  const runtime = new ChildRuntime({
    generation: "g",
    build: "build",
    peer: {
      pendingCount: 3,
      request: async () => {
        calls++;
        return null;
      },
    },
  });
  try {
    const handler = runtime.handlers["runtime.diagnostics"];
    assert.ok(handler);
    const result = runtimeDiagnosticsSchema.parse(
      await handler(
        { token: "must-not-echo", prompt: "secret" },
        new AbortController().signal,
      ),
    );
    assert.equal(result.childPid, process.pid);
    assert.equal(result.generation, "g");
    assert.equal(result.build, "build");
    assert.equal(result.rpcPending, 3);
    assert.equal(result.ingress, null);
    assert.deepEqual(result.eventToSend, { lastMs: null, maxMs: null });
    assert.equal(calls, 0);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  } finally {
    await runtime.shutdown();
  }
});

test(
  "real child entry exposes diagnostics RPC",
  { timeout: 10000 },
  async () => {
    const supervisor = new ChildSupervisor({
      entry: new URL("../../src/child/index.js", import.meta.url),
      build: "diagnostic-build",
      generation: "diagnostic-generation",
      maxRestarts: 0,
    });
    try {
      await supervisor.start();
      assert.ok(supervisor.peer);
      const result = runtimeDiagnosticsSchema.parse(
        await supervisor.peer.request("runtime.diagnostics", {}),
      );
      assert.equal(result.childPid, supervisor.pid);
      assert.equal(result.build, "diagnostic-build");
      assert.equal(result.generation, "diagnostic-generation");
    } finally {
      await supervisor.close();
    }
  },
);

test("poller allowlists response fields and fences generation and ownership", async () => {
  let notifications = 0;
  let requests = 0;
  const peer = {
    request: async () => {
      requests++;
      return { ...sample, prompt: "secret", error: "body" };
    },
  };
  const poller = new RuntimeDiagnosticsPoller({
    peer: () => peer,
    onSample: () => {
      notifications++;
    },
  });
  try {
    await poller.poll();
    assert.equal(requests, 1);
    assert.equal(notifications, 1);
    assert.deepEqual(poller.snapshot("g"), sample);
    assert.equal(poller.snapshot("other"), null);
    const snapshot = poller.snapshot("g");
    assert.ok(snapshot);
    snapshot.outbound.pending = 99;
    assert.equal(poller.snapshot("g")?.outbound.pending, 0);
    poller.close();
    await poller.poll();
    assert.equal(requests, 1);
    assert.equal(poller.snapshot("g"), null);
  } finally {
    poller.close();
  }
});

test("poller bounds requests to one active request and ignores obsolete responses", async () => {
  let release: (value: typeof sample) => void = () => {};
  const result = new Promise<typeof sample>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  const peer = {
    request: async () => {
      requests++;
      return result;
    },
  };
  let current: typeof peer | undefined = peer;
  const poller = new RuntimeDiagnosticsPoller({
    peer: () => current,
    onSample: () => assert.fail("stale sample"),
  });
  const work = poller.poll();
  await poller.poll();
  assert.equal(requests, 1);
  current = undefined;
  release(sample);
  await work;
  assert.equal(poller.snapshot("g"), null);
  poller.close();
});

test("adapter records numeric 429 waits without retaining rejection content", async () => {
  let starts = 0;
  const adapter = new TelegramAdapter({
    credentialKey: "fixture",
    credentials: {
      readRecord: async () => ({ kind: "api-key", key: "fixture" }),
    },
    now: () => 100,
    onSendStart: () => {
      starts++;
    },
    createApi: () => ({
      sendMessage: async () => {
        throw {
          errorCode: 429,
          parameters: { retry_after: 2 },
          description: "sensitive body",
        };
      },
    }),
  });
  await assert.rejects(
    adapter.call("sendMessage", { chat_id: 1, text: "secret" }),
  );
  assert.equal(starts, 1);
  assert.equal(adapter.rateLimitCount, 1);
  assert.equal(adapter.rateLimitLastWaitMs, 2000);
  assert.equal(adapter.rateLimitMaxWaitMs, 2000);
  assert.equal(adapter.cooldownUntil, 2100);
  assert.equal(adapter.outboundActive, 0);
});
