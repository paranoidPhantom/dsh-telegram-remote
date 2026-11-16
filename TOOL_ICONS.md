# Telegram tool icons

Built-in defaults selected by the repository owner. IDs remain decimal strings. Explicit `toolNameRules` override these defaults; a plain-emoji rule intentionally disables the custom emoji for its matches. Unrecognized tools use the fallback, including tools added by other sessions or MCP servers.

| Concept | Placeholder | Custom emoji ID | Tools / families |
| --- | --- | --- | --- |
| Reasoning preview | 🤔 | `5449875850046481967` | `reasoning` (collapsed-log entry, not a tool call) |
| Read files | 👀 | `5280881372418816002` | `read`, `read_mcp_resource`, `cache_search`, resource listings, `working_directory` |
| Write / edit | ✏️ | `5951984684027091542` | `write`, `edit`, patch tools |
| Find files / search contents | 🔍 | `5258274739041883702` | `glob`, `grep`, `create_worktree` |
| Shell commands | 👩‍💻 | `5300999883996536855` | `bash` and shell tools |
| Web search | 🌐 | `5879585266426973039` | `web_search`, `advanced_search`, `multi_search`, `platform_search`, `domain_search`, `free_search_test`, `video_search`, `weather` |
| Fetch a page | 📦 | `5255934767844567828` | `web_fetch` |
| Research | 🔬 | `5377580546748588396` | `research` |
| Documentation / skills | 📘 | `5222288230270909496` | Context7 library resolution/docs, `skill` |
| Subagents | 👾 | `5258196742435787040` | `subagent`, `subagent_fork`, `list_agents`, `list_subagent_models`, `workflow`, `ralph`, parallel calls |
| Agent messages | 📞 | `5453965363286925977` | `send_message` |
| Background jobs | 🔄 | `5454074580010295588` | `job_list`, `job_output` |
| Stop / cancel | 💤 | `5258077595748030166` | `interrupt_agent`, `job_kill` |
| Plans / checklist | ✅ | `5219899949281453881` | `todo_write`, pinned checklist heading |
| Goals | 🌟 | `5231279057110325686` | `create_goal`, `get_goal`, `update_goal` |
| Scheduled tasks | ⏲️ | `5258258882022612173` | `schedule_create`, `schedule_edit`, `schedule_list`, `schedule_view` |
| Send / present files | ✈️ | `5258079378159453410` | `send_file`, `present` |
| Images | 🖼️ | `5257974976094412956` | `read_image`, browser screenshots |
| Office documents | 📎 | `5454419255430767770` | `office_template`, `office_template_write` |
| Slides | 🌟 | `5190565880995537027` | `ppt_*`, `pptd_*` |
| Packages / plugins | 📦 | `5323289282499064033` | `load_workspace_dependencies`, `plugin_manager`, `install_local_workbench` |
| Unknown tool fallback | 🔩 | `5260249805522744465` | Any unmatched tool |

Browser tools are mapped to existing concepts where appropriate (search/navigation, read/inspect, edit/interact, screenshots, uploads, waits/background work); no separate custom IDs were invented. Listing them does not imply they were used to inspect DSH Desktop.

## Overrides

Rules are ordered, case-insensitive `*` globs matching the full name or normalized final component. The first explicit match wins, before built-in defaults. Maximum 100 configured rules; place a catch-all `*` last.

```yaml
toolNameRules:
  - pattern: 'read*'
    emoji: '👀'
    customEmojiId: '5280881372418816002'
  - pattern: 'reasoning'
    emoji: '🤔' # omit customEmojiId to use plain text instead
  - pattern: '*'
    emoji: '🔩'
    customEmojiId: '5260249805522744465'
```

Custom emoji rendering/animation still depends on Telegram client/server support. Source/tests establish emitted IDs and UTF-16 entities, not visually verified playback.
