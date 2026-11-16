import test from "node:test";
import assert from "node:assert/strict";
import {
  matchToolName,
  toolNameRulesSchema,
  toolEmojiHtml,
} from "../src/rendering/tool-name.js";
import { formatToolCall } from "../src/rendering/tool-format.js";
import { toolLogPages } from "../src/rendering/console-render.js";

test("tool rules match normalized MCP and namespace names with ordered literal globs", () => {
  const rules = [
    { pattern: "READ*", emoji: "📖", customEmojiId: "123" },
    { pattern: "*", emoji: "⚙" },
  ];
  for (const name of [
    "functions.read",
    "mcp__fs__read_file",
    "fs/read",
    "fs:read",
  ]) {
    assert.equal(matchToolName(name, rules).customEmojiId, "123");
  }
  assert.equal(matchToolName("functions.bash", rules).emoji, "⚙");
  assert.equal(
    matchToolName("xread", [{ pattern: "[x]read", emoji: "X" }]).emoji,
    "🔧",
  );
  assert.equal(matchToolName("mcp__fs__EDIT").isChange, true);
  assert.equal(matchToolName("unknown").customEmojiId, "5220046725493828505");
  assert.throws(() =>
    toolNameRulesSchema.parse([
      { pattern: "read", customEmojiId: '123" onclick="x' },
    ]),
  );
});

test("shared log/call emoji formatter escapes rules and removes log title and ordered numbering", () => {
  const rules = [{ pattern: "read", emoji: "<script>&" }];
  assert.equal(toolEmojiHtml("read", rules), "&lt;script&gt;&amp;");
  const call = formatToolCall(
    "functions.read",
    { file_path: "<private>.md" },
    rules,
  );
  const log = toolLogPages(
    [
      {
        name: "functions.read",
        summary: "<private>.md",
        status: "completed",
        resultHtml: "FILE CONTENT",
      },
    ],
    true,
    undefined,
    undefined,
    rules,
  ).join("");
  for (const out of [call, log]) assert.match(out, /&lt;script&gt;&amp;/);
  assert.match(log, /<code>&lt;private&gt;.md<\/code>/);
  assert.doesNotMatch(log, /Tools|finished|1\.|FILE CONTENT|<script>/);
  assert.equal(log.startsWith("<blockquote expandable>"), true);
});
