import test from "node:test";
import assert from "node:assert/strict";
import { FixtureConsole } from "./console-constructor.js";
import type { TelegramMessage } from "../src/bot/contracts.js";

function fixture(bound = true) {
  const prompts: unknown[][] = [],
    downloads: string[] = [],
    saves: unknown[][] = [];
  const rows = new Map<string, unknown>(
    bound ? [["console:topic:s", { chatId: 42, threadId: 7 }]] : [],
  );
  let nextMessage = 10;
  const bot = new FixtureConsole({
    ownerId: 42,
    api: {
      async call() {
        return { message_id: nextMessage++ };
      },
      async download(id) {
        downloads.push(id);
        return Buffer.from("image");
      },
    },
    store: {
      async get(key) {
        return rows.get(key);
      },
      async set(key, value) {
        rows.set(key, value);
      },
      async entries() {
        return rows.entries();
      },
    },
    bridge: {
      async metadata() {
        return { cwd: "/work space", running: false };
      },
      async receiveFile(...args) {
        saves.push(args);
        return "/work space/.dsh-telegram-remote/uuid.png";
      },
      async prompt(...args) {
        prompts.push(args);
      },
      async newSessionSelection() {
        return { provider: "p", model: "m" };
      },
      async workspaces() {
        return [];
      },
    },
  });
  const message: TelegramMessage = {
    message_id: 1,
    chat: { id: 42, type: "private" },
    from: { id: 42 },
    message_thread_id: 7,
    document: { file_id: "png", file_name: "a.png" },
    caption: "fun caption",
  };
  return { bot, message, prompts, downloads, saves };
}

test("inbound file becomes quoted workspace @path plus caption with original request identity", async () => {
  const f = fixture();
  await f.bot.handleUpdate({ message: f.message });
  assert.deepEqual(f.downloads, ["png"]);
  assert.equal(f.saves.length, 1);
  assert.deepEqual(f.prompts, [
    [
      "s",
      '@"/work space/.dsh-telegram-remote/uuid.png"\nfun caption',
      "telegram:42:1",
    ],
  ]);
  await f.bot.handleUpdate({ message: f.message });
  assert.equal(f.downloads.length, 1);
  f.bot.close();
});

test("media-only messages forward paths; command-looking captions are user text", async () => {
  const f = fixture();
  delete f.message.caption;
  await f.bot.handleUpdate({ message: f.message });
  assert.equal(
    f.prompts[0]?.[1],
    '@"/work space/.dsh-telegram-remote/uuid.png"',
  );
  f.message.message_id++;
  f.message.caption = "/stop";
  await f.bot.handleUpdate({ message: f.message });
  assert.equal(
    f.prompts[1]?.[1],
    '@"/work space/.dsh-telegram-remote/uuid.png"\n/stop',
  );
  f.bot.close();
});

test("unauthorized or unmapped General media never downloads or saves", async () => {
  const f = fixture();
  await f.bot.handleUpdate({ message: { ...f.message, from: { id: 99 } } });
  await f.bot.handleUpdate({
    message: { ...f.message, chat: { id: 42, type: "group" } },
  });
  await f.bot.handleUpdate({ message: { ...f.message, message_thread_id: 0 } });
  assert.deepEqual(f.downloads, []);
  assert.deepEqual(f.saves, []);
  f.bot.close();
});

test("native topic retains media reference until model confirmation, without early download", async () => {
  const f = fixture(false);
  await f.bot.handleUpdate({ message: f.message });
  assert.deepEqual(f.downloads, []);
  const pending = [...f.bot.actions.values()].find(
    (a) => a.type === "new-confirm",
  );
  assert.ok(pending && pending.type === "new-confirm");
  assert.deepEqual(pending.pending.prompts[0], {
    text: "fun caption",
    requestId: "telegram:42:1",
    media: { fileId: "png", name: "a.png" },
  });
  f.bot.close();
});
