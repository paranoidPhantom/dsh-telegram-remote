import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RuntimeStatusWriter,
  RUNTIME_STATUS_MAX_BYTES,
} from "../../src/host/runtime-status.js";
import {
  startupFailure,
  startupEventSchema,
} from "../../src/protocol/startup.js";

test("startup errors allowlist codes, never arbitrary backend strings or secrets", () => {
  const secret = "123456:secret-token https://api.telegram.org/botSECRET/getMe";
  for (const error of [
    new Error(secret),
    { code: secret, message: secret },
    { name: secret, cause: { code: secret } },
    new Proxy(
      {},
      {
        get() {
          throw new Error(secret);
        },
      },
    ),
  ]) {
    assert.deepEqual(startupFailure(error), { code: "UNKNOWN" });
  }
  assert.deepEqual(startupFailure({ code: 401, message: secret }), {
    code: "TELEGRAM_REJECTED",
    statusCode: 401,
  });
  assert.deepEqual(
    startupFailure({ cause: { code: "ECONNRESET" }, message: secret }),
    { code: "ECONNRESET" },
  );
  assert.equal(
    startupEventSchema.safeParse({
      stage: "getMe",
      outcome: "failed",
      message: secret,
    }).success,
    false,
  );
});

test("runtime status bounds history, serializes concurrent writes and preserves latest snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-status-"));
  const path = join(directory, ".runtime-status.json");
  let state = "connecting";
  const writer = new RuntimeStatusWriter(path, () => ({
    state,
    diagnostics: { value: "界".repeat(25000) },
  }));
  try {
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 1000; i++)
      writes.push(writer.record("host", { stage: "launch", outcome: "begin" }));
    state = "running";
    writes.push(writer.flush());
    await Promise.all(writes);
    const text = await readFile(path, "utf8");
    assert.ok(Buffer.byteLength(text) <= RUNTIME_STATUS_MAX_BYTES);
    const data = JSON.parse(text);
    assert.equal(data.state, "running");
    assert.ok(data.startupLog.length < 256);
    assert.ok(data.startupLogDropped > 0);
    assert.equal(data.startupLog.at(-1).sequence, 1000);
    if (process.platform !== "win32")
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    await writer.record("child", { stage: "ready", outcome: "ok" });
    const latest = JSON.parse(await readFile(path, "utf8"));
    assert.equal(latest.startupLog.at(-1).stage, "ready");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("oversized snapshot cannot exceed the hard byte cap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-status-"));
  try {
    const path = join(directory, "status.json");
    const writer = new RuntimeStatusWriter(path, () => ({
      diagnostics: "x".repeat(200000),
    }));
    await writer.record("host", { stage: "activation", outcome: "begin" });
    assert.ok((await stat(path)).size <= RUNTIME_STATUS_MAX_BYTES);
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).state,
      "diagnostics-too-large",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
