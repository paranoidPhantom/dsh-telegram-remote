import { test } from "node:test";
import assert from "node:assert/strict";
import {
  consoleBridge,
  semanticRunView,
} from "../../src/bridge/console-adapter.js";
import {
  consoleBridge as publicConsoleBridge,
  semanticRunView as publicSemanticRunView,
} from "../../src/index.js";
import type { Bridge, SessionMetadata } from "../../src/bridge/bridge.js";
import { initialRun } from "../../src/projection/run-projection.js";

function fixture() {
  const metadata: SessionMetadata = {
    id: "session",
    title: "Title",
    model: "model",
    activeModel: "active",
    cwd: ".",
    running: false,
    lastActivity: 1,
    selection: null,
    turns: null,
    context: { private: "not a scalar" },
    queue: [],
    pendingInput: null,
  };
  const selections: string[] = [];
  const bridge: Bridge = {
    list: async () => [],
    metadata: async () => metadata,
    models: async () => [],
    selectModel: async (id, selection) => {
      selections.push(id);
      return { ...selection, appliesAtNextStep: true };
    },
    newSessionSelection: async () => ({ provider: "provider", model: "model" }),
    create: async () => "created",
    prompt: async () => ({ accepted: true }),
    steerQueued: async () => ({ accepted: true }),
    stop: async () => {},
    details: async () => "details",
    files: async () => [],
    fileForTurn: async () => {
      throw new Error("unused fixture file lookup");
    },
    touchedFiles: () => [],
    runView: () => ({ ...initialRun(), cwd: ".", elapsed: 0 }),
    dispose: async () => {},
  };
  return { metadata, selections, bridge };
}

test("index retains the exact mapper exports", () => {
  assert.equal(publicConsoleBridge, consoleBridge);
  assert.equal(publicSemanticRunView, semanticRunView);
});

test("console adapter filters metadata and preserves selection acknowledgement", async () => {
  const { bridge, metadata, selections } = fixture();
  const adapter = consoleBridge(bridge);
  assert.deepEqual(await adapter.metadata("session"), {
    id: "session",
    title: "Title",
    model: "model",
    activeModel: "active",
    cwd: ".",
    running: false,
    lastActivity: 1,
    context: null,
  });
  metadata.context = 42;
  metadata.turns = 3;
  metadata.selection = { provider: "provider", model: "model" };
  const mapped = await adapter.metadata("session");
  assert.ok(mapped);
  assert.equal(mapped.context, 42);
  assert.equal(mapped.turns, 3);
  assert.deepEqual(mapped.selection, metadata.selection);
  assert.deepEqual(await adapter.selectModel("session", metadata.selection), {
    accepted: true,
    deferred: true,
    running: true,
  });
  assert.deepEqual(selections, ["session"]);
});

test("semantic adapter copies only presentation fields without mutating source", () => {
  const source = {
    ...initialRun(),
    turn: 2,
    cwd: ".",
    elapsed: 4,
    outputs: [{ id: "output", text: "answer", toolCount: 1 }],
    toolLog: [
      {
        callId: "call",
        name: "read",
        status: "completed" as const,
        summary: "file",
        result: "private file bytes",
        startedAt: 1,
        resultHtml: "<b>Completed</b>",
      },
    ],
  };
  const mapped = semanticRunView(source);
  assert.equal(mapped.turn, 2);
  assert.deepEqual(mapped.outputs, source.outputs);
  assert.notEqual(mapped.outputs, source.outputs);
  assert.notEqual(mapped.outputs?.[0], source.outputs[0]);
  assert.deepEqual(mapped.toolLog, [
    {
      callId: "call",
      name: "read",
      status: "completed",
      summary: "file",
      resultHtml: "<b>Completed</b>",
    },
  ]);
  assert.equal("workspaceSeqs" in mapped, false);
  assert.equal("started" in mapped, false);
  assert.equal(source.toolLog[0]?.result, "private file bytes");
});
