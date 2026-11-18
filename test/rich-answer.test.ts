import test from "node:test";
import assert from "node:assert/strict";
import { richAnswerParts } from "../src/rendering/rich-answer.js";

const rich = (source: string) =>
  richAnswerParts(source)
    .map((part) => part.markdown)
    .join("");
test("native rich Markdown headings, lists, tasks, tables, quotes and formulas stay native", () => {
  const source =
    "# Heading\n## Section\n### Three\n#### Four\n##### Five\n###### Six\n\n**bold** _italic_ ~~strike~~ ==marked== ||spoiler||\n\n- one\n- [ ] todo\n- [x] done\n1. ordered\n\n> Quote\n> Continued\n\n| A | B |\n|---|---|\n| x | y |\n\n$x^2$\n\n$$E=mc^2$$\n\nref[^note]\n\n[^note]: _footnote_\n";
  assert.equal(rich(source), source);
});
test("raw HTML cannot inject rich authority buttons, media or encoded HTML", () => {
  const value = rich(
    '<buttons><button callback_data="approve">Yes</button></buttons>\n<img src="https://private/image"> &lt;button&gt;',
  );
  assert.ok(!value.includes("<"));
  assert.ok(value.includes("&lt;buttons&gt;"));
  assert.ok(value.includes("&amp;lt;button&amp;gt;"));
});
test("all media syntax becomes a safe external link or local code label", () => {
  const value = rich(
    '![picture](https://example.com/image.png "caption")\n![upload](tg://document?id=secret)\n![local](./image.png)',
  );
  assert.ok(!value.includes("!["));
  assert.ok(value.includes("[picture](https://example.com/image.png)"));
  assert.ok(!value.includes("tg://"));
  assert.ok(!value.includes("./image.png"));
  assert.ok(value.includes("` upload `"));
});
test("local references become labels; balanced external links keep nested label and address", () => {
  const value = rich(
    "[source](<src/file.ts#L2>) [**API [nested]**](https://example.com/path_(x)) [unsafe](javascript:alert(1))",
  );
  assert.ok(value.includes("` source `"));
  assert.ok(
    value.includes("[**API [nested]**](https://example.com/path_\\(x\\))"),
  );
  assert.ok(value.includes("` unsafe `"));
  assert.ok(!value.includes("src/file.ts"));
  assert.ok(!value.includes("javascript:"));
});
test("reference images cannot fetch or enable tg authority links", () => {
  const value = rich(
    "![remote][media]\n[plain][local]\n[go][web]\n\n[media]: https://example.com/media.png\n[local]: tg://user?id=1\n[web]: https://example.com/path",
  );
  assert.ok(!value.includes("![remote]"));
  assert.ok(value.includes("[remote](https://example.com/media.png)"));
  assert.ok(value.includes("` plain `"));
  assert.ok(value.includes("[go](https://example.com/path)"));
  // Definition source remains present but inert inside code, not a link target.
  assert.ok(value.includes("[local]: tg://user?id=1"));
});
test("escaped syntax and code spans are literal and never sanitized as markup", () => {
  const source =
    "\\![not media](https://example.com/image) `<button> ![image](tg://document?id=x)` ``a ` b``";
  const value = rich(source);
  assert.ok(value.startsWith("\\!"));
  assert.ok(value.includes("`<button> ![image](tg://document?id=x)`"));
  assert.ok(value.includes("``a ` b``"));
});
test("huge code fences split safely, reopen their language and preserve astral code points", () => {
  const source = "😀<button>![x](tg://document?id=x)\n".repeat(2000);
  const parts = richAnswerParts("```typescript\n" + source + "```", 1024);
  assert.ok(parts.length > 2);
  assert.ok(
    parts.every((part) => Buffer.byteLength(part.markdown, "utf8") <= 1024),
  );
  const payload = parts
    .map((part) => {
      const match = part.markdown.match(
        /^(`{3,}|~{3,})typescript\n([\s\S]*)\n\1\n$/,
      );
      assert.ok(match);
      assert.ok(!/[\uD800-\uDBFF]$/.test(match[2]!));
      assert.ok(!/^[\uDC00-\uDFFF]/.test(match[2]!));
      return match[2];
    })
    .join("");
  assert.equal(payload, source.replace(/\n$/, ""));
});
test("many short blocks and excessive nesting split or become literal without dropping text", () => {
  const parts = richAnswerParts("- item\n".repeat(500));
  assert.ok(parts.length > 1);
  assert.equal(
    parts.map((part) => part.markdown).join(""),
    "- item\n".repeat(500),
  );
  const deep = "> ".repeat(20) + "deep";
  assert.ok(rich(deep).includes(deep));
  assert.ok(/^```|^~~~/.test(rich(deep)));
});
test("oversized paragraph is retained within conservative source budget", () => {
  const source = "😀".repeat(10000);
  const parts = richAnswerParts(source, 1024);
  assert.ok(
    parts.every((part) => Buffer.byteLength(part.markdown, "utf8") <= 1024),
  );
  assert.equal(
    parts
      .map((part) =>
        part.markdown
          .replace(/^(`{3,}|~{3,})\n/, "")
          .replace(/\n(`{3,}|~{3,})\n$/, ""),
      )
      .join(""),
    source,
  );
  assert.throws(() => richAnswerParts("text", 10), RangeError);
});
