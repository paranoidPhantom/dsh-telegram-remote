import assert from "node:assert/strict";
import test from "node:test";
import { UpdateIngress } from "../../src/child/ingress.js";
import type { InboxEntry } from "../../src/host/inbox.js";
import { jsonObject } from "../../src/protocol/json.js";

test("normal concurrency is bounded across topics with one reserved priority slot", async () => {
  const controller = new AbortController();
  const entries: InboxEntry[] = Array.from({ length: 20 }, (_, id) => ({
    updateId: id,
    ownerEpoch: 1,
    operation: { id, priority: id === 19 },
  }));
  const releases: (() => void)[] = [];
  let normal = 0;
  let peak = 0;
  let priority = 0;
  const ingress = new UpdateIngress({
    signal: controller.signal,
    maxActive: 2,
    retryMs: 1,
    onError: (error) => {
      throw error;
    },
    getOffset: async () => 20,
    api: {
      call: async (_method, _params, signal) => {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return [];
      },
    },
    admit: async () => "duplicate",
    pending: async () => entries,
    settle: async (entry) => {
      const index = entries.indexOf(entry);
      if (index >= 0) entries.splice(index, 1);
    },
    classify: (operation) => ({
      key: jsonObject(operation) ? String(operation.id) : "",
      priority: jsonObject(operation) && operation.priority === true,
    }),
    handle: async (operation) => {
      assert.ok(jsonObject(operation));
      const urgent = operation.priority === true;
      if (urgent) priority++;
      else {
        normal++;
        peak = Math.max(peak, normal);
      }
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      if (!urgent) normal--;
    },
  });
  const running = ingress.run();
  for (let n = 0; n < 100 && releases.length < 3; n++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(releases.length, 3);
  assert.equal(peak, 2);
  assert.equal(priority, 1);
  controller.abort();
  await running;
  for (const release of releases) release();
  await ingress.drain();
});
