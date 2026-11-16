import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeLifecycle } from "../src/delivery/runtime-lifecycle.js";
import { pollUpdates } from "../src/telegram/adapter.js";

test("unload aborts an in-flight long poll and waits for its lifetime", async () => {
  const errors: unknown[] = [];
  const runtime = new RuntimeLifecycle((e) => errors.push(e));
  let polls = 0,
    exited = false;
  runtime.launch(
    pollUpdates({
      signal: runtime.signal,
      store: { get: async () => 0, set: async () => {} },
      console: { handleUpdate: async () => {} },
      onError: (e: unknown) => errors.push(e),
      api: {
        call: async () => {
          polls++;
          return new Promise((_, reject) =>
            runtime.signal.addEventListener(
              "abort",
              () => {
                exited = true;
                reject(Error("aborted"));
              },
              { once: true },
            ),
          );
        },
      },
    }),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(polls, 1);
  await runtime.close();
  assert.equal(exited, true);
  assert.equal(errors.length, 0);
  assert.equal(runtime.signal.aborted, true);
});
test("unload clears owned timers before awaiting asynchronous work and is idempotent", async () => {
  const runtime = new RuntimeLifecycle();
  let cleaned = 0;
  runtime.own(() => {
    assert.equal(runtime.signal.aborted, true);
    cleaned++;
  });
  await runtime.close();
  await runtime.close();
  assert.equal(cleaned, 1);
});
