import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SupervisorOptions,
  SupervisorState,
} from "../../src/host/supervisor.js";
import type {
  SupervisorPort,
  HostApproval,
} from "../../src/host/activation-contracts.js";
import { RpcPeer, type RpcRequestOptions } from "../../src/protocol/rpc.js";
import {
  ControlledTransport,
  deferred,
  record,
  deadlockGuard,
} from "./protocol-fixtures.js";
import { apply } from "../../src/index.js";
import type {
  ActivationContext,
  Registration,
} from "../../src/host/activation-contracts.js";
import { Inbox } from "../../src/host/inbox.js";
import { initialRun } from "../../src/projection/run-projection.js";
import type { JsonValue } from "../../src/protocol/json.js";

/** Host storage deliberately outlives each activation, just as the domain does. */
function fixture(rows = new Map<string, JsonValue>()) {
  const disposers: (() => void | Promise<void>)[] = [];
  const registrations = new Set<string>();
  let sessionEvent:
    | ((
        session: import("../../src/host/dsh-contracts.js").HostSession,
        event: import("../../src/host/dsh-contracts.js").HostRunEvent,
      ) => void)
    | undefined;
  let projected = initialRun();
  let approval:
    | ((
        request: HostApproval<string>,
        next: () => Promise<
          import("../../src/host/approvals.js").ApprovalOutcome
        >,
      ) => Promise<import("../../src/host/approvals.js").ApprovalOutcome>)
    | undefined;
  const register = (key: string): (() => void) => {
    assert.equal(
      registrations.has(key),
      false,
      `duplicate registration: ${key}`,
    );
    registrations.add(key);
    return () => {
      registrations.delete(key);
    };
  };
  const ctx: ActivationContext<string> = {
    effect: (callback) => {
      const dispose = callback();
      if (dispose) disposers.push(dispose);
    },
    get: () => undefined,
    fs: {
      resolve: async (value) => value,
      contains: () => true,
      stat: async () => ({ type: "file", size: 0 }),
      readBytes: async () => new Uint8Array(),
      processPath: (value) => value,
    },
    attachments: { readFileStream: async function* () {} },
    workingDirectory: { defaultDirectory: ".", get: () => "." },
    credentials: {
      describeRecord: async () => ({ configured: false }),
      readRecord: async () => null,
      modifyRecord: async () => {},
    },
    storageDomain: {
      open: async () => ({
        table: () => ({
          get: async (key) => rows.get(key),
          put: async (key, value) => {
            rows.set(key, value);
          },
          entries: () => rows.entries(),
        }),
        close: () => {},
      }),
    },
    sessionProjections: {
      register: async () => ({
        stateOf: () => projected,
        dispose: () => {},
      }),
    },
    sessionController: {
      list: async () => ({ items: [] }),
      state: async () => ({ running: false }),
      modelCatalog: async () => ({ groups: [] }),
      selectModel: async (value) => ({ selected: value }),
      create: async () => ({ sessionId: "created" }),
      prompt: async () => ({ accepted: true }),
      updateQueue: async () => ({ accepted: true }),
      cancel: async () => {},
      events: async () => ({ records: [], hasMore: false }),
    },
    sessionQuery: {
      observeSession: async () => ({
        header: { createdAt: 0 },
        events: [],
        [Symbol.dispose]: () => {},
      }),
    },
    connection: {
      requestRejection: () => null,
      admit: () => ({ peer: { principal: { kind: "owner" } } }),
    },
    webServer: {
      getOrigin: () => "http://localhost",
      register: () => register("route"),
    },
    tools: { register: () => register("send_file") },
    systemPrompt: { section: (value) => register(value.name) },
    on: (name: string, listener: unknown): Registration => {
      if (name === "session/event")
        sessionEvent = listener as NonNullable<typeof sessionEvent>;
      if (name === "approval/request")
        approval = listener as NonNullable<typeof approval>;
      return register(name);
    },
  };
  return {
    ctx,
    rows,
    registrations,
    emit(event: import("../../src/host/dsh-contracts.js").HostRunEvent) {
      assert.ok(sessionEvent);
      sessionEvent({ id: "s" }, event);
    },
    project(value: ReturnType<typeof initialRun>) {
      projected = value;
    },
    get approval() {
      assert.ok(approval);
      return approval;
    },
    inbox: () =>
      new Inbox({
        store: {
          get: async (key) => rows.get(key),
          set: async (key, value) => {
            rows.set(key, value);
          },
        },
      }),
    async unload() {
      for (const dispose of disposers.splice(0).reverse()) await dispose();
      assert.equal(registrations.size, 0);
    },
  };
}

