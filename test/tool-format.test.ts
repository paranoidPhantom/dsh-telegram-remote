import test from "node:test";
import assert from "node:assert/strict";
import {
  formatToolResult,
  formatToolCall,
  formatApproval,
} from "../src/rendering/tool-format.js";

// Strict Telegram subset scanner: rejects unescaped entities, stray angle
// brackets, misnested tags and broken UTF-16 without relying on HTML recovery.
function safe(html: string, limit: number) {
  assert.ok(html.length <= limit, `length ${html.length} > ${limit}`);
  assert.equal(html.isWellFormed(), true);
  const stack: string[] = [];
  for (let i = 0; i < html.length;) {
    if (html[i] === "<") {
      const tag =
        /^(<\/?(?:b|code|pre|blockquote|tg-emoji)(?: expandable| emoji-id="\d+")?>)/.exec(
          html.slice(i),
        );
      assert.ok(tag, `bad markup: ${html.slice(i, i + 80)}`);
      const nameMatch = /^<\/?([\w-]+)/.exec(tag[0]);
      assert.ok(nameMatch?.[1]);
      const name = nameMatch[1];
      if (tag[0][1] === "/") assert.equal(stack.pop(), name);
      else stack.push(name);
      i += tag[0].length;
    } else if (html[i] === "&") {
      const entity = /^&(?:amp|lt|gt|quot|#39);/.exec(html.slice(i));
      assert.ok(entity, `bad entity: ${html.slice(i, i + 25)}`);
      i += entity[0].length;
    } else {
      assert.notEqual(html[i], ">");
      i++;
    }
  }
  assert.deepEqual(stack, []);
  return html;
}

test("DSH read envelope becomes semantic path and opaque numbered code", () => {
  const out = safe(
    formatToolResult(
      "functions.read",
      '<path>/tmp/a&b.js</path>\n<type>file</type>\n<content>\n1: const x = "<script>alert(1)</script>";\n2: <path>literal</path>\n3: </content> literal\n</content>',
    ),
    1800,
  );
  assert.match(out, /<b>Read file<\/b>/);
  assert.match(out, /<code>\/tmp\/a&amp;b.js<\/code>/);
  assert.match(out, /1: const x/);
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /&lt;path&gt;literal&lt;\/path&gt;/);
  assert.match(out, /&lt;\/content&gt; literal/);
  assert.doesNotMatch(out, /&lt;type&gt;file/);
});

test("unknown or partial XML remains literal rather than stripped", () => {
  for (const text of [
    "<div>value</div>",
    "<content>broken",
    "<path>x</path><script>evil</script>",
  ]) {
    assert.match(safe(formatToolResult("read", text), 1800), /&lt;/);
  }
});

test("representative tool results render safe semantic JSON and XML", () => {
  const examples: [string, unknown][] = [
    [
      "read_image",
      { path: "/tmp/a.png", type: "image", message: "Image loaded" },
    ],
    ["glob", { paths: ["a.js", "b.js"], count: 2 }],
    [
      "grep",
      {
        matches: [{ file: "a.js", line: 24, text: "<img src=x onerror=evil>" }],
      },
    ],
    ["write", { file_path: "a.js", success: true }],
    ["edit", { path: "a.js", diff: "- old\n+ <b>new</b>" }],
    ["bash", { stdout: "ok", stderr: "bad & worse", exit_code: 1 }],
    [
      "web_fetch",
      { url: "https://example.com/?a=1&b=2", content: "<html>hello</html>" },
    ],
    [
      "web_search",
      {
        results: [
          { title: "Result", url: "https://example.org", text: "<injection>" },
        ],
      },
    ],
    ["subagent", { agent_id: "abc", status: "running" }],
  ];
  for (const [name, value] of examples) {
    const out = safe(
      formatToolResult(`mcp__dsh__${name}`, JSON.stringify(value)),
      1800,
    );
    assert.doesNotMatch(
      out,
      /&quot;(?:file_path|stdout|results|agent_id)&quot;:/,
    );
  }
  const xml = safe(
    formatToolResult(
      "bash",
      "<stdout>Hello</stdout><stderr>oops</stderr><exit_code>1</exit_code>",
    ),
    1800,
  );
  assert.match(xml, /Errors/);
  assert.match(xml, /Exit code/);
  assert.match(
    safe(formatToolResult("bash", "hello\n[exit code: 0]"), 1800),
    /Exit code: 0/,
  );
});

