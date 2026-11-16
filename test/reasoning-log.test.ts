import test from "node:test";
import assert from "node:assert/strict";
import {
  foldRun,
  initialRun,
  reasoningPreview,
  runProjection,
} from "../src/projection/run-projection.js";
import { semanticRunView } from "../src/bridge/console-adapter.js";
import { toolLogPages } from "../src/rendering/console-render.js";
import { createTranslator } from "../src/i18n/bot-i18n.js";
import { deliveryFixture, sentMessageId } from "./delivery-fixture.js";

test("reasoning is bounded, astral safe, idempotent and separate from tools/answers", () => {
  let s = foldRun(initialRun(), {
    type: "assistant/message",
    seq: 1,
    data: {
      message: {
        content: [
          { type: "reasoning", text: "x".repeat(238) + "😀rest" },
          { type: "text", text: "Answer" },
          { type: "encrypted-reasoning", text: "SECRET" },
        ],
      },
    },
  });
  assert.equal(s.tools, 0);
  assert.equal(s.toolLog.length, 0);
  assert.equal(s.answer, "Answer");
  assert.equal(s.outputs[0]?.toolCount, 0);
  assert.equal(s.outputs[0]?.logCount, 1);
  assert.equal(s.activityLog[0]?.kind, "reasoning");
  assert.equal(
    reasoningPreview(["x".repeat(238) + "😀rest"]),
    "x".repeat(238) + "…",
  );
  s = foldRun(s, {
    type: "assistant/attempt",
    seq: 2,
    data: {
      stream: [
        { type: "reasoning-chunks", texts: ["<inspect>", " & compare"] },
        {
          type: "chunk",
          chunk: { type: "reasoning-delta", text: " carefully" },
        },
        { type: "chunk", chunk: { type: "signature", text: "SECRET" } },
        { type: "text-chunks", texts: ["Partial"] },
      ],
    },
  });
  const before = s.activityLog;
  s = foldRun(s, {
    type: "assistant/attempt",
    seq: 2,
    data: { stream: [{ type: "reasoning-chunks", texts: ["duplicate"] }] },
  });
  assert.equal(s.activityLog, before);
  assert.equal(s.partialAnswer, "Partial");
  const view = semanticRunView({ ...s, cwd: "/workspace", elapsed: 0 });
  assert.equal(view.toolLog?.length, 0);
  assert.equal(view.runLog?.length, 2);
  assert.ok(!JSON.stringify(view).includes("SECRET"));
  for (const locale of ["en", "zh", "ru"]) {
    const t = createTranslator(() => locale);
    const html = toolLogPages(view.runLog, false, undefined, t, [
      { pattern: "reasoning", emoji: "🧠" },
    ]).join("");
    assert.ok(html.includes(t("reasoningPreview")));
    assert.ok(html.includes("&lt;inspect&gt; &amp; compare carefully"));
    assert.ok(html.includes("🧠"));
    assert.ok(!html.includes("<inspect>"));
  }
  assert.equal(runProjection.stateVersion, 8);
  assert.ok(runProjection.stateSchema.safeParse(s).success);
});

test("reasoning history has a per-turn cap and clears with the turn", () => {
  let s = initialRun();
  for (let seq = 0; seq < 100; seq++)
    s = foldRun(s, {
      type: "assistant/attempt",
      seq,
      data: {
        stream: [{ type: "reasoning-chunks", texts: ["a".repeat(1000)] }],
      },
    });
  assert.equal(s.activityLog.length, 64);
  assert.ok(
    s.activityLog.every(
      (row) => row.kind === "reasoning" && row.text.length === 240,
    ),
  );
  s = foldRun(s, { type: "turn/start", time: 1, data: { turn: 2 } });
  assert.deepEqual(s.activityLog, []);
});

test("legacy in-flight receipts retain tool-only boundaries during upgrade", async (t) => {
  const f = deliveryFixture(t);
  const first = { callId: "a", name: "read", status: "completed" };
  const second = { callId: "b", name: "write", status: "completed" };
  const reasoning = { kind: "reasoning" as const, text: "Do not backfill" };
  f.data.set("console:run:s:1", {
    chatId: 1,
    threadId: 2,
    logStart: 1,
    sealedLogMessageIds: [99],
  });
  await f.surface.onRun("s", {
    turn: 1,
    final: true,
    toolLog: [first, second],
    runLog: [reasoning, first, reasoning, second],
    outputs: [
      { id: "old", text: "Already delivered", toolCount: 1, logCount: 2 },
      { id: "new", text: "New answer", toolCount: 2, logCount: 4 },
    ],
  });
  const logs = f.calls.filter(
    (c) =>
      c.params.parse_mode === "HTML" && c.params.text?.includes("blockquote"),
  );
  assert.ok(logs.some((c) => c.params.text?.includes("write")));
  assert.ok(
    logs.every(
      (c) =>
        !c.params.text?.includes("Do not backfill") &&
        !c.params.text?.includes("read"),
    ),
  );
  assert.ok(f.calls.every((c) => c.params.message_id !== 99));
  assert.equal(f.record("console:run:s:1").logStart, 2);
});

test("reasoning-only log is delivered before its answer and never in drafts; tools retain segmentation", async (t) => {
  const { surface: c, calls, record } = deliveryFixture(t);
  const reasoning = { kind: "reasoning" as const, text: "Inspect <safe>" };
  await c.onRun("s", {
    turn: 1,
    runLog: [reasoning],
    toolLog: [],
    outputs: [],
  });
  const firstLog = calls.find((call) => call.params.text?.includes("Inspect"));
  assert.ok(firstLog);
  assert.ok(firstLog.params.text?.includes("Inspect &lt;safe&gt;"));
  assert.ok(
    !calls
      .filter((call) => call.method === "sendMessageDraft")
      .some((call) => call.params.text?.includes("Inspect")),
  );
  const output = { id: "1", text: "Answer", toolCount: 0, logCount: 1 };
  await c.onRun("s", {
    turn: 1,
    runLog: [reasoning],
    toolLog: [],
    outputs: [output],
  });
  assert.equal(record("console:run:s:1").logStart, 1);
  const answer = calls.find(
    (call) => call.method === "sendMessage" && call.params.text === "Answer",
  );
  assert.ok(answer);
  const firstLogId = firstLog.params.message_id ?? sentMessageId(firstLog);
  assert.ok(sentMessageId(answer) > firstLogId);
  const start = calls.length;
  const tool = {
    kind: "tool" as const,
    callId: "a",
    name: "read",
    status: "completed",
  };
  await c.onRun("s", {
    turn: 1,
    final: true,
    runLog: [reasoning, tool],
    toolLog: [tool],
    outputs: [output],
  });
  const later = calls
    .slice(start)
    .filter((call) => call.params.parse_mode === "HTML");
  assert.ok(later.some((call) => call.params.text?.includes("read")));
  assert.ok(later.every((call) => !call.params.text?.includes("Inspect")));
  assert.equal(
    calls.filter(
      (call) => call.method === "sendMessage" && call.params.text === "Answer",
    ).length,
    1,
  );
});
