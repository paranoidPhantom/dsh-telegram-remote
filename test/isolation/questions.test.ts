import test from "node:test";
import assert from "node:assert/strict";
import { QuestionRegistry } from "../../src/host/questions.js";
import { registerQuestionForwarding } from "../../src/host/question-forwarding.js";
import type { HostQuestionRequest } from "../../src/host/question-forwarding.js";
import type { QuestionAnswer } from "../../src/protocol/questions.js";

const items = [
  { id: "q", question: "Choose", options: [{ label: "A" }, { label: "B" }] },
];
const answer = { answers: [{ id: "q", selected: ["A"] }] };
const actor = {
  ownerId: 7,
  ownerEpoch: 1,
  generation: "g",
  chatId: 7,
  threadId: 9,
};

test("question capability validates exact owner/topic/generation and complete original labels", async () => {
  const registry = new QuestionRegistry();
  const controller = new AbortController();
  const pending = registry.register(
    { ...actor, sessionId: "s", signal: controller.signal },
    items,
  );
  for (const forged of [
    { ...actor, ownerId: 8 },
    { ...actor, ownerEpoch: 2 },
    { ...actor, generation: "old" },
    { ...actor, chatId: 8 },
    { ...actor, threadId: 10 },
  ])
    assert.throws(() => registry.answer(pending.id, forged, answer));
  for (const invalid of [
    { answers: [] },
    { answers: [{ id: "wrong", selected: [] }] },
    { answers: [{ id: "q", selected: ["forged"] }] },
    { answers: [{ id: "q", selected: ["A", "B"] }] },
    { answers: [{ id: "q", selected: ["A"], custom: "text" }] },
  ])
    assert.throws(() => registry.answer(pending.id, actor, invalid));
  registry.answer(pending.id, actor, answer);
  assert.deepEqual(await pending.result, answer);
  assert.throws(() => registry.answer(pending.id, actor, answer));
});

test("question abort and generation close revoke pending resolvers", async () => {
  const registry = new QuestionRegistry();
  const controller = new AbortController();
  const first = registry.register(
    { ...actor, sessionId: "s", signal: controller.signal },
    items,
  );
  const rejected = assert.rejects(first.result);
  controller.abort();
  await rejected;
  const next = registry.register(
    { ...actor, sessionId: "s", signal: new AbortController().signal },
    items,
  );
  const closed = assert.rejects(next.result);
  registry.cancelGeneration("g");
  await closed;
  assert.throws(() => registry.answer(next.id, actor, answer));
});

test("forwarding delegates unsupported intents/timed/unmapped and never trusts presentation ACK as an answer", async () => {
  let listener!: (
    request: HostQuestionRequest,
    next: () => Promise<QuestionAnswer>,
  ) => Promise<QuestionAnswer>;
  let sent = 0;
  const registry = new QuestionRegistry();
  registerQuestionForwarding(
    {
      on(_name, fn) {
        listener = fn;
      },
    },
    {
      questions: registry,
      signal: new AbortController().signal,
      surface: {
        async getTopic(id) {
          return id === "s" ? { chatId: 7, threadId: 9 } : undefined;
        },
      },
      ...actor,
      peer: {
        async request(method) {
          if (method === "question.request") sent++;
          return null;
        },
      },
    },
  );
  let delegated = 0;
  const next = async () => {
    delegated++;
    return answer;
  };
  for (const request of [
    { questions: items },
    { agent: { id: "unknown" }, questions: items },
    {
      agent: { id: "s" },
      questions: items,
      wait: { callId: "c", timed: true },
    },
    {
      agent: { id: "s" },
      questions: [{ ...items[0], intent: { kind: "approval" } }],
    },
  ])
    await listener(request, next);
  assert.equal(delegated, 4);
  await assert.rejects(
    listener({ agent: { id: "s" }, questions: items }, next),
  );
  assert.equal(sent, 1);
});
