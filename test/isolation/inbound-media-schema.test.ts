import test from "node:test";
import assert from "node:assert/strict";
import { ChildRuntime } from "../../src/child/runtime.js";
import { inboundMedia } from "../../src/files/inbound-media.js";
import type { TelegramUpdate } from "../../src/bot/contracts.js";

// Exercise the runtime's actual private admission method without exporting the
// schema or starting networking. A surface spy receives the post-schema DTO.
test("child runtime preserves inbound media and caption through update parsing", async () => {
  const runtime = new ChildRuntime({
    generation: "g",
    build: "b",
    peer: { request: async () => null },
  });
  let seen: TelegramUpdate | undefined;
  Reflect.set(runtime, "surface", {
    handleUpdate: async (update: TelegramUpdate) => {
      seen = update;
    },
  });
  const handle: unknown = Reflect.get(runtime, "handleUpdate");
  assert.equal(typeof handle, "function");
  const cases = [
    {
      photo: [
        { file_id: "large", width: 100, height: 100 },
        { file_id: "small", width: 10, height: 10 },
      ],
    },
    { sticker: { file_id: "sticker", is_video: true, is_animated: false } },
    ...["audio", "voice", "document", "video", "animation", "video_note"].map(
      (kind) => ({
        [kind]: {
          file_id: kind,
          file_name: "original.pdf",
          mime_type: "application/pdf",
          file_size: 100,
        },
      }),
    ),
  ];
  for (const media of cases) {
    await Reflect.apply(handle as (...args: unknown[]) => unknown, runtime, [
      {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 1, type: "private" },
          from: { id: 1 },
          caption: "caption",
          ...media,
        },
      },
    ]);
    assert.ok(seen?.message);
    assert.equal(seen.message.caption, "caption");
    assert.ok(inboundMedia(seen.message));
    if ("photo" in media)
      assert.equal(inboundMedia(seen.message)?.fileId, "large");
    if ("sticker" in media)
      assert.equal(inboundMedia(seen.message)?.name, "sticker.webm");
    if ("document" in media)
      assert.equal(inboundMedia(seen.message)?.name, "original.pdf");
  }
});
