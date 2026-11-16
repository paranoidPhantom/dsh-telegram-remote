import test from "node:test";
import assert from "node:assert/strict";
import { deliveryFixture, sentMessageId } from "./delivery-fixture.js";
test("assistant text seals previous log and subsequent tools start below it", async (t) => {
  const { surface: c, calls, record } = deliveryFixture(t);
  const a = { callId: "a", name: "ReadA", status: "completed" },
    b = { callId: "b", name: "ReadB", status: "completed" },
    latest = { callId: "latest", name: "Latest sentinel", status: "running" };
  await c.onRun("s", { turn: 1, toolLog: [a], outputs: [], partialAnswer: "" });
  assert.deepEqual(record("console:run:s:1").logMessageIds || [], []);
  await c.onRun("s", {
    turn: 1,
    toolLog: [a],
    outputs: [{ id: "text1", text: "Progress report", toolCount: 1 }],
    partialAnswer: "",
  });
  const sealedLogMessageIds = record("console:run:s:1").sealedLogMessageIds;
  assert.ok(sealedLogMessageIds);
  const oldLog = sealedLogMessageIds[0];
  const text = calls.find(
    (x) => x.method === "sendMessage" && x.params.text === "Progress report",
  );
  const boundary = calls.length;
  await c.onRun("s", {
    turn: 1,
    toolLog: [a, b, latest],
    outputs: [{ id: "text1", text: "Progress report", toolCount: 1 }],
    partialAnswer: "",
  });
  const newLog = calls
    .slice(boundary)
    .find((x) => x.method === "sendMessage" && x.params.parse_mode === "HTML");
  assert.ok(newLog);
  assert.ok(text);
  assert.ok(sentMessageId(newLog) > sentMessageId(text));
  assert.ok(newLog.params.text);
  assert.ok(newLog.params.text.includes("Read b"));
  assert.ok(!newLog.params.text.includes("Read a"));
  assert.ok(
    !calls
      .slice(boundary)
      .some(
        (x) => x.method === "editMessageText" && x.params.message_id === oldLog,
      ),
  );
  await c.onRun("s", {
    turn: 1,
    toolLog: [a, b, latest],
    outputs: [
      { id: "text1", text: "Progress report", toolCount: 1 },
      { id: "text2", text: "Final", toolCount: 3 },
    ],
    final: true,
  });
  assert.ok(
    !calls.some(
      (x) => x.method === "deleteMessage" && x.params.message_id === oldLog,
    ),
  );
});
