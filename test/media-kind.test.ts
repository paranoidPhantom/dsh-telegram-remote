import test from "node:test";
import assert from "node:assert/strict";
import { mediaKind } from "../src/files/media-kind.js";
import {
  TelegramAdapter,
  type TelegramApiPort,
} from "../src/telegram/adapter.js";
import { required } from "./fixture-assertions.js";
test("supported media requires container signature as well as extension", () => {
  assert.equal(
    mediaKind("a.png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "photo",
  );
  assert.equal(mediaKind("a.jpg", Buffer.from([255, 216, 255])), "photo");
  assert.equal(mediaKind("a.gif", Buffer.from("GIF89a")), "animation");
  assert.equal(mediaKind("a.mp4", Buffer.from("\0\0\0\0ftypisom")), "video");
  assert.equal(mediaKind("a.m4a", Buffer.from("\0\0\0\0ftypM4A ")), "audio");
  assert.equal(mediaKind("a.mp3", Buffer.from("ID3")), "audio");
  assert.equal(mediaKind("fake.png", Buffer.from("not image")), "document");
  assert.equal(mediaKind("a.pdf", Buffer.from("%PDF")), "document");
});
test("adapter uses native media method and preserves path caption", async () => {
  let sent:
    | {
        method: string;
        params: Parameters<NonNullable<TelegramApiPort["sendAudio"]>>[0];
      }
    | undefined;
  const a = new TelegramAdapter({
    credentials: {
      readRecord: async () => ({ kind: "api-key", key: "123:fake" }),
    },
    credentialKey: "bot",
    createApi: () => ({
      sendAudio: async (params) => {
        sent = { method: "sendAudio", params };
        return { message_id: 1 };
      },
    }),
  });
  await a.file({
    chatId: 1,
    threadId: 2,
    name: "result.mp3",
    content: Buffer.from("ID3"),
    caption: "out/result.mp3",
  });
  assert.equal(required(sent).method, "sendAudio");
  assert.equal(required(required(sent).params).caption, "out/result.mp3");
  assert.equal(required(required(sent).params).message_thread_id, 2);
});
