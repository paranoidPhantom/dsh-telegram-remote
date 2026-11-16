import test from "node:test";
import assert from "node:assert/strict";
import {
  runProjection,
  toolSummary,
} from "../src/projection/run-projection.js";
import { foldRun, initialRun, type RunEvent } from "./run-fixtures.js";
const call = (id: string, name: string, time: number): RunEvent => ({
  type: "tool/call",
  time,
  data: {
    callId: id,
    name,
    arguments: JSON.stringify({ description: `Inspect ${id}` }),
  },
});
const result = (id: string, time: number, error: boolean): RunEvent => ({
  type: "tool/result",
  time,
  data: {
    message: {
      toolCallId: id,
      source: { callId: id },
      isError: error,
      content: [
        { type: "text", text: error ? "Permission denied" : "Success" },
      ],
    },
  },
});
test("ordered full-turn log resolves parallel calls independently", () => {
  let s = foldRun(initialRun(), {
    type: "turn/start",
    time: 0,
    data: { turn: 1 },
  });
  s = foldRun(s, call("a", "read", 1));
  s = foldRun(s, call("b", "bash", 2));
  s = foldRun(s, result("b", 3, true));
  s = foldRun(s, result("a", 4, false));
  assert.deepEqual(
    s.toolLog.map((x) => [x.callId, x.status]),
    [
      ["a", "completed"],
      ["b", "failed"],
    ],
  );
  assert.ok(s.toolLog[0]);
  assert.ok(s.toolLog[1]);
  assert.equal(s.toolLog[0].summary, "Inspect a");
  assert.equal(s.toolLog[1].result, "Permission denied");
  assert.equal(runProjection.stateSchema.safeParse(s).success, true);
});
test("turn end cancels unfinished calls without discarding prior completed tools", () => {
  let s = foldRun(initialRun(), call("a", "read", 1));
  s = foldRun(s, result("a", 2, false));
  s = foldRun(s, call("b", "bash", 3));
  s = foldRun(s, {
    type: "turn/end",
    time: 4,
    data: { reason: { kind: "aborted" } },
  });
  assert.deepEqual(
    s.toolLog.map((x) => x.status),
    ["completed", "cancelled"],
  );
});
test("duplicate call IDs do not duplicate rows and unknown results preserve reference", () => {
  const s = foldRun(initialRun(), call("a", "read", 1));
  assert.equal(foldRun(s, call("a", "read", 1)), s);
  assert.equal(foldRun(s, result("unknown", 3, false)), s);
});
test("log retains all 200 tool calls rather than only last current tool", () => {
  let s = initialRun();
  for (let i = 0; i < 200; i++) {
    s = foldRun(s, call(String(i), "read", i));
    s = foldRun(s, result(String(i), i, false));
  }
  assert.equal(s.toolLog.length, 200);
  assert.ok(s.toolLog[0]);
  const last = s.toolLog.at(-1);
  assert.ok(last);
  assert.equal(s.toolLog[0].callId, "0");
  assert.equal(last.callId, "199");
});
test("tool summaries show action instead of argument JSON", () => {
  assert.equal(
    toolSummary('{"file_path":"notes.md","content":"secret text"}'),
    "notes.md",
  );
  assert.equal(toolSummary('{"command":"pwd"}'), "pwd");
});
