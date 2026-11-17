import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apply,
  semanticRunView,
  resolvePackageDirectory,
} from "../../src/index.js";
import type {
  ActivationContext,
  Registration,
} from "../../src/host/activation-contracts.js";
import type { SettingsHandler } from "../../src/host/dsh-contracts.js";
import { initialRun } from "../../src/projection/run-projection.js";
import type { JsonValue } from "../../src/protocol/json.js";

function fixture() {
  const disposers: (() => void | Promise<void>)[] = [];
  const registrations = new Set<string>();
  const rows = new Map<string, JsonValue>();
  let route: SettingsHandler | undefined;
  let projections = 0,
    domains = 0;
  const register = (key: string): (() => void) => {
    assert.equal(registrations.has(key), false);
    registrations.add(key);
    return () => {
      registrations.delete(key);
    };
  };
  const ctx: ActivationContext<string> = {
    effect: (callback) => {
      const dispose = callback();
      if (dispose) disposers.push(dispose);
    },
    get: () => undefined,
    fs: {
      resolve: async (value) => value,
      contains: () => true,
      stat: async () => ({ type: "file", size: 0 }),
      readBytes: async () => new Uint8Array(),
      processPath: (value) => value,
    },
    attachments: { readFileStream: async function* () {} },
    workingDirectory: { defaultDirectory: ".", get: () => "." },
    credentials: {
      describeRecord: async () => ({ configured: false }),
      readRecord: async () => null,
      modifyRecord: async () => {},
    },
    storageDomain: {
      open: async () => {
        domains++;
        return {
          table: () => ({
            get: async (key) => rows.get(key),
            put: async (key, value) => {
              rows.set(key, value);
            },
            entries: () => rows.entries(),
          }),
          close: () => {
            domains--;
          },
        };
      },
    },
    sessionProjections: {
      register: async () => {
        projections++;
        return {
          stateOf: () => initialRun(),
          dispose: () => {
            projections--;
          },
        };
      },
    },
    sessionController: {
      list: async () => ({ items: [] }),
      state: async () => ({ running: false }),
      modelCatalog: async () => ({ groups: [] }),
      selectModel: async (value) => ({ selected: value }),
      create: async () => ({ sessionId: "created" }),
      prompt: async () => ({ accepted: true }),
      updateQueue: async () => ({ accepted: true }),
      cancel: async () => {},
      events: async () => ({ records: [], hasMore: false }),
    },
    sessionQuery: {
      observeSession: async () => ({
        header: { createdAt: 0 },
        events: [],
        [Symbol.dispose]: () => {},
      }),
    },
    connection: {
      requestRejection: () => null,
      admit: () => ({ peer: { principal: { kind: "owner" } } }),
    },
    webServer: {
      getOrigin: () => "http://localhost",
      register: (value) => {
        route = value.handler;
        return register("route");
      },
    },
    tools: { register: () => register("send_file") },
    systemPrompt: { section: (value) => register(value.name) },
    on: (name: string): Registration => register(name),
  };
  return {
    ctx,
    rows,
    registrations,
    get route() {
      return route;
    },
    get projections() {
      return projections;
    },
    get domains() {
      return domains;
    },
    async unload() {
      const callbacks = disposers.splice(0).reverse();
      for (const dispose of callbacks) await dispose();
    },
  };
}

test("locked activation owns all registrations and supports unload/reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-activation-"));
  try {
    const mock = fixture();
    for (let iteration = 0; iteration < 2; iteration++) {
      await apply(mock.ctx, {
        ownerId: 0,
        credentialKey: "telegram-console/bot",
        statusPath: join(directory, "status.json"),
      });
      const debug = JSON.parse(
        await readFile(join(directory, "status.json"), "utf8"),
      );
      assert.equal(debug.state, "unconfigured");
      assert.ok(debug.updatedAt);
      assert.ok(
        debug.startupLog.some(
          (event: { stage: string; outcome: string }) =>
            event.stage === "credential-check" && event.outcome === "skipped",
        ),
      );
      assert.ok(
        debug.startupLog.some(
          (event: { stage: string; outcome: string }) =>
            event.stage === "activation" && event.outcome === "ok",
        ),
      );
      assert.equal(mock.projections, 1);
      assert.equal(mock.domains, 1);
      assert.ok(mock.route);
      assert.equal(mock.registrations.size, 8);
      await mock.unload();
      assert.equal(mock.registrations.size, 0);
      assert.equal(mock.domains, 0);
      assert.equal(mock.projections, 0);
    }
    assert.equal(
      mock.rows.get("settings:ownerEpoch"),
      1,
      "reload retains durable inbox ownership epoch",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("semantic view excludes arbitrary projection internals", () => {
  const view = semanticRunView({
    ...initialRun(),
    cwd: ".",
    elapsed: 1,
    toolLog: [
      {
        callId: "call",
        name: "read",
        status: "completed",
        summary: "file",
        result: "secret file bytes",
        startedAt: 1,
        resultHtml: "<b>Completed</b>",
      },
    ],
  });
  assert.equal("workspaceSeqs" in view, false);
  assert.equal("started" in view, false);
  assert.equal("result" in (view.toolLog?.[0] ?? {}), false);
  assert.equal(view.toolLog?.[0]?.resultHtml, "<b>Completed</b>");
});

test("package root resolves from compiled module location", async () => {
  const directory = await resolvePackageDirectory(import.meta.url);
  assert.ok(directory.length > 0);
});