test("same-owner Host reload preserves the persisted epoch and unresolved inbox identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-recovery-"));
  const mock = fixture(
    new Map<string, JsonValue>([
      ["settings:adminUserId", 42],
      ["settings:ownerEpoch", 17],
    ]),
  );
  const operation = { update_id: 71, message: { text: "pending prompt" } };
  await mock.inbox().admit({ updateId: 71, ownerEpoch: 17, operation });
  const config = {
    ownerId: 0,
    credentialKey: "telegram-console/bot",
    statusPath: join(directory, "status.json"),
  };
  try {
    for (let reload = 0; reload < 2; reload++) {
      await apply(mock.ctx, config);
      assert.equal(mock.rows.get("settings:ownerEpoch"), 17);
      assert.equal(await mock.inbox().offset(), 72);
      assert.deepEqual(await mock.inbox().pending(), [
        { updateId: 71, ownerEpoch: 17, operation },
      ]);
      await mock.unload();
    }
    assert.equal(
      await mock.inbox().admit({ updateId: 71, ownerEpoch: 17, operation }),
      "duplicate",
    );
    await mock.inbox().settle(71, 17, "completed");
    assert.deepEqual(await mock.inbox().pending(), []);
  } finally {
    await mock.unload();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a persisted epoch of zero is not silently replaced during activation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-recovery-"));
  const mock = fixture(
    new Map<string, JsonValue>([["settings:ownerEpoch", 0]]),
  );
  await mock
    .inbox()
    .admit({ updateId: 1, ownerEpoch: 0, operation: { update_id: 1 } });
  try {
    await apply(mock.ctx, {
      ownerId: 0,
      credentialKey: "telegram-console/bot",
      statusPath: join(directory, "status.json"),
    });
    assert.equal(mock.rows.get("settings:ownerEpoch"), 0);
    assert.deepEqual(await mock.inbox().pending(), [
      { updateId: 1, ownerEpoch: 0, operation: { update_id: 1 } },
    ]);
  } finally {
    await mock.unload();
    await rm(directory, { recursive: true, force: true });
  }
});

class ActivationPeer extends RpcPeer {
  constructor(
    readonly invoke: (method: string, payload: JsonValue) => Promise<JsonValue>,
  ) {
    super({ transport: new ControlledTransport(), generation: "test" });
  }
  override request(
    method: string,
    payload: JsonValue,
    _options?: RpcRequestOptions,
  ): Promise<JsonValue> {
    return this.invoke(method, payload);
  }
}
class FakeSupervisor implements SupervisorPort {
  state: SupervisorState = "idle";
  currentGeneration = "test";
  pid = undefined;
  peer: RpcPeer;
  constructor(
    readonly options: SupervisorOptions,
    invoke: (method: string, payload: JsonValue) => Promise<JsonValue>,
  ) {
    this.peer = new ActivationPeer(invoke);
  }
  async start() {
    this.state = "running";
    this.options.onReady?.(this.peer);
  }
  async close() {
    this.state = "closed";
    this.peer.close();
  }
  call(method: string, extra: Record<string, JsonValue> = {}) {
    const handler = this.options.handlers?.[method];
    assert.ok(handler, method);
    return handler(
      { generation: this.currentGeneration, ownerEpoch: 17, ...extra },
      new AbortController().signal,
    );
  }
}

