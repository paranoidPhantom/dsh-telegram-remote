import test from "node:test";
import assert from "node:assert/strict";
import { required } from "./fixture-assertions.js";
import { createStreamScheduler as createScheduler } from "../src/delivery/stream-scheduler.js";
interface Frame {
  turn: number;
  answer?: string;
  final?: boolean;
}
type Deliver = (id: string, view: Frame) => Promise<unknown>;
function harness(deliver?: Deliver) {
  const timers = new Map<number, () => void>();
  let n = 0;
  const seen: Frame[] = [];
  return {
    timers,
    seen,
    s: createScheduler({
      deliver: deliver ?? (async (id, v) => seen.push(v)),
      setTimer: (fn) => {
        timers.set(++n, fn);
        return n;
      },
      clearTimer: (id) => timers.delete(id),
    }),
    async tick() {
      const entry = timers.entries().next().value;
      if (entry) {
        timers.delete(entry[0]);
        entry[1]();
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}
test("continuous tokens coalesce without postponing existing timer", async () => {
  const h = harness();
  h.s.push("s", { turn: 1, answer: "a" });
  const first = [...h.timers.keys()][0];
  h.s.push("s", { turn: 1, answer: "ab" });
  assert.equal([...h.timers.keys()][0], first);
  await h.tick();
  assert.equal(required(h.seen[0]).answer, "ab");
  h.s.close();
});
test("final wins over delayed tokens and stale older turns", async () => {
  const h = harness();
  h.s.push("s", { turn: 1, answer: "partial" });
  h.s.push("s", { turn: 1, answer: "final", final: true });
  h.s.push("s", { turn: 1, answer: "late" });
  await h.tick();
  assert.equal(required(h.seen[0]).answer, "final");
  h.s.push("s", { turn: 2, answer: "new" });
  h.s.push("s", { turn: 1, final: true, answer: "old" });
  await h.tick();
  assert.equal(required(h.seen[1]).answer, "new");
  h.s.close();
});
test("slow sends maintain one pending frame not an unbounded queue", async () => {
  let release!: () => void;
  const seen: Frame[] = [];
  const h = harness(async (_, v) => {
    seen.push(v);
    if (seen.length === 1) await new Promise<void>((r) => (release = r));
  });
  h.s.push("s", { turn: 1, answer: "a" });
  await h.tick();
  for (let i = 0; i < 100; i++) h.s.push("s", { turn: 1, answer: String(i) });
  assert.equal(h.timers.size, 0);
  release();
  await new Promise((r) => setImmediate(r));
  await h.tick();
  assert.equal(seen.length, 2);
  assert.equal(required(seen[1]).answer, "99");
  h.s.close();
});
test("next queued turn cannot discard preceding final response", async () => {
  const h = harness();
  h.s.push("s", { turn: 1, answer: "first answer", final: true });
  h.s.push("s", { turn: 2, answer: "" }, { immediate: true });
  await h.tick();
  await h.tick();
  assert.equal(required(h.seen[0]).answer, "first answer");
  assert.equal(required(h.seen[1]).turn, 2);
  h.s.close();
});
test("close clears scheduled delivery", async () => {
  const h = harness();
  h.s.push("s", { turn: 1 });
  h.s.close();
  await h.tick();
  assert.equal(h.seen.length, 0);
});
