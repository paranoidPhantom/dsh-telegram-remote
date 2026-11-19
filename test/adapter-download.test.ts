import test from "node:test";
import assert from "node:assert/strict";
import {
  TelegramAdapter,
  MAX_TELEGRAM_DOWNLOAD_BYTES,
  type TelegramAdapterOptions,
} from "../src/telegram/adapter.js";

function fixture(
  options: Partial<TelegramAdapterOptions> = {},
  file: unknown = { file_path: "documents/file_1.pdf" },
) {
  return new TelegramAdapter({
    credentials: {
      readRecord: async () => ({ kind: "api-key", key: "123:fake" }),
    },
    credentialKey: "bot",
    createApi: () => ({ getFile: async () => file }),
    ...options,
  });
}
const fail = /Telegram file download failed/;
test("download uses getFile and trusted token URL, returns exact bytes", async () => {
  const api = fixture({
    createApi: () => ({
      getFile: async (params) => {
        assert.deepEqual(params, { file_id: "id" });
        return { file_path: "documents/file_1.pdf", file_size: 3 };
      },
    }),
    downloadFetch: async (url, init) => {
      assert.equal(
        url,
        "https://api.telegram.org/file/bot123:fake/documents/file_1.pdf",
      );
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      return new Response(new Uint8Array([0, 127, 255]));
    },
  });
  assert.deepEqual(await api.download("id"), new Uint8Array([0, 127, 255]));
});
test("download rejects untrusted paths and metadata before fetching", async () => {
  for (const file of [
    {},
    { file_path: "https://evil.test/a" },
    { file_path: "/etc/passwd" },
    { file_path: "../a" },
    { file_path: "a/../b" },
    { file_path: "a%2fb" },
    { file_path: "a?token" },
    { file_path: "a#fragment" },
    { file_path: "a\\b" },
    { file_path: "file.pdf", file_size: MAX_TELEGRAM_DOWNLOAD_BYTES + 1 },
  ]) {
    await assert.rejects(
      fixture(
        {
          downloadFetch: async () => {
            assert.fail("network reached");
          },
        },
        file,
      ).download("id"),
      fail,
    );
  }
});
test("download rejects header and streaming overflow and cancels body", async () => {
  for (const declared of [true, false]) {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_TELEGRAM_DOWNLOAD_BYTES + 1));
      },
      cancel() {
        canceled = true;
      },
    });
    await assert.rejects(
      fixture({
        downloadFetch: async () =>
          new Response(body, {
            headers: declared
              ? { "content-length": String(MAX_TELEGRAM_DOWNLOAD_BYTES + 1) }
              : {},
          }),
      }).download("id"),
      fail,
    );
    assert.equal(canceled, true);
  }
});
test("download accepts exactly 10 MiB", async () => {
  assert.equal(
    (
      await fixture({
        downloadFetch: async () =>
          new Response(new Uint8Array(MAX_TELEGRAM_DOWNLOAD_BYTES)),
      }).download("id")
    ).byteLength,
    MAX_TELEGRAM_DOWNLOAD_BYTES,
  );
});
test("download hides token, URL and cause from metadata, fetch and stream failures", async () => {
  for (const mode of ["api", "fetch", "stream", "status"]) {
    const secret = Error("https://api.telegram.org/file/bot123:fake/private");
    const api = fixture({
      ...(mode === "api"
        ? {
            createApi: () => ({
              getFile: async () => {
                throw secret;
              },
            }),
          }
        : {}),
      downloadFetch: async () => {
        if (mode === "fetch") throw secret;
        if (mode === "status") return new Response("secret", { status: 302 });
        return new Response(
          new ReadableStream({
            start(c) {
              c.error(secret);
            },
          }),
        );
      },
    });
    await assert.rejects(api.download("id"), (error: Error) => {
      assert.equal(error.message, "Telegram file download failed");
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.stack ?? "", /123:fake|private/);
      return true;
    });
  }
});
test("download times out stalled metadata, fetch and stream; honors cancellation", async () => {
  for (const phase of ["api", "fetch", "stream"]) {
    const api = fixture({
      downloadTimeoutMs: 5,
      ...(phase === "api"
        ? { createApi: () => ({ getFile: () => new Promise(() => {}) }) }
        : {}),
      downloadFetch: async () =>
        phase === "fetch"
          ? new Promise(() => {})
          : new Response(new ReadableStream()),
    });
    await assert.rejects(api.download("id"), fail);
  }
  const controller = new AbortController();
  const pending = fixture({
    signal: controller.signal,
    downloadFetch: async () => new Promise(() => {}),
  }).download("id");
  controller.abort(Error("123:fake"));
  await assert.rejects(pending, fail);
  await assert.rejects(
    fixture({ signal: controller.signal }).download("id"),
    fail,
  );
});
