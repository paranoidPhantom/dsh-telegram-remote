/** Reviewed Telegram custom emoji IDs. Keep built-ins separate from user glob rules. */
export const DEFAULT_TOOL_ICONS = {
  reasoning: { emoji: "🤔", customEmojiId: "5449875850046481967" },
  read: { emoji: "👀", customEmojiId: "5280881372418816002" },
  write: { emoji: "✏️", customEmojiId: "5951984684027091542" },
  search: { emoji: "🔍", customEmojiId: "5258274739041883702" },
  shell: { emoji: "👩‍💻", customEmojiId: "5300999883996536855" },
  web: { emoji: "🌐", customEmojiId: "5879585266426973039" },
  fetch: { emoji: "📦", customEmojiId: "5255934767844567828" },
  research: { emoji: "🔬", customEmojiId: "5377580546748588396" },
  docs: { emoji: "📘", customEmojiId: "5222288230270909496" },
  agents: { emoji: "👾", customEmojiId: "5258196742435787040" },
  messages: { emoji: "📞", customEmojiId: "5453965363286925977" },
  jobs: { emoji: "🔄", customEmojiId: "5454074580010295588" },
  stop: { emoji: "💤", customEmojiId: "5258077595748030166" },
  todo: { emoji: "✅", customEmojiId: "5219899949281453881" },
  goals: { emoji: "🌟", customEmojiId: "5231279057110325686" },
  schedule: { emoji: "⏲️", customEmojiId: "5258258882022612173" },
  send: { emoji: "✈️", customEmojiId: "5258079378159453410" },
  images: { emoji: "🖼️", customEmojiId: "5257974976094412956" },
  office: { emoji: "📎", customEmojiId: "5454419255430767770" },
  slides: { emoji: "🌟", customEmojiId: "5190565880995537027" },
  packages: { emoji: "📦", customEmojiId: "5323289282499064033" },
  unknown: { emoji: "🔩", customEmojiId: "5260249805522744465" },
} as const;

export type DefaultToolIconCategory = keyof typeof DEFAULT_TOOL_ICONS;
export const DEFAULT_TOOL_EMOJI = DEFAULT_TOOL_ICONS.unknown.emoji;
export const DEFAULT_TOOL_CUSTOM_EMOJI_ID =
  DEFAULT_TOOL_ICONS.unknown.customEmojiId;

// Exact names only: unfamiliar tools must not accidentally inherit a wildcard icon.
const groups: Partial<Record<DefaultToolIconCategory, readonly string[]>> = {
  reasoning: ["reasoning"],
  read: [
    "read",
    "read_file",
    "read_mcp_resource",
    "cache_search",
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "working_directory",
  ],
  write: ["write", "edit", "write_file", "edit_file", "apply_patch"],
  search: ["glob", "grep", "create_worktree"],
  shell: ["bash"],
  web: [
    "web_search",
    "advanced_search",
    "multi_search",
    "platform_search",
    "domain_search",
    "free_search_test",
    "video_search",
    "weather",
  ],
  fetch: ["web_fetch"],
  research: ["research"],
  docs: [
    "skill",
    "mcp__context7__resolve-library-id",
    "mcp__context7__query-docs",
  ],
  agents: [
    "subagent",
    "subagent_fork",
    "list_agents",
    "list_subagent_models",
    "workflow",
    "ralph",
    "parallel",
  ],
  messages: ["send_message"],
  jobs: ["job_list", "job_output"],
  stop: ["interrupt_agent", "job_kill"],
  todo: ["todo_write"],
  goals: ["create_goal", "get_goal", "update_goal"],
  schedule: [
    "schedule_create",
    "schedule_edit",
    "schedule_list",
    "schedule_view",
  ],
  send: ["send_file", "present"],
  images: ["read_image"],
  office: ["office_template", "office_template_write"],
  slides: [
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
  packages: [
    "load_workspace_dependencies",
    "plugin_manager",
    "install_local_workbench",
  ],
};

const icons = new Map(
  Object.entries(groups).flatMap(([category, names]) =>
    names.map(
      (name) =>
        [
          name,
          DEFAULT_TOOL_ICONS[category as DefaultToolIconCategory],
        ] as const,
    ),
  ),
);

// Browser operations use the same semantic groups without guessing new IDs.
const chromeGroups: Partial<
  Record<DefaultToolIconCategory, readonly string[]>
> = {
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
};
for (const [category, names] of Object.entries(chromeGroups)) {
  for (const name of names) {
    icons.set(
      `mcp__chrome-devtools__${name}`,
      DEFAULT_TOOL_ICONS[category as DefaultToolIconCategory],
    );
  }
}

export function defaultToolIcon(full: string, normalized: string) {
  // Retain the MCP namespace: normalization alone loses context7's query-docs.
  const qualified = full.split(/[.:/]/).pop() ?? "";
  return (
    icons.get(qualified) ?? icons.get(normalized) ?? DEFAULT_TOOL_ICONS.unknown
  );
}
