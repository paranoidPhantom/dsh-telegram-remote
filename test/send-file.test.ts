import test from "node:test";
import assert from "node:assert/strict";
import {
  registerSendFile,
  type ArtifactFileSystem,
  type ArtifactAgent,
  type ArtifactDispatch,
  type SendFileTool,
} from "../src/files/send-file.js";
import { ResourceRegistry } from "../src/host/resources.js";
import { required } from "./fixture-assertions.js";

interface DocumentUpload {
  chatId: number;
  threadId: number;
  name: string;
  content: Buffer;
  caption: string;
}
function fixture(outside = false) {
  let tool: SendFileTool<string> | undefined,
    document: DocumentUpload | undefined;
  const resources = new ResourceRegistry();
  const scope = { generation: "test-generation", ownerEpoch: 1 };
  let resourceId: string | undefined;
  const fs: ArtifactFileSystem<string> = {
    resolve: async (p) => (p.startsWith("/") ? p : "/work/" + p),
    contains: (_r, p) => !outside && p.startsWith("/work/"),
    stat: async () => ({ type: "file", size: 6 }),
    readBytes: async () => Buffer.from("result"),
    processPath: (x) => x,
  };
  const ctx = {
    tools: { register: (t: SendFileTool<string>) => (tool = t) },
    fs,
    workingDirectory: { get: () => "/work" },
  };
  const dispatch: ArtifactDispatch = {
    request: async (method, payload, options) => {
      assert.equal(method, "files.send");
      assert.equal(options?.signal, signal);
      const descriptor = payload.descriptor;
      assert.ok(
        descriptor &&
          typeof descriptor === "object" &&
          !Array.isArray(descriptor),
      );
      assert.ok(typeof descriptor.id === "string");
      assert.ok(typeof descriptor.name === "string");
      assert.ok(typeof payload.chatId === "number");
      assert.ok(typeof payload.threadId === "number");
      assert.ok(typeof payload.caption === "string");
      resourceId = descriptor.id;
      const resource = resources.read({
        ...scope,
        id: descriptor.id,
        offset: 0,
        length: 65536,
      });
      document = {
        chatId: payload.chatId,
        threadId: payload.threadId,
        name: descriptor.name,
        content: Buffer.from(resource.data, "base64"),
        caption: payload.caption,
      };
      return { message_id: 3 };
    },
  };
  const signal = new AbortController().signal;
  registerSendFile(ctx, {
    resources,
    ...scope,
    dispatch,
    surface: { getTopic: async () => ({ chatId: 1, threadId: 2 }) },
  });
  const agent: ArtifactAgent<string> = {
    id: "s",
    ctx: { get: () => fs },
    session: { id: "s" },
  };
  return {
    get tool() {
      return required(tool);
    },
    get document() {
      return document;
    },
    assertReleased() {
      assert.throws(
        () =>
          resources.read({
            ...scope,
            id: required(resourceId),
            offset: 0,
            length: 1,
          }),
        /unavailable/,
      );
    },
    exec: { agent, signal },
  };
}
test("send_file uploads result with relative path caption", async () => {
  const f = fixture();
  assert.deepEqual(await f.tool.execute({ path: "out/report.pdf" }, f.exec), {
    path: "out/report.pdf",
    messageId: 3,
  });
  assert.equal(required(f.document).name, "report.pdf");
  assert.equal(required(f.document).caption, "out/report.pdf");
  assert.equal(required(f.document).content.toString(), "result");
  f.assertReleased();
});
test("send_file rejects canonical paths outside workspace", async () => {
  const f = fixture(true);
  await assert.rejects(f.tool.execute({ path: "/secret" }, f.exec), /inside/);
  assert.equal(f.document, undefined);
});
