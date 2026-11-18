import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotLease, leasePermissionsValid } from "../../src/host/lease.js";

test("Windows synthetic directory and file modes are not interpreted as POSIX ACLs", () => {
  for (const mode of [0o40777, 0o40666, 0o100666])
    assert.equal(leasePermissionsValid({ mode, uid: 0 }, "win32", 1000), true);
  assert.equal(
    leasePermissionsValid({ mode: 0o40700, uid: 1000 }, "linux", 1000),
    true,
  );
  assert.equal(
    leasePermissionsValid({ mode: 0o100600, uid: 1000 }, "darwin", 1000),
    true,
  );
  assert.equal(
    leasePermissionsValid({ mode: 0o40755, uid: 1000 }, "linux", 1000),
    false,
  );
  assert.equal(
    leasePermissionsValid({ mode: 0o100644, uid: 1000 }, "darwin", 1000),
    false,
  );
  assert.equal(
    leasePermissionsValid({ mode: 0o40700, uid: 0 }, "linux", 1000),
    false,
  );
});

test("bot lease excludes competing local activations and releases only its own generation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-lease-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await BotLease.acquire({
    directory,
    botId: 123,
    generation: "first",
  });
  t.after(() => first.close());
  await assert.rejects(
    BotLease.acquire({ directory, botId: 123, generation: "second" }),
    /owned|lease|active/i,
  );
  const otherBot = await BotLease.acquire({
    directory,
    botId: 456,
    generation: "other",
  });
  await otherBot.close();
  await first.close();
  await first.close();
  const second = await BotLease.acquire({
    directory,
    botId: 123,
    generation: "second",
  });
  await second.close();
});

function exitedPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(child.status, 0);
  assert.ok(child.pid > 0);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  return child.pid;
}

async function ownerFile(
  path: string,
  pid: number,
  generation: string,
): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({ pid, generation, nonce: `${generation}-nonce` }),
    { mode: 0o600 },
  );
}

test("a live recovery owner blocks acquisition without changing either lock", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-lease-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "123.lock");
  const recoveryPath = `${path}.recover`;
  await ownerFile(path, exitedPid(), "stale");
  await ownerFile(recoveryPath, process.pid, "live-recovery");
  const before = await readFile(path, "utf8");
  const recoveryBefore = await readFile(recoveryPath, "utf8");
  await assert.rejects(
    BotLease.acquire({ directory, botId: 123, generation: "next" }),
    /recovery.*active/i,
  );
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(await readFile(recoveryPath, "utf8"), recoveryBefore);
});

test("abandoned recovery and main locks are reclaimed only after their process exits", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-lease-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "123.lock");
  const pid = exitedPid();
  await ownerFile(path, pid, "stale");
  await ownerFile(`${path}.recover`, pid, "abandoned-recovery");
  const lease = await BotLease.acquire({
    directory,
    botId: 123,
    generation: "next",
  });
  t.after(() => lease.close());
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(
    value &&
      typeof value === "object" &&
      "generation" in value &&
      value.generation === "next",
  );
  await assert.rejects(lstat(`${path}.recover`), { code: "ENOENT" });
  await lease.close();
  await assert.rejects(lstat(path), { code: "ENOENT" });
});

test("abandoned recovery does not delete a newer live main lease", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-lease-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "123.lock");
  await ownerFile(path, process.pid, "newer-live");
  await ownerFile(`${path}.recover`, exitedPid(), "abandoned-recovery");
  const before = await readFile(path, "utf8");
  const inode = (await lstat(path)).ino;
  await assert.rejects(
    BotLease.acquire({ directory, botId: 123, generation: "next" }),
    /active/i,
  );
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal((await lstat(path)).ino, inode);
});

test("delayed close preserves replacement main lease inode and nonce", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-lease-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "123.lock");
  const old = await BotLease.acquire({
    directory,
    botId: 123,
    generation: "old",
  });
  await unlink(path);
  await ownerFile(path, process.pid, "replacement");
  const before = await readFile(path, "utf8");
  await old.close();
  assert.equal(await readFile(path, "utf8"), before);
  // Even an in-place rewrite (same inode) must not be removed by close.
  await unlink(path);
  const second = await BotLease.acquire({
    directory,
    botId: 123,
    generation: "second",
  });
  await ownerFile(path, process.pid, "new-nonce");
  await second.close();
  assert.match(await readFile(path, "utf8"), /new-nonce/);
});

test("malformed recovery files fail closed with explicit manual recovery guidance", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-lease-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "123.lock.recover");
  for (const contents of [
    "",
    "{}",
    '{"pid":1,"nonce":"","generation":"old"}',
    "not-json",
  ]) {
    await writeFile(path, contents, { mode: 0o600 });
    await assert.rejects(
      BotLease.acquire({ directory, botId: 123, generation: "next" }),
      /ambiguous.*manually remove/i,
    );
    assert.equal(await readFile(path, "utf8"), contents);
  }
});

test("lease directory must be private and cannot itself be a symlink", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "telegram-lease-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const alias = join(root, "alias");
  await symlink(root, alias);
  await assert.rejects(
    BotLease.acquire({ directory: alias, botId: 123, generation: "next" }),
    /directory/i,
  );
  if (process.platform === "win32") return; // chmod does not set POSIX mode bits on Windows.
  await chmod(root, 0o755);
  await assert.rejects(
    BotLease.acquire({ directory: root, botId: 123, generation: "next" }),
    /platform permissions/i,
  );
  await chmod(root, 0o700);
});

test("symlink lock files never redirect writes or reclamation outside the directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-lease-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "untouched");
  await ownerFile(target, exitedPid(), "target");
  const before = await readFile(target, "utf8");
  for (const name of ["123.lock", "123.lock.recover"]) {
    const path = join(directory, name);
    await symlink(target, path);
    await assert.rejects(
      BotLease.acquire({ directory, botId: 123, generation: "next" }),
      /ambiguous/i,
    );
    assert.ok((await lstat(path)).isSymbolicLink());
    assert.equal(await readFile(target, "utf8"), before);
    await unlink(path);
  }
});

test("competing stale recovery attempts install only one main lease", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-lease-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "123.lock");
  const pid = exitedPid();
  await ownerFile(path, pid, "stale");
  await ownerFile(`${path}.recover`, pid, "abandoned");
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, index) =>
      BotLease.acquire({
        directory,
        botId: 123,
        generation: `contender-${index}`,
      }),
    ),
  );
  const acquired = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  t.after(async () => {
    await Promise.all(acquired.map((lease) => lease.close()));
  });
  assert.equal(acquired.length, 1);
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    7,
  );
  const owner: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(
    owner &&
      typeof owner === "object" &&
      "pid" in owner &&
      owner.pid === process.pid,
  );
});

test("invalid bot identities cannot determine lock paths", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-lease-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    BotLease.acquire({ directory, botId: -1, generation: "a" }),
    /identity/i,
  );
  await assert.rejects(
    BotLease.acquire({ directory, botId: Number.NaN, generation: "a" }),
    /identity/i,
  );
});
