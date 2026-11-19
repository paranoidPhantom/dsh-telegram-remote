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
test("LaTeX delimiters normalize to Telegram inline and display math", () => {
  assert.equal(
    rich(String.raw`Inline LaTeX: \(E(\xi)=3.3\)`),
    String.raw`Inline LaTeX: $E(\xi)=3.3$`,
  );
  assert.equal(
    rich(
      String.raw`Display LaTeX: \[ \rho=\frac{0.24}{\sqrt{6.21}\cdot1.1}\approx0.0876 \]`,
    ),
    "Display LaTeX: \n\n" +
      String.raw`$$ \rho=\frac{0.24}{\sqrt{6.21}\cdot1.1}\approx0.0876 $$`,
  );
});
test("boxed presentation falls back to grouped contents in exact reported formula", () => {
  const source = String.raw`Условное математическое ожидание:
\[
E(\eta\mid\xi=0)
=(-1)\cdot\frac16+0\cdot\frac13
+1\cdot\frac13+2\cdot\frac16
=\boxed{\frac12}.
\]`;
  assert.equal(
    rich(source),
    source
      .replace("\\[", () => "$$")
      .replace("\\]", () => "$$")
      .replace("\\boxed", ""),
  );
  assert.equal(
    rich(String.raw`\(x^{\boxed{a_{1}+\boxed{b}}}\)`),
    String.raw`$x^{{a_{1}+{b}}}$`,
  );
  assert.equal(
    rich(String.raw`$\boxed {x}+\boxedName{y}+\\boxed{z}$`),
    String.raw`$ {x}+\boxedName{y}+\\boxed{z}$`,
  );
  assert.equal(
    rich("`" + String.raw`\boxed{x}` + "`"),
    "`" + String.raw`\boxed{x}` + "`",
  );
  assert.ok(
    rich("```tex\n" + String.raw`\boxed{x}` + "\n```").includes(
      String.raw`\boxed{x}`,
    ),
  );
});
test("multiline math remains atomic across message boundaries", () => {
  const formula = String.raw`\[
\begin{aligned}
a_1 &= \frac{1}{2} \\
b_2 &= 3
\end{aligned}
\]`;
  const parts = richAnswerParts(
    "prefix\n".repeat(30) + formula + "\nsuffix",
    256,
  );
  const math = parts.filter((p) => p.markdown.includes("begin{aligned}"));
  assert.equal(math.length, 1);
  assert.ok(math[0]!.markdown.includes("$$\n"));
  assert.ok(math[0]!.markdown.includes("\\end{aligned}\n$$"));
  assert.ok(parts.every((p) => Buffer.byteLength(p.markdown) <= 256));
});
test("math source is opaque to Markdown but cannot inject raw HTML", () => {
  const source = String.raw`\(x_1 + \text{![x](tg://user?id=1)} < y & z\)`;
  assert.equal(rich(source), "` " + source + " `");
  assert.equal(
    rich(String.raw`$x_1 + \frac{1}{2}$`),
    String.raw`$x_1 + \frac{1}{2}$`,
  );
});
test("delimiter collisions stay inert and raw alignment ampersands survive", () => {
  for (const source of [
    String.raw`\(x$ ![x](tg://user?id=1) $y\)`,
    String.raw`\[x$$ ![x](tg://photo?id=1) $$y\]`,
  ])
    assert.equal(rich(source), "` " + source + " `");
  assert.equal(rich(String.raw`\[a &= b\]`), String.raw`$$a &= b$$`);
  assert.equal(rich("\\(a\nb\\)"), "$a b$");
});
test("repeated unmatched math openers stay bounded and preserve input", () => {
  const source = "\\(".repeat(16000);
  const parts = richAnswerParts(source);
  assert.ok(parts.every((p) => Buffer.byteLength(p.markdown) <= 16000));
  assert.ok(parts.length > 1);
});
test("code, escaped delimiters, ordinary brackets and incomplete math remain untouched", () => {
  for (const source of [
    String.raw`(E(\xi)=3.3)`,
    String.raw`[ x + y ]`,
    String.raw`\(unfinished`,
    String.raw`\\(not math\\)`,
    String.raw`\$5 and \$10`,
  ])
    assert.equal(rich(source), source);
  const code = "`" + String.raw`\(x_1\) \[y\]` + "`";
  assert.equal(rich(code), code);
  const fenced = "```tex\n" + String.raw`\(x_1\) \[y\]` + "\n```";
  assert.ok(rich(fenced).includes(String.raw`\(x_1\) \[y\]`));
});
test("oversized formulas fall back to literal code without oversized chunks", () => {
  const parts = richAnswerParts(
    String.raw`\[` + "x+".repeat(1000) + String.raw`\]`,
    256,
  );
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => Buffer.byteLength(p.markdown) <= 256));
  assert.ok(parts.every((p) => /^```|^~~~/.test(p.markdown)));
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
