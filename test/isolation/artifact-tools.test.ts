import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registerSendFile,
  type SendFileTool,
} from "../../src/files/send-file.js";
import { WidgetResourceAccess } from "../../src/host/widget-pipeline.js";
import { ResourceRegistry } from "../../src/host/resources.js";

function fixture() {
  const reads: { signal?: AbortSignal; max?: number }[] = [];
  const fs = {
    async resolve(p: string, o?: { cwd?: string }) {
      return new URL(p, "file://" + (o?.cwd ?? "/work") + "/").pathname;
    },
    contains(r: string, t: string) {
      return t === r || t.startsWith(r + "/");
    },
    processPath(p: string) {
      return p;
    },
    async stat() {
      return { type: "file", size: 3 };
    },
    async readBytes(_p: string, signal?: AbortSignal, max?: number) {
      reads.push({ signal, max });
      return Buffer.from("abc");
    },
  };
  const agent = { id: "s", session: { id: "s" }, ctx: { get: () => fs } };
  return { fs, agent, reads };
}
test("send_file authorizes provider bytes and dispatches descriptor, preserving result and registration", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  let tool: SendFileTool | undefined;
  const resources = new ResourceRegistry();
  const registration = registerSendFile(
    {
      fs: f.fs,
      workingDirectory: { get: () => "/work" },
      tools: {
        register(t) {
          tool = t;
          return "owned";
        },
      },
    },
    {
      resources,
      generation: "g",
      ownerEpoch: 1,
      surface: {
        async getTopic() {
          return { chatId: 1, threadId: 2 };
        },
      },
      dispatch: {
        async request(method, payload) {
          assert.equal(method, "files.send");
          assert.equal(payload.caption, "result\na.txt");
          assert.equal(JSON.stringify(payload).includes("abc"), false);
          return { message_id: 9 };
        },
      },
    },
  );
  assert.equal(registration, "owned");
  assert.ok(tool);
  assert.deepEqual(
    await tool.execute(
      { path: "a.txt", caption: "result" },
      { agent: f.agent, signal },
    ),
    { path: "a.txt", messageId: 9 },
  );
  assert.equal(f.reads[0]?.signal, signal);
  assert.equal(f.reads[0]?.max, 10 * 1024 * 1024);
  await assert.rejects(
    tool.execute({ path: "../outside" }, { agent: f.agent, signal }),
    /inside/,
  );
});
test("widget capability resolves from source and refuses traversal or revoked reads", async () => {
  const f = fixture();
  const access = new WidgetResourceAccess<string>();
  const cap = await access.add({
    fs: f.fs,
    cwd: "/work",
    source: "sub/widget.html",
  });
  const p = await access.canonicalize(
    cap.id,
    cap.filePath.replace("widget.html", "asset.css"),
  );
  assert.ok(p.endsWith("/sub/asset.css"));
  assert.equal((await access.read(cap.id, p, 20)).toString(), "abc");
  await assert.rejects(
    access.canonicalize(cap.id, "/etc/passwd"),
    /workspace|capability/,
  );
  access.release(cap.id);
  await assert.rejects(access.read(cap.id, p, 20), /unavailable/);
});
