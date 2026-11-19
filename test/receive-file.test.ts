import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveReceivedFile } from "../src/files/receive-file.js";

async function workspace(t: {
  after(fn: () => Promise<void>): void;
}): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "receive-file-test-"));
  t.after(async () => {
    // Only remove this exact directory created by this fixture.
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith("receive-file-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

const generated =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\./;

test("received files use a private generated path and preserve the byte view", async (t) => {
  const cwd = await workspace(t);
  const backing = Uint8Array.from([99, 1, 2, 3, 88]);
  const saved = await saveReceivedFile(
    cwd,
    "original.TXT",
    backing.subarray(1, 4),
  );
  assert.equal(
    path.dirname(saved),
    path.join(await realpath(cwd), ".dsh-telegram-remote"),
  );
  assert.ok(path.isAbsolute(saved));
  assert.match(path.basename(saved), generated);
  assert.equal(path.extname(saved), ".txt");
  assert.ok(!path.basename(saved).includes("original"));
  assert.deepEqual(await readFile(saved), Buffer.from([1, 2, 3]));
  if (process.platform !== "win32") {
    assert.equal((await lstat(saved)).mode & 0o777, 0o600);
    assert.equal((await lstat(path.dirname(saved))).mode & 0o777, 0o700);
  }
  const second = await saveReceivedFile(cwd, "original.TXT", new Uint8Array());
  assert.notEqual(second, saved);
  assert.equal((await lstat(second)).size, 0);
});

test("untrusted traversal names supply only a safe short final extension", async (t) => {
  const cwd = await workspace(t);
  for (const [name, extension] of [
    ["../../escape.js", ".js"],
    ["C:\\outside\\evil.PDF", ".pdf"],
    ["/absolute/archive.tar.gz", ".gz"],
    ["../..", ".bin"],
    ["no-extension", ".bin"],
    ["bad.a-b", ".bin"],
    ["bad.abcdefghijkl", ".bin"],
    ["bad.☃", ".bin"],
    ["bad.txt\0", ".bin"],
    ["bad.txt/", ".bin"],
  ]) {
    const saved = await saveReceivedFile(cwd, name!, new Uint8Array([42]));
    assert.equal(
      path.dirname(saved),
      path.join(await realpath(cwd), ".dsh-telegram-remote"),
    );
    assert.match(path.basename(saved), generated);
    assert.equal(path.extname(saved), extension);
  }
});

test("canonicalizes an aliased cwd", async (t) => {
  const cwd = await workspace(t);
  const actual = path.join(cwd, "actual");
  await mkdir(actual);
  const alias = path.join(cwd, "alias");
  await symlink(actual, alias, "dir");
  const saved = await saveReceivedFile(alias, "a.txt", new Uint8Array());
  assert.equal(
    path.dirname(saved),
    path.join(await realpath(actual), ".dsh-telegram-remote"),
  );
});

test("rejects symlink and non-directory receive targets without writing outside", async (t) => {
  const cwd = await workspace(t);
  const outside = await workspace(t);
  const target = path.join(cwd, ".dsh-telegram-remote");
  await symlink(outside, target, "dir");
  await assert.rejects(
    saveReceivedFile(cwd, "a.txt", new Uint8Array([1])),
    /real directory/,
  );
  assert.deepEqual(await readdir(outside), []);
  await rm(target);
  await writeFile(target, "existing");
  await assert.rejects(
    saveReceivedFile(cwd, "a.txt", new Uint8Array([1])),
    /real directory/,
  );
  assert.equal(await readFile(target, "utf8"), "existing");
});

test("enforces the inclusive 10 MiB content limit before creating files", async (t) => {
  const cwd = await workspace(t);
  await assert.rejects(
    saveReceivedFile(cwd, "a.bin", new Uint8Array(10 * 1024 * 1024 + 1)),
    /10 MiB/,
  );
  assert.deepEqual(await readdir(cwd), []);
  const saved = await saveReceivedFile(
    cwd,
    "a.bin",
    new Uint8Array(10 * 1024 * 1024),
  );
  assert.equal((await lstat(saved)).size, 10 * 1024 * 1024);
});

test("pre-aborted requests create no receive directory", async (t) => {
  const cwd = await workspace(t);
  const controller = new AbortController();
  const reason = new Error("cancelled upload");
  controller.abort(reason);
  await assert.rejects(
    saveReceivedFile(cwd, "a.txt", new Uint8Array([1]), controller.signal),
    reason,
  );
  assert.deepEqual(await readdir(cwd), []);
});

test("cleanup never unlinks a replacement file", async (t) => {
  const cwd = await workspace(t);
  const probe = await open(path.join(cwd, "probe"), "wx");
  const prototype = Object.getPrototypeOf(probe) as typeof probe;
  await probe.close();
  const reason = new Error("replacement during write");
  let target: string | undefined;
  const mocked = t.mock.method(prototype, "writeFile", async () => {
    const directory = path.join(cwd, ".dsh-telegram-remote");
    const names = await readdir(directory);
    assert.equal(names.length, 1);
    target = path.join(directory, names[0]!);
    await rename(target, `${target}.moved`);
    // Use descriptor.write rather than the mocked writeFile method.
    const replacement = await open(target, "wx");
    try {
      await replacement.write(Buffer.from("replacement"));
    } finally {
      await replacement.close();
    }
    throw reason;
  });
  try {
    await assert.rejects(
      saveReceivedFile(cwd, "a.bin", new Uint8Array(100)),
      reason,
    );
  } finally {
    mocked.mock.restore();
  }
  assert.ok(target);
  assert.equal(await readFile(target, "utf8"), "replacement");
});

test("cancellation after a partial write removes the owned file", async (t) => {
  const cwd = await workspace(t);
  const probe = await open(path.join(cwd, "probe"), "wx");
  const prototype = Object.getPrototypeOf(probe) as typeof probe;
  const original = prototype.writeFile;
  await probe.close();
  const controller = new AbortController();
  const reason = new Error("cancelled during write");
  const mocked = t.mock.method(
    prototype,
    "writeFile",
    async function (this: typeof probe) {
      await original.call(this, new Uint8Array([1, 2]));
      controller.abort(reason);
      throw reason;
    },
  );
  try {
    await assert.rejects(
      saveReceivedFile(cwd, "a.bin", new Uint8Array(100), controller.signal),
      reason,
    );
  } finally {
    mocked.mock.restore();
  }
  assert.deepEqual(await readdir(path.join(cwd, ".dsh-telegram-remote")), []);
});
