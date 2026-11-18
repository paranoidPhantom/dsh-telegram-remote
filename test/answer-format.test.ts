import test from "node:test";
import assert from "node:assert/strict";
import { formatAnswer, answerParts } from "../src/rendering/answer-format.js";
test("bold and backticks become entities not raw markers", () => {
  const v = formatAnswer("**Bold** and `code`");
  assert.equal(v.text, "Bold and code");
  assert.deepEqual(
    v.entities.map((x) => x.type),
    ["bold", "code"],
  );
});
test("Markdown ATX headings render bold without literal hash markers", () => {
  const value = formatAnswer(
    "# Title\n\n### Section ###\n###### Small\nC# and #tag\n####### Not a heading",
  );
  assert.equal(
    value.text,
    "Title\n\nSection\nSmall\nC# and #tag\n####### Not a heading",
  );
  assert.deepEqual(
    value.entities.map((entity) =>
      value.text.slice(entity.offset, entity.offset + entity.length),
    ),
    ["Title", "Section", "Small"],
  );
  assert.ok(value.entities.every((entity) => entity.type === "bold"));
  assert.equal(formatAnswer("### C#").text, "C#");
});
test("headings preserve inline code and links with valid UTF16 entity spans", () => {
  const value = formatAnswer(
    "### 😀 **Title** `file.ts` [Docs](https://example.com)",
  );
  assert.equal(value.text, "😀 Title file.ts Docs");
  const code = value.entities.find((entity) => entity.type === "code")!;
  assert.equal(
    value.text.slice(code.offset, code.offset + code.length),
    "file.ts",
  );
  assert.ok(
    !value.entities
      .filter((entity) => entity.type === "bold")
      .some(
        (entity) =>
          entity.offset < code.offset + code.length &&
          entity.offset + entity.length > code.offset,
      ),
  );
  assert.ok(value.entities.some((entity) => entity.type === "text_link"));
});
test("hashes inside fenced and inline code remain literal", () => {
  assert.equal(
    formatAnswer("```md\n### literal\n```\n`### inline`\n### Heading").text,
    "### literal\n### inline\nHeading",
  );
});
test("local file references are code labels not links", () => {
  const v = formatAnswer(
    "The [runtime diagnostics](<dsh-telegram-console/.runtime-status.json#L2-L8>) show:",
  );
  assert.equal(v.text, "The runtime diagnostics show:");
  assert.ok(v.entities[0]);
  assert.equal(v.entities[0].type, "code");
  assert.ok(!v.text.includes("status.json"));
});
test("external URLs remain links while HTML remains literal", () => {
  const v = formatAnswer("[Docs](https://example.com) <b>literal</b>");
  assert.ok(v.entities[0]);
  assert.equal(v.entities[0].type, "text_link");
  assert.ok(v.text.includes("<b>literal</b>"));
});
test("fenced code preserves literal markdown and language", () => {
  const v = formatAnswer('```js\nconst x = "**";\n```');
  assert.equal(v.text, 'const x = "**";');
  assert.ok(v.entities[0]);
  assert.equal(v.entities[0].language, "js");
});
test("UTF16 entities split correctly across long messages", () => {
  const source = "**" + "😀".repeat(3000) + "**";
  const parts = answerParts(source);
  assert.equal(parts.map((x) => x.text).join(""), "😀".repeat(3000));
  assert.ok(
    parts.every(
      (x) => x.text.length <= 4096 && x.entities[0]?.length === x.text.length,
    ),
  );
});
