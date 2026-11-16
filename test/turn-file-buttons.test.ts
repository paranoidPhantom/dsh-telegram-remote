import { inlineMarkup, requiredField } from "./console-param-checks.js";
import test from "node:test";
import assert from "node:assert/strict";
import { FixtureConsole as TelegramConsole } from "./console-constructor.js";
import type {
  TelegramMethod,
  TelegramParams,
  ConsoleDocument,
} from "../src/bot/contracts.js";
import { toolLogPages } from "../src/rendering/console-render.js";
import { required, type ApiParams } from "./console-fixture-types.js";
test("tool paths are relative monospace without changing canonical data", () => {
  const tool = {
    name: "read",
    summary: "/work/src/main.js",
    status: "completed",
  };
  const text = toolLogPages([tool], true, "/work").join("");
  assert.ok(text.includes("<code>src/main.js</code>"));
  assert.ok(!text.includes("/work/"));
  assert.equal(tool.summary, "/work/src/main.js");
});
test("write/edit drafts show relative code paths", async () => {
  for (const name of ["write", "edit"]) {
    let draft: ApiParams | undefined;
    const c = new TelegramConsole({
      signal: undefined,
      api: {
        call: async (method: TelegramMethod, params: TelegramParams = {}) => {
          if (method === "sendMessageDraft") draft = params;
        },
      },
      bridge: {},
      store: {},
    });
    await c.preview(
      { chatId: 1, threadId: 2 },
      { id: "s", draftId: 1, chatId: 1, threadId: 2 },
      {
        turn: 1,
        cwd: "/work",
        partialAnswer: "",
        toolLog: [{ name, summary: "/work/src/a.js", status: "running" }],
      },
    );
    assert.ok(draft);
    assert.equal(requiredField(draft.text), `✏️ ${name} — src/a.js`);
    const entity = requiredField(draft.entities).find((x) => x.type === "code");
    assert.ok(entity);
    assert.ok(draft);
    assert.equal(
      requiredField(draft.text).slice(
        entity.offset,
        entity.offset + entity.length,
      ),
      "src/a.js",
    );
    c.close();
  }
});
test("final filenames have distinct requested icons and opaque exact-turn actions", () => {
  const c = new TelegramConsole({
    signal: undefined,
    api: {},
    bridge: {},
    store: {},
  });
  const rows = c
    .finalControls(
      "s",
      { chatId: 1, threadId: 2 },
      {
        turn: 3,
        touchedFiles: [
          { path: "/work/a.js", kind: "added" },
          { path: "/work/b.js", kind: "removed" },
          { path: "/work/c.js", kind: "edited" },
        ],
      },
    )
    .inline_keyboard.slice(1);
  assert.deepEqual(
    rows.map((row) => row[0]!.text),
    ["a.js", "b.js", "c.js"],
  );
  assert.deepEqual(
    rows.map((row) => row[0]!.icon_custom_emoji_id),
    ["5371101764676241385", "5370673711055653338", "5375052056551770853"],
  );
  assert.deepEqual(
    rows.map((row) => {
      const action = required(c.actions.get(required(row[0]!.callback_data)));
      assert.equal(action.type, "turn-file");
      assert.ok("turn" in action);
      return action.turn;
    }),
    [3, 3, 3],
  );
  c.close();
});
