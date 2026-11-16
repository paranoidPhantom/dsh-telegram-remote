import test from "node:test";
import assert from "node:assert/strict";
import { runProjection } from "../src/projection/run-projection.js";
import { initialRun, foldRun, type RunEvent } from "./run-fixtures.js";
test("each normal assistant message is retained while reasoning is excluded", () => {
  let s = initialRun();
  for (let i = 1; i <= 2; i++)
    s = foldRun(s, {
      type: "assistant/message",
      seq: i,
      data: {
        turn: 1,
        step: i,
        message: {
          content: [
            { type: "reasoning", text: "private" },
            { type: "text", text: `Output ${i}` },
          ],
        },
      },
    });
  assert.deepEqual(s.outputs, [
    { id: "1", text: "Output 1", toolCount: 0, logCount: 1 },
    { id: "2", text: "Output 2", toolCount: 0, logCount: 2 },
  ]);
  assert.equal(s.answer, "Output 2");
  assert.ok(runProjection.stateSchema.safeParse(s).success);
});
test("stopped attempt restores generated text without reasoning chunks", () => {
  let s = initialRun();
  s = foldRun(s, {
    type: "assistant/attempt",
    data: {
      stream: [
        { type: "reasoning-chunks", texts: ["private"] },
        { type: "text-chunks", texts: ["Partial ", "answer"] },
        { type: "chunk", chunk: { type: "text-delta", text: "!" } },
      ],
    },
  });
  s = foldRun(s, {
    type: "turn/end",
    time: 10,
    data: { reason: { kind: "aborted" } },
  });
  assert.equal(s.partialAnswer, "Partial answer!");
  assert.equal(s.outputs.length, 0);
  assert.equal(s.final, true);
});
test("duplicate committed event is idempotent and next turn clears output state", () => {
  const e: RunEvent = {
    type: "assistant/message",
    seq: 5,
    data: { message: { content: [{ type: "text", text: "hello" }] } },
  };
  let s = foldRun(initialRun(), e);
  s = foldRun(s, e);
  assert.equal(s.outputs.length, 1);
  s = foldRun(s, { type: "turn/start", time: 2, data: { turn: 2 } });
  assert.deepEqual(s.outputs, []);
  assert.equal(s.partialAnswer, "");
});