async function activeFixture(
  invoke: (method: string, payload: JsonValue) => Promise<JsonValue>,
  setup?: (mock: ReturnType<typeof fixture>) => void,
) {
  const directory = await mkdtemp(join(tmpdir(), "telegram-active-recovery-"));
  const mock = fixture(
    new Map<string, JsonValue>([
      ["settings:adminUserId", 42],
      ["settings:ownerEpoch", 17],
    ]),
  );
  mock.ctx.credentials.describeRecord = async () => ({ configured: true });
  let token = "123:fixture-original";
  mock.ctx.credentials.readRecord = async () => ({
    kind: "api-key",
    key: token,
  });
  setup?.(mock);
  let supervisor: FakeSupervisor | undefined;
  await apply(
    mock.ctx,
    {
      ownerId: 42,
      credentialKey: "telegram-console/bot",
      statusPath: join(directory, "status.json"),
    },
    {
      createSupervisor: (options) =>
        (supervisor = new FakeSupervisor(options, invoke)),
    },
  );
  assert.ok(supervisor);
  return {
    ...mock,
    supervisor,
    setToken: (value: string) => {
      token = value;
    },
    async cleanup() {
      await mock.unload();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test(
  "credentials are pinned to the active supervisor generation",
  deadlockGuard,
  async () => {
    const mock = await activeFixture(async () => null);
    try {
      mock.setToken("456:fixture-rotated");
      assert.deepEqual(await mock.supervisor.call("credentials.read"), {
        token: "123:fixture-original",
      });
    } finally {
      await mock.cleanup();
    }
  },
);

test(
  "bot identity change clears old offset, inbox and topic authority before polling",
  deadlockGuard,
  async () => {
    const mock = await activeFixture(async () => null);
    try {
      mock.rows.set("settings:botIdentity", 123);
      mock.rows.set("poll-offset", 900);
      await mock.inbox().admit({
        updateId: 899,
        ownerEpoch: 17,
        operation: { update_id: 899 },
      });
      mock.rows.set("console:topic:s", { chatId: 42, threadId: 5 });
      await mock.supervisor.call("runtime.acquireLease", {
        botId: 900000000 + process.pid,
      });
      assert.equal(await mock.inbox().offset(), 0);
      assert.deepEqual(await mock.inbox().pending(), []);
      assert.equal(
        record(mock.rows.get("console:topic:s") ?? null).deleted,
        true,
      );
    } finally {
      await mock.cleanup();
    }
  },
);

test(
  "normal unavailable approval presentation settles without waiting for expiry",
  deadlockGuard,
  async () => {
    const mock = await activeFixture(async () => null);
    try {
      mock.rows.set("console:topic:s", { chatId: 42, threadId: 5 });
      const result = await mock.approval(
        {
          agent: {
            id: "s",
            session: { id: "s", snapshotEvents: () => [] },
            ctx: { get: () => mock.ctx.fs },
          },
          callId: "call",
          toolName: "write",
        },
        async () => "unavailable",
      );
      assert.equal(result, "cancelled");
    } finally {
      await mock.cleanup();
    }
  },
);

function replaySetup(mock: ReturnType<typeof fixture>) {
  mock.rows.set("console:topic:s", { chatId: 42, threadId: 5 });
  mock.ctx.sessionQuery.observeSession = async () => ({
    header: { createdAt: 0 },
    events: [
      { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } },
      {
        type: "assistant/message",
        seq: 2,
        data: { message: { content: [{ type: "text", text: "durable" }] } },
      },
    ],
    [Symbol.dispose]: () => {},
  });
}

test(
  "crash while replay is pending never advances the durable source cursor",
  deadlockGuard,
  async () => {
    const entered = deferred<void>(),
      pending = deferred<JsonValue>();
    const mock = await activeFixture(async (method) => {
      if (method === "run.push") {
        entered.resolve();
        return pending.promise;
      }
      return null;
    }, replaySetup);
    try {
      await entered.promise;
      assert.equal(mock.rows.has("console:source:s"), false);
      mock.supervisor.state = "offline";
      pending.reject(new Error("simulated disconnect"));
      await mock.unload();
      assert.equal(mock.rows.has("console:source:s"), false);
    } finally {
      await mock.cleanup();
    }
  },
);

test(
  "detached delivery does not acknowledge or advance source replay",
  deadlockGuard,
  async () => {
    const disposed = deferred<void>();
    const mock = await activeFixture(
      async (method) => (method === "run.push" ? { status: "detached" } : null),
      (mock) => {
        replaySetup(mock);
        const observe = mock.ctx.sessionQuery.observeSession;
        mock.ctx.sessionQuery.observeSession = async (...args) => ({
          ...(await observe(...args)),
          [Symbol.dispose]: () => disposed.resolve(),
        });
      },
    );
    try {
      await disposed.promise;
      assert.equal(mock.rows.has("console:source:s"), false);
    } finally {
      await mock.cleanup();
    }
  },
);

test(
  "truncated observation fails closed before delivering or persisting a cursor",
  deadlockGuard,
  async () => {
    const disposed = deferred<void>();
    let sends = 0;
    const mock = await activeFixture(
      async (method) => {
        if (method === "run.push") sends++;
        return { status: "delivered" };
      },
      (mock) => {
        replaySetup(mock);
        const observe = mock.ctx.sessionQuery.observeSession;
        mock.ctx.sessionQuery.observeSession = async (...args) => {
          const observation = await observe(...args);
          return {
            ...observation,
            events: observation.events.slice(1),
            [Symbol.dispose]: () => disposed.resolve(),
          };
        };
      },
    );
    try {
      await disposed.promise;
      assert.equal(sends, 0);
      assert.equal(mock.rows.has("console:source:s"), false);
    } finally {
      await mock.cleanup();
    }
  },
);

test(
  "same bot identity retains admitted updates and polling offset",
  deadlockGuard,
  async () => {
    const mock = await activeFixture(async () => null);
    try {
      const botId = 910000000 + process.pid;
      mock.rows.set("settings:botIdentity", botId);
      await mock
        .inbox()
        .admit({ updateId: 28, ownerEpoch: 17, operation: { update_id: 28 } });
      await mock.supervisor.call("runtime.acquireLease", { botId });
      assert.equal(await mock.inbox().offset(), 29);
      assert.deepEqual(await mock.inbox().pending(), [
        { updateId: 28, ownerEpoch: 17, operation: { update_id: 28 } },
      ]);
    } finally {
      await mock.cleanup();
    }
  },
);

test(
  "boundary bursts retain only one dirty catch-up rerun while delivery stalls",
  deadlockGuard,
  async () => {
    const entered = deferred<void>(),
      gate = deferred<JsonValue>(),
      rerun = deferred<void>();
    let observations = 0,
      sends = 0;
    const mock = await activeFixture(
      async (method) => {
        if (method !== "run.push") return null;
        sends++;
        if (sends === 1) {
          entered.resolve();
          return gate.promise;
        }
        return { status: "delivered" };
      },
      (mock) => {
        replaySetup(mock);
        const observe = mock.ctx.sessionQuery.observeSession;
        mock.ctx.sessionQuery.observeSession = async (...args) => {
          observations++;
          const observation = await observe(...args);
          return {
            ...observation,
            [Symbol.dispose]: () => {
              if (observations === 2) rerun.resolve();
            },
          };
        };
      },
    );
    try {
      await entered.promise;
      for (let index = 0; index < 1000; index++)
        mock.emit({
          type: "assistant/message",
          seq: 2,
          data: { message: { content: [{ type: "text", text: "durable" }] } },
        });
      assert.equal(observations, 1);
      gate.resolve({ status: "delivered" });
      await rerun.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        observations,
        2,
        "one thousand boundaries must not queue one thousand scans",
      );
      assert.deepEqual(mock.rows.get("console:source:s"), {
        ownerEpoch: 17,
        seq: 2,
      });
    } finally {
      gate.resolve({ status: "delivered" });
      await mock.cleanup();
    }
  },
);

test(
  "future-turn final progress cannot bypass the authoritative replay watermark",
  deadlockGuard,
  async () => {
    const entered = deferred<void>(),
      gate = deferred<JsonValue>(),
      rerun = deferred<void>();
    const turns: JsonValue[] = [];
    let observations = 0;
    const mock = await activeFixture(
      async (method, payload) => {
        if (method !== "run.push") return null;
        turns.push(record(record(payload).view ?? null).turn ?? null);
        if (turns.length === 1) {
          entered.resolve();
          return gate.promise;
        }
        return { status: "delivered" };
      },
      (mock) => {
        replaySetup(mock);
        const observe = mock.ctx.sessionQuery.observeSession;
        mock.ctx.sessionQuery.observeSession = async (...args) => {
          observations++;
          return {
            ...(await observe(...args)),
            [Symbol.dispose]: () => {
              if (observations === 2) rerun.resolve();
            },
          };
        };
      },
    );
    try {
      await entered.promise;
      mock.project({
        ...initialRun(),
        turn: 2,
        final: true,
        answer: "future",
        outputs: [{ id: "99", text: "future", toolCount: 0 }],
      });
      mock.emit({ type: "turn/end", seq: 100, data: {} });
      gate.resolve({ status: "delivered" });
      await rerun.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(
        turns,
        [1],
        "newer final snapshot must not jump over unobserved output boundaries",
      );
      assert.deepEqual(mock.rows.get("console:source:s"), {
        ownerEpoch: 17,
        seq: 2,
      });
    } finally {
      gate.resolve({ status: "delivered" });
      await mock.cleanup();
    }
  },
);
