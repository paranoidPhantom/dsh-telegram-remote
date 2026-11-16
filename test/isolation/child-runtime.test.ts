import { test } from "node:test";
import assert from "node:assert/strict";
import { ChildRuntime } from "../../src/child/runtime.js";
import { parseChildArguments } from "../../src/child/index.js";
import { ChildSupervisor } from "../../src/host/supervisor.js";

test("child entry requires explicit generation and build without secrets", () => {
  assert.deepEqual(
    parseChildArguments([
      "--telegram-generation",
      "g",
      "--telegram-build",
      "b",
    ]),
    { generation: "g", build: "b" },
  );
  assert.throws(() => parseChildArguments(["--telegram-generation", "g"]));
  assert.deepEqual(
    parseChildArguments(["--telegram-generation=g", "--telegram-build=b"]),
    { generation: "g", build: "b" },
  );
  assert.throws(() =>
    parseChildArguments([
      "--telegram-generation=g",
      "--telegram-generation",
      "g",
      "--telegram-build=b",
    ]),
  );
});

test(
  "actual launcher starts child entry and completes hello without Telegram",
  { timeout: 10000 },
  async () => {
    const supervisor = new ChildSupervisor({
      entry: new URL("../../src/child/index.js", import.meta.url),
      generation: "entry-generation",
      build: "entry-build",
      startupTimeoutMs: 3000,
      shutdownTimeoutMs: 2000,
      maxRestarts: 0,
    });
    try {
      await supervisor.start();
      assert.equal(supervisor.state, "running");
      assert.notEqual(supervisor.pid, process.pid);
    } finally {
      await supervisor.close();
    }
    assert.equal(supervisor.state, "closed");
  },
);

test("child rejects work before initialization and shutdown is idempotent", async () => {
  const calls: string[] = [];
  const runtime = new ChildRuntime({
    peer: {
      request: async (method) => {
        calls.push(method);
        return null;
      },
    },
    generation: "g",
    build: "b",
    drainMs: 10,
  });
  const run = runtime.handlers["run.push"];
  assert.ok(run);
  await assert.rejects(
    run({ sessionId: "s", view: { turn: 1 } }, new AbortController().signal),
    /not initialized/,
  );
  assert.deepEqual(calls, []);
  const first = runtime.shutdown();
  assert.equal(runtime.controller.signal.aborted, true);
  assert.equal(runtime.shutdown(), first);
  await first;
});

test("child validates run views before any remote work", async () => {
  const runtime = new ChildRuntime({
    peer: { request: async () => null },
    generation: "g",
    build: "b",
  });
  const run = runtime.handlers["run.push"];
  assert.ok(run);
  await assert.rejects(
    run(
      { sessionId: "s", view: { turn: { bad: true } } },
      new AbortController().signal,
    ),
  );
  await runtime.shutdown();
});
