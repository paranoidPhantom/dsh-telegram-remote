import { inlineMarkup, requiredField } from "./console-param-checks.js";
import test from "node:test";
import assert from "node:assert/strict";
import { FixtureConsole as TelegramConsole } from "./console-constructor.js";
import type {
  TelegramMethod,
  TelegramParams,
  ConsoleDocument,
} from "../src/bot/contracts.js";
import { TOPIC_TUTORIAL, topicModeError } from "../src/i18n/topic-mode.js";
import type { ApiParams } from "./console-fixture-types.js";
test("disabled topic mode shows BotFather instructions and tutorial before sessions", async () => {
  const sent: ApiParams[] = [];
  let lists = 0;
  const c = new TelegramConsole({
    signal: undefined,
    ownerId: 1,
    api: {
      call: async (method: TelegramMethod, p: TelegramParams = {}) =>
        method === "getMe"
          ? { has_topics_enabled: false }
          : (sent.push(p), { message_id: 1 }),
    },
    bridge: {
      list: async () => {
        lists++;
        return [];
      },
    },
    store: {
      entries: async () => [],
      get: async () => undefined,
      set: async () => {},
    },
  });
  await c.handleUpdate({
    message: {
      message_id: 1,
      from: { id: 1 },
      chat: { id: 1, type: "private" },
      text: "/start",
    },
  });
  assert.equal(lists, 0);
  assert.ok(requiredField(sent[0]!.text).includes("@BotFather"));
  assert.ok(requiredField(sent[0]!.text).includes(TOPIC_TUTORIAL));
  c.close();
});
test("forum rejection is recognized", () =>
  assert.equal(
    topicModeError(
      Error("createForumTopic: Bad Request: the chat is not a forum"),
    ),
    true,
  ));
