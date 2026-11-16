import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { FixtureConsole as TelegramConsole } from "./console-constructor.js";
import type {
  TelegramMethod,
  TelegramParams,
  ConsoleDocument,
} from "../src/bot/contracts.js";
import { projectRoot } from "./project-root.js";
test("release package, loader patch and Client module identity agree", async () => {
  const p = JSON.parse(
    await readFile(new URL("package.json", projectRoot), "utf8"),
  ) as { name: string; version: string; private?: boolean };
  assert.equal(p.name, "dsh-telegram-remote");
  assert.match(
    p.version,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
  assert.notEqual(p.private, true);
  const patch = await readFile(
    new URL("cordis.patch.yml", projectRoot),
    "utf8",
  );
  assert.ok(patch.includes("name: 'dsh-telegram-remote'"));
  assert.ok(patch.includes("ownerId: 0"));
  assert.ok(!patch.includes("/Users/"));
  const client = await readFile(new URL("client.js", projectRoot), "utf8");
  assert.match(client, /id\s*:\s*["']dsh-telegram-remote["']/);
});
test("fresh console defaults locked, never implicitly authorizes a personal ID", () => {
  const c = new TelegramConsole({
    api: {},
    bridge: {},
    store: {},
    signal: undefined,
  });
  assert.equal(c.ownerId, 0);
  c.close();
});
