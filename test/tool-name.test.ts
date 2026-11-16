import test from "node:test";
import assert from "node:assert/strict";
import {
  matchToolName,
  DEFAULT_TOOL_ICONS,
  DEFAULT_TOOL_EMOJI,
  DEFAULT_TOOL_CUSTOM_EMOJI_ID,
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
    DEFAULT_TOOL_EMOJI,
  );
  assert.equal(matchToolName("mcp__fs__EDIT").isChange, true);
  assert.equal(
    matchToolName("unknown").customEmojiId,
    DEFAULT_TOOL_CUSTOM_EMOJI_ID,
  );
  assert.throws(() =>
    toolNameRulesSchema.parse([
      { pattern: "read", customEmojiId: '123" onclick="x' },
    ]),
  );
});

const categories = [
  ["reasoning", "🤔", "5449875850046481967", ["reasoning"]],
  [
    "read",
    "👀",
    "5280881372418816002",
    [
      "read",
      "read_file",
      "read_mcp_resource",
      "cache_search",
      "list_mcp_resources",
      "list_mcp_resource_templates",
      "working_directory",
    ],
  ],
  [
    "write",
    "✏️",
    "5951984684027091542",
    ["write", "edit", "write_file", "edit_file", "apply_patch"],
  ],
  ["search", "🔍", "5258274739041883702", ["glob", "grep", "create_worktree"]],
  ["shell", "👩‍💻", "5300999883996536855", ["bash"]],
  [
    "web",
    "🌐",
    "5879585266426973039",
    [
      "web_search",
      "advanced_search",
      "multi_search",
      "platform_search",
      "domain_search",
      "free_search_test",
      "video_search",
      "weather",
    ],
  ],
  ["fetch", "📦", "5255934767844567828", ["web_fetch"]],
  ["research", "🔬", "5377580546748588396", ["research"]],
  [
    "docs",
    "📘",
    "5222288230270909496",
    ["skill", "mcp__context7__resolve-library-id", "mcp__context7__query-docs"],
  ],
  [
    "agents",
    "👾",
    "5258196742435787040",
    [
      "subagent",
      "subagent_fork",
      "list_agents",
      "list_subagent_models",
      "workflow",
      "ralph",
      "multi_tool_use.parallel",
    ],
  ],
  ["messages", "📞", "5453965363286925977", ["send_message"]],
  ["jobs", "🔄", "5454074580010295588", ["job_list", "job_output"]],
  ["stop", "💤", "5258077595748030166", ["interrupt_agent", "job_kill"]],
  ["todo", "✅", "5219899949281453881", ["todo_write"]],
  [
    "goals",
    "🌟",
    "5231279057110325686",
    ["create_goal", "get_goal", "update_goal"],
  ],
  [
    "schedule",
    "⏲️",
    "5258258882022612173",
    ["schedule_create", "schedule_edit", "schedule_list", "schedule_view"],
  ],
  ["send", "✈️", "5258079378159453410", ["send_file", "present"]],
  ["images", "🖼️", "5257974976094412956", ["read_image"]],
  [
    "office",
    "📎",
    "5454419255430767770",
    ["office_template", "office_template_write"],
  ],
  [
    "slides",
    "🌟",
    "5190565880995537027",
    [
      "ppt_list_templates",
      "ppt_get_template_pages",
      "ppt_get_template_reference",
      "ppt_template_create_project",
      "pptd_import",
      "pptd_list_files",
      "pptd_read_file",
      "pptd_write_file",
      "pptd_add_asset",
      "pptd_check",
      "pptd_render",
    ],
  ],
  [
    "packages",
    "📦",
    "5323289282499064033",
    [
      "load_workspace_dependencies",
      "plugin_manager",
      "install_local_workbench",
    ],
  ],
  [
    "unknown",
    "🔩",
    "5260249805522744465",
    [
      "ask_user_question",
      "some_new_tool",
      "query-docs",
      "mcp__other__query-docs",
    ],
  ],
] as const;