test("tool calls normalize names and escape paths commands and code", () => {
  const out = safe(
    formatToolCall("functions.bash", {
      command: 'echo "<b>&hello</b>"',
      workdir: "/tmp/a&b",
    }),
    1000,
  );
  assert.match(out, /Run command/);
  assert.match(
    out,
    /<pre>echo &quot;&lt;b&gt;&amp;hello&lt;\/b&gt;&quot;<\/pre>/,
  );
  for (const name of [
    "read",
    "read_image",
    "write",
    "edit",
    "glob",
    "grep",
    "web_fetch",
    "web_search",
    "subagent",
  ]) {
    safe(
      formatToolCall(
        name,
        JSON.stringify({ file_path: "<bad>", content: "<code>literal</code>" }),
      ),
      1000,
    );
  }
});

test("approval parses JSON reason with localized text and does not invent permissions", () => {
  const out = safe(
    formatApproval({
      title: { en: "Edit files" },
      reason: JSON.stringify({
        command: 'rm "<file>"',
        paths: ["/tmp/a&b", "/tmp/c"],
        reason: { en: "Clean build" },
        consequences: "Deletes generated files",
      }),
    }),
    3800,
  );
  assert.match(out, /Edit files/);
  assert.match(out, /Clean build/);
  assert.match(out, /<pre>rm &quot;&lt;file&gt;&quot;<\/pre>/);
  assert.match(out, /<code>• \/tmp\/a&amp;b<\/code>/);
  assert.match(out, /Consequences/);
  assert.doesNotMatch(
    out,
    /persistent|Allow once|Permission|&quot;command&quot;/,
  );
});

test("approval handles explicit fields and hostile arbitrary values", () => {
  const out = safe(
    formatApproval({
      toolName: "bash",
      command: "echo ok",
      paths: ["<x>"],
      displayReason: { en: "<b>need & access</b>" },
      permission: "workspace-write",
      consequence: { en: "Changes files" },
    }),
    3800,
  );
  assert.match(out, /Requested|Permission/);
  assert.match(out, /workspace-write/);
  assert.match(out, /&lt;b&gt;need &amp; access&lt;\/b&gt;/);
  safe(
    formatApproval({
      title: { x: "<evil>" },
      reason: {
        command: { nested: "<b>not markup</b>" },
        paths: [{ path: "<x>" }],
      },
    }),
    3800,
  );
});

test("all budgets count encoded characters without breaking entities or astral Unicode", () => {
  const long = "<>&\"'😀界".repeat(3000);
  for (const out of [
    safe(formatToolResult("read", long), 1800),
    safe(formatToolCall("write", { content: long }), 1000),
    safe(formatApproval({ reason: long }), 3800),
  ]) {
    assert.match(out, /… \(truncated\)/);
  }
  for (let n = 1; n < 160; n++) {
    safe(formatToolResult("<x>", { content: "😀<&".repeat(n) }), 1800);
    safe(formatToolCall("<x>", { command: "😀<&".repeat(n) }), 1000);
    safe(formatApproval({ command: "😀<&".repeat(n) }), 3800);
  }
});

test("approval falls back to authoritative call arguments without trusting HTML", () => {
  const out = safe(
    formatApproval({
      toolName: "functions.bash",
      reason: "Approval needed",
      callArgs: {
        command: "echo <hello>",
        paths: ["/tmp/x"],
        description: "Run a command",
      },
      callHtml: "<script>untrusted</script>",
    }),
    3800,
  );
  assert.match(out, /Run command/);
  assert.match(out, /<pre>echo &lt;hello&gt;<\/pre>/);
  assert.match(out, /<code>• \/tmp\/x<\/code>/);
  assert.doesNotMatch(out, /script|untrusted/);
  safe(formatToolResult("read", "broken \ud800 text"), 1800);
});

test("permission wrapper extracts plugin action JSON into readable sections", () => {
  const reason =
    'Allow this operation with danger-full-access permissions: plugin_manager {"action":"remove_bundle","target":"@local/dsh-telegram-console"}. Profile changes persist across sessions; installed Host code runs outside the workspace sandbox.';
  const out = safe(
    formatApproval({ toolName: "plugin_manager", reason, description: reason }),
    3800,
  );
  assert.match(out, /Remove plugin bundle/);
  assert.match(out, /<code>@local\/dsh-telegram-console<\/code>/);
  assert.match(out, /Full access/);
  assert.match(out, /Profile changes persist/);
  assert.doesNotMatch(out, /&quot;action&quot;|Allow this operation with/);
});
test("nested MCP text envelope and non-JSON prose remain readable", () => {
  const out = safe(
    formatToolResult("read", {
      content: [
        {
          type: "text",
          text: "<path>a.js</path><type>file</type><content>1: hi</content>",
        },
      ],
    }),
    1800,
  );
  assert.match(out, /<code>a.js<\/code>/);
  assert.match(
    safe(formatToolResult("grep", "a.js:24:<foo>"), 1800),
    /a.js:24:&lt;foo&gt;/,
  );
});
