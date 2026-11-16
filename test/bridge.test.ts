import test from "node:test";
import assert from "node:assert/strict";
import {
  foldRun as bridgeFoldRun,
  initialRun as bridgeInitialRun,
} from "../src/bridge/bridge.js";
import type { RunState, RunEvent } from "./run-fixtures.js";
const initialRun: () => RunState = bridgeInitialRun;
const foldRun: (state: RunState, event: RunEvent) => RunState = bridgeFoldRun;
test("run fold preserves answer text and resets for a new turn", () => {
  let s = initialRun();
  s = foldRun(s, { type: "turn/start", time: 1000, data: { turn: 1 } });
  s = foldRun(s, {
    type: "request/header",
    data: { header: { config: { model: "m" } } },
  });
  s = foldRun(s, {
    type: "tool/call",
    time: 1100,
    data: {
      callId: "call-1",
      name: "read",
      arguments: '{"file_path":"notes.md"}',
    },
  });
  s = foldRun(s, {
    type: "assistant/message",
    data: {
      message: {
        content: [
          { type: "text", text: "Hello" },
          { type: "reasoning", text: "hidden" },
          { type: "text", text: "world" },
        ],
      },
    },
  });
  s = foldRun(s, {
    type: "turn/end",
    time: 2000,
    data: { reason: { kind: "completed" } },
  });
  assert.equal(s.answer, "Hello\nworld");
  assert.equal(s.tools, 1);
  assert.equal(s.final, true);
  assert.equal(s.model, "m");
  const next = foldRun(s, {
    type: "turn/start",
    time: 3000,
    data: { turn: 2 },
  });
  assert.equal(next.answer, "");
  assert.equal(next.final, false);
  assert.equal(next.turn, 2);
});
test("unrelated events preserve projection reference", () => {
  const s = initialRun();
  assert.equal(foldRun(s, { type: "session/title", data: { title: "x" } }), s);
});
