import test from "node:test";
import assert from "node:assert/strict";
import { FixtureConsole } from "../console-constructor.js";
import { historicalReceipt } from "../../src/bot/contracts.js";
import type { RunView, TelegramParams } from "../../src/bot/contracts.js";

function fixture(t: test.TestContext) {
  const key = "console:run:s:1";
  const data = new Map<string, unknown>([
    ["console:topic:s", { chatId: 1, threadId: 2 }],
  ]);
  const calls: { method: string; params: TelegramParams; id: number }[] = [];
  let next = 100;
  let failBoundary = false;
  let failed = false;
  const create = () => {
    const surface = new FixtureConsole({
      ownerId: 1,
      bridge: {},
      store: {
        async get(key) {
          return structuredClone(data.get(key));
        },
        async set(storedKey, value) {
          const receipt = historicalReceipt(value);
          if (
            failBoundary &&
            storedKey === key &&
            receipt?.outputs?.[0]?.complete &&
            receipt.logStart === 1
          ) {
            failBoundary = false;
            failed = true;
            throw new Error("boundary checkpoint failed");
          }
          data.set(storedKey, structuredClone(value));
        },
        async entries() {
          return [...data];
        },
      },
      api: {
        async call(method, params = {}) {
          const id = method === "sendMessage" ? ++next : 0;
          calls.push({ method, params, id });
          return id ? { message_id: id } : true;
        },
      },
    });
    t.after(() => surface.close());
    return surface;
  };
  const receipt = () => {
    const result = historicalReceipt(data.get(key));
    assert.ok(result);
    return result;
  };
  return {
    create,
    calls,
    receipt,
    failNextBoundary() {
      failBoundary = true;
    },
    get failed() {
      return failed;
    },
  };
}

const a = { callId: "a", name: "ReadA", status: "completed" };
const b = { callId: "b", name: "ReadB", status: "completed" };
const latest = { callId: "c", name: "Latest", status: "running" };
const committed: RunView = {
  turn: 1,
  toolLog: [a],
  outputs: [{ id: "text1", text: "Committed answer", toolCount: 1 }],
  partialAnswer: "",
};

for (const explicitBoundary of [true, false]) {
  test(`restart repairs a completed output's missing log checkpoint without resending or resealing (toolCount ${explicitBoundary ? "present" : "absent"})`, async (t) => {
    const view = explicitBoundary
      ? committed
      : {
          ...committed,
          outputs: [{ id: "text1", text: "Committed answer" }],
        };
    const f = fixture(t);
    const first = f.create();
    await first.onRun("s", { turn: 1, toolLog: [a], partialAnswer: "" });
    f.failNextBoundary();
    await assert.rejects(first.onRun("s", view), /boundary checkpoint failed/);
    assert.equal(f.failed, true);
    const crashed = f.receipt();
    assert.equal(crashed.outputs?.[0]?.complete, true);
    assert.equal(crashed.outputs?.[0]?.pending, false);
    assert.equal(crashed.outputs?.[0]?.segmentEnd, 1);
    assert.equal(crashed.logStart, undefined);
    const oldLog = crashed.logMessageIds?.[0];
    assert.ok(oldLog);
    const acceptedIds = crashed.outputs?.[0]?.messageIds;
    assert.ok(acceptedIds);
    const answerId = acceptedIds[0];
    assert.ok(answerId);
    await first.close();

    const replay = f.create();
    const recoveryStart = f.calls.length;
    await replay.onRun("s", view);
    assert.equal(f.receipt().logStart, 1);
    assert.deepEqual(f.receipt().sealedLogMessageIds, [oldLog]);
    assert.deepEqual(f.receipt().logMessageIds, []);
    assert.deepEqual(f.receipt().outputs?.[0]?.messageIds, acceptedIds);
    const later = { ...view, toolLog: [a, b, latest] };
    await replay.onRun("s", later);
    const newLog = f.receipt().logMessageIds?.[0];
    assert.ok(newLog);
    assert.ok(newLog > answerId);
    await replay.onRun("s", later);
    assert.deepEqual(f.receipt().logMessageIds, [newLog]);
    assert.deepEqual(f.receipt().sealedLogMessageIds, [oldLog]);
    assert.equal(
      f.calls.filter(
        (call) =>
          call.method === "sendMessage" &&
          call.params.text === "Committed answer",
      ).length,
      1,
    );
    assert.ok(
      !f.calls
        .slice(recoveryStart)
        .some(
          (call) =>
            (call.method === "editMessageText" ||
              call.method === "deleteMessage") &&
            call.params.message_id === oldLog,
        ),
      "recovery must not reseal the already published log above the answer",
    );
    const sentLog = f.calls.find((call) => call.id === newLog);
    assert.ok(sentLog);
    assert.match(String(sentLog.params.text), /Read b/);
    assert.doesNotMatch(String(sentLog.params.text), /Read a/);
  });
}
