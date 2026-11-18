import test from "node:test";
import assert from "node:assert/strict";
import { ConsoleQuestions } from "../src/bot/console-questions.js";
import type {
  TelegramParams,
  TelegramMethod,
  TelegramMessage,
} from "../src/bot/contracts.js";
import type { QuestionAnswer } from "../src/protocol/questions.js";

function fixture() {
  const calls: { method: TelegramMethod; params: TelegramParams }[] = [];
  const submitted: QuestionAnswer[] = [];
  let messageId = 0;
  let rejectSubmit = false;
  const ui = new ConsoleQuestions({
    api: {
      async call(method, params = {}) {
        calls.push({ method, params });
        return { message_id: ++messageId };
      },
      async document() {},
    },
    t: (key, params) =>
      key === "questionSelected" ? `Selected: ${params?.selected}` : key,
    async submit(_id, answer) {
      if (rejectSubmit) throw new Error("Host rejected");
      submitted.push(answer);
    },
  });
  const ctx = { chatId: 1, threadId: 2 };
  const token = (label: string) => {
    for (const call of [...calls].reverse()) {
      const markup = call.params.reply_markup;
      if (markup && "inline_keyboard" in markup) {
        const button = markup.inline_keyboard
          .flat()
          .find((button) => button.text.includes(label));
        if (button?.callback_data) return button.callback_data;
      }
    }
    throw Error(`No button ${label}`);
  };
  const ready = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const reply = (
    text: string,
    replyTo: number,
    thread = 2,
  ): TelegramMessage => ({
    message_id: 999,
    chat: { id: 1, type: "private" },
    message_thread_id: thread,
    text,
    reply_to_message: { message_id: replyTo },
  });
  return {
    ui,
    calls,
    submitted,
    ctx,
    token,
    ready,
    reply,
    rejectSubmit: () => {
      rejectSubmit = true;
    },
    acceptSubmit: () => {
      rejectSubmit = false;
    },
  };
}

test("sequential questions retain IDs, multi toggles and skipped answers; opaque context-bound tokens", async () => {
  const f = fixture();
  const answer = f.ui.request(
    "request",
    f.ctx,
    [
      {
        id: "first",
        question: "Choose",
        multiSelect: true,
        options: [{ label: "Alpha" }, { label: "Beta" }],
      },
      { id: "second", question: "Skip me" },
    ],
    new AbortController().signal,
  );
  await f.ready();
  const stale = f.token("Alpha");
  assert.ok(stale.startsWith("q:"));
  assert.ok(Buffer.byteLength(stale) < 64);
  await f.ui.callback(stale, { ...f.ctx, threadId: 3 });
  await f.ui.callback(stale, f.ctx);
  await f.ui.callback(f.token("Beta"), f.ctx);
  await f.ui.callback(f.token("Alpha"), f.ctx); // toggle Alpha off
  await f.ui.callback(f.token("questionDone"), f.ctx);
  await f.ui.callback(stale, f.ctx); // retired token is inert
  await f.ui.callback(f.token("questionSkip"), f.ctx);
  assert.deepEqual(await answer, {
    answers: [
      { id: "first", selected: ["Beta"] },
      { id: "second", selected: [] },
    ],
  });
  assert.equal(f.submitted.length, 1);
  assert.equal(f.ui.protects(1, f.ctx), false);
});

test("single selection replaces prior choice and never submits before Done", async () => {
  const f = fixture();
  const answer = f.ui.request(
    "one",
    f.ctx,
    [
      {
        id: "one",
        question: "Pick one",
        options: [{ label: "Alpha" }, { label: "Beta" }],
      },
    ],
    new AbortController().signal,
  );
  await f.ready();
  await f.ui.callback(f.token("Alpha"), f.ctx);
  await f.ui.callback(f.token("Beta"), f.ctx);
  assert.deepEqual(f.submitted, []);
  await f.ui.callback(f.token("questionDone"), f.ctx);
  assert.deepEqual(await answer, {
    answers: [{ id: "one", selected: ["Beta"] }],
  });
});

test("custom text requires exact explicit reply; rejected Host submission stays retryable", async () => {
  const f = fixture();
  const answer = f.ui.request(
    "request",
    f.ctx,
    [{ id: "q", question: "Question", options: [{ label: "Alpha" }] }],
    new AbortController().signal,
  );
  await f.ready();
  assert.equal(f.ui.protects(1, f.ctx), true);
  assert.equal(
    await f.ui.reply({ ...f.reply("stray", 1), reply_to_message: undefined }),
    false,
  );
  assert.equal(await f.ui.reply(f.reply("wrong topic", 1, 3)), false);
  assert.equal(await f.ui.reply(f.reply("wrong message", 100)), false);
  f.rejectSubmit();
  await f.ui.callback(f.token("questionOther"), f.ctx);
  await f.ui.reply(f.reply("<custom> & text", 1));
  assert.equal(f.submitted.length, 0);
  assert.equal(f.ui.protects(1, f.ctx), true);
  f.acceptSubmit();
  await f.ui.callback(f.token("questionDone"), f.ctx);
  assert.deepEqual(await answer, {
    answers: [{ id: "q", selected: [], custom: "<custom> & text" }],
  });
  assert.ok(
    f.calls.some(
      (call) =>
        call.method === "editMessageText" &&
        call.params.text?.includes("&lt;custom&gt; &amp; text"),
    ),
  );
});

test("long supporting detail and options render completely in escaped bounded HTML chunks", async () => {
  const f = fixture();
  const detail = "<detail>&😀".repeat(3000);
  const description = "<description>".repeat(300);
  const answer = f.ui.request(
    "long",
    f.ctx,
    [
      {
        id: "q",
        question: "<question>",
        detail,
        options: [{ label: "Option", description }],
      },
    ],
    new AbortController().signal,
  );
  await f.ready();
  // Await all immediate mocked sends, independent of chunk count.
  for (let i = 0; i < 100; i++) await Promise.resolve();
  const texts = f.calls
    .filter((call) => call.method === "sendMessage")
    .map((call) => call.params.text!);
  assert.ok(texts.length > 1);
  assert.ok(texts.every((text) => text.length <= 3500));
  const joined = texts
    .join("")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  assert.ok(joined.includes(detail));
  assert.ok(joined.includes(description));
  assert.ok(joined.includes("questionReplyHint"));
  await f.ui.callback(f.token("questionSkip"), f.ctx);
  await answer;
  assert.equal(
    f.calls.filter((call) => call.method === "deleteMessage").length,
    0,
  );
});

test("abort and close reject pending requests and stale callbacks cannot submit", async () => {
  const f = fixture();
  const controller = new AbortController();
  const answer = f.ui.request(
    "q",
    f.ctx,
    [{ id: "q", question: "Question" }],
    controller.signal,
  );
  const rejected = assert.rejects(answer, { name: "AbortError" });
  await f.ready();
  const stale = f.token("questionDone");
  controller.abort();
  await rejected;
  await f.ui.callback(stale, f.ctx);
  assert.equal(f.submitted.length, 0);
  const second = f.ui.request(
    "next",
    f.ctx,
    [{ id: "next", question: "Next" }],
    new AbortController().signal,
  );
  const closed = assert.rejects(second, { name: "AbortError" });
  f.ui.close();
  await closed;
  assert.equal(await f.ui.callback("facade-token", f.ctx), false);
  await assert.rejects(
    f.ui.request("closed", f.ctx, [], new AbortController().signal),
    { name: "AbortError" },
  );
});