test("all 22 supplied category icons use the exact reviewed IDs and known names", () => {
  assert.equal(Object.keys(DEFAULT_TOOL_ICONS).length, 22);
  for (const [category, emoji, customEmojiId, names] of categories) {
    assert.deepEqual(DEFAULT_TOOL_ICONS[category], { emoji, customEmojiId });
    for (const name of names) {
      for (const qualified of [
        name,
        `functions.${name}`,
        `fs/${name}`,
        name.toUpperCase(),
      ]) {
        const icon = matchToolName(qualified);
        assert.equal(icon.emoji, emoji, qualified);
        assert.equal(icon.customEmojiId, customEmojiId, qualified);
      }
      assert.equal(
        toolEmojiHtml(name),
        `<tg-emoji emoji-id="${customEmojiId}">${emoji}</tg-emoji>`,
      );
    }
  }
  assert.equal(
    matchToolName("mcp__fs__READ").customEmojiId,
    DEFAULT_TOOL_ICONS.read.customEmojiId,
  );
  assert.equal(matchToolName("read_extra").emoji, DEFAULT_TOOL_EMOJI);
  assert.equal(matchToolName("ppt_unrecognized").emoji, DEFAULT_TOOL_EMOJI);
  assert.equal(matchToolName(null).customEmojiId, DEFAULT_TOOL_CUSTOM_EMOJI_ID);
});

test("every Chrome inventory tool has a semantic icon without a namespace wildcard", () => {
  const groups = {
    read: [
      "list_pages",
      "select_page",
      "take_snapshot",
      "get_css_styles",
      "get_console_message",
      "list_console_messages",
      "get_network_request",
      "list_network_requests",
      "take_heapsnapshot",
      "wait_for",
    ],
    write: [
      "new_page",
      "close_page",
      "navigate_page",
      "click",
      "drag",
      "hover",
      "fill",
      "fill_form",
      "type_text",
      "press_key",
      "handle_dialog",
      "upload_file",
      "set_logpoints",
      "emulate",
      "resize_page",
    ],
    shell: ["evaluate_script"],
    research: ["lighthouse_audit", "performance_analyze_insight"],
    jobs: ["performance_start_trace", "screencast_start"],
    stop: ["performance_stop_trace", "screencast_stop"],
    images: ["take_screenshot"],
  } as const;
  for (const [category, names] of Object.entries(groups)) {
    for (const name of names) {
      assert.equal(
        matchToolName(`functions.mcp__chrome-devtools__${name}`).customEmojiId,
        DEFAULT_TOOL_ICONS[category as keyof typeof groups].customEmojiId,
        name,
      );
    }
  }
  assert.equal(
    matchToolName("mcp__chrome-devtools__unknown").emoji,
    DEFAULT_TOOL_EMOJI,
  );
  assert.equal(
    matchToolName("mcp__unrelated__click").emoji,
    DEFAULT_TOOL_EMOJI,
  );
});

test("explicit plain, custom, full MCP and catch-all rules always override built-ins", () => {
  assert.deepEqual(matchToolName("read", [{ pattern: "read", emoji: "R" }]), {
    normalized: "read",
    emoji: "R",
    customEmojiId: undefined,
    isChange: false,
  });
  assert.equal(
    matchToolName("read", [{ pattern: "read", customEmojiId: "123" }]).emoji,
    DEFAULT_TOOL_EMOJI,
  );
  assert.equal(
    matchToolName("read", [{ pattern: "read" }]).customEmojiId,
    undefined,
  );
  const rules = [
    { pattern: "*", emoji: "X" },
    { pattern: "read", emoji: "R", customEmojiId: "123" },
  ];
  for (const name of ["read", "mcp__context7__query-docs", "bash", "unknown"]) {
    assert.equal(matchToolName(name, rules).emoji, "X");
    assert.equal(matchToolName(name, rules).customEmojiId, undefined);
  }
  const custom = [
    { pattern: "MCP__CONTEXT7__*", emoji: "D", customEmojiId: "456" },
  ];
  assert.equal(
    matchToolName("mcp__context7__query-docs", custom).customEmojiId,
    "456",
  );
  assert.equal(
    matchToolName("edit", [{ pattern: "*", emoji: "X" }]).isChange,
    true,
  );
  assert.equal(
    toolNameRulesSchema.parse(
      Array.from({ length: 100 }, () => ({ pattern: "never" })),
    ).length,
    100,
  );
  assert.throws(() =>
    toolNameRulesSchema.parse(
      Array.from({ length: 101 }, () => ({ pattern: "never" })),
    ),
  );
  assert.throws(() =>
    toolNameRulesSchema.parse([{ pattern: "read", emoji: "👩‍💻".repeat(7) }]),
  );
});

test("shell icon preserves the full five-unit UTF-16 sequence in calls and logs", () => {
  assert.equal(matchToolName("functions.bash").emoji.length, 5);
  const html = '<tg-emoji emoji-id="5300999883996536855">👩‍💻</tg-emoji>';
  assert.ok(
    formatToolCall("functions.bash", { command: "pwd" }).startsWith(html + " "),
  );
  const log = toolLogPages(
    [{ name: "functions.bash", summary: "pwd", status: "completed" }],
    true,
  ).join("");
  assert.ok(log.includes(html));
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
