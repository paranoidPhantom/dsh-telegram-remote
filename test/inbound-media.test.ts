import test from "node:test";
import assert from "node:assert/strict";
import { inboundMedia } from "../src/files/inbound-media.js";
import type { TelegramMessage } from "../src/bot/contracts.js";

const message = (media: Record<string, unknown>): TelegramMessage => ({
  message_id: 1,
  chat: { id: 1, type: "private" },
  ...media,
});

test("inbound selector picks largest photo without trusting array order", () => {
  assert.deepEqual(
    inboundMedia(
      message({
        photo: [
          { file_id: "large", width: 100, height: 100 },
          { file_id: "small", width: 10, height: 10 },
        ],
      }),
    ),
    { fileId: "large", name: "photo.jpg" },
  );
});
test("inbound selector supports full sticker and media payloads, not thumbnails", () => {
  for (const [flags, ext] of [
    [{}, "webp"],
    [{ is_animated: true }, "tgs"],
    [{ is_video: true }, "webm"],
  ] as const) {
    assert.deepEqual(
      inboundMedia(message({ sticker: { file_id: "s", ...flags } })),
      { fileId: "s", name: `sticker.${ext}` },
    );
  }
  for (const [kind, ext] of [
    ["audio", "mp3"],
    ["voice", "ogg"],
    ["document", "bin"],
    ["video", "mp4"],
    ["animation", "mp4"],
    ["video_note", "mp4"],
  ]) {
    assert.deepEqual(
      inboundMedia(
        message({ [kind!]: { file_id: "f", thumbnail: { file_id: "thumb" } } }),
      ),
      { fileId: "f", name: `${kind}.${ext}` },
    );
  }
});
test("inbound names preserve extensions but remove path and control characters", () => {
  assert.deepEqual(
    inboundMedia(
      message({
        document: {
          file_id: "d",
          file_name: "../../secret\\report.final.PDF\u0000",
        },
      }),
    ),
    { fileId: "d", name: "report.final.PDF" },
  );
  assert.deepEqual(
    inboundMedia(
      message({ animation: { file_id: "a", mime_type: "image/gif" } }),
    ),
    { fileId: "a", name: "animation.gif" },
  );
  assert.deepEqual(
    inboundMedia(
      message({ audio: { file_id: "a", mime_type: "untrusted/exe" } }),
    ),
    { fileId: "a", name: "audio.mp3" },
  );
});
test("inbound selector ignores missing and malformed payloads", () => {
  for (const media of [
    {},
    { photo: [] },
    { sticker: {} },
    { document: { file_id: "" } },
    { photo: [null, {}, { file_id: 3 }] },
  ]) {
    assert.equal(inboundMedia(message(media)), undefined);
  }
});
