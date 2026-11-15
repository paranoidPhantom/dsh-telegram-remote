# Telegram Remote contributor guide

## Purpose
DSH is the authority for sessions, model selection, prompts, tools, and approvals. Telegram is a remote view. Keep only delivery bookkeeping and plugin settings in plugin storage; keep bot tokens exclusively in DSH credentials (`telegram-console/bot`). Never commit tokens, credential files, runtime snapshots, or personal configuration.

## Structure
- `index.js`: Cordis activation, event wiring, resource ownership.
- `bridge.js`, `run-projection.js`, `touched-files.js`: DSH reads/mutations and pure log projections.
- `console.js`: owner-authorized command/callback routing.
- `console-picker.js`, `console-sessions.js`: picker and topic lifecycle.
- `console-delivery.js`, `stream-scheduler.js`, `adapter.js`: ordered outputs, coalesced previews, rate-limited Telegram requests.
- `settings-host.js`, `client.js`: authenticated settings page; secrets are write-only.
- `answer-format.js`, `tool-format.js`, `console-render.js`: escaped, bounded Telegram formatting.
- `send-file.js`, `media-kind.js`: confined artifact delivery and native media selection.
- `compiler.js`, `safe-fetch.js`, `widget-*.js`: bounded widget compilation/delivery. Production availability is controlled by Telegram.

## Development
Run `npm ci --ignore-scripts` and `npm test`. There is no source build step. Validate JavaScript with `node --check` when editing lifecycle code. Before release, run `npm pack --dry-run`, inspect its files, and verify package/Client factory/patch names agree. Never run package-manager commands in the DSH profile directory.

Use live `cordis_inspect_*` contracts before relying on Harness services/events. Installed Desktop sources live in app.asar and require Harness file-read tools; native shell discovery cannot inspect that archive. Register every route, timer, tool, listener, and background lifetime under the owning Cordis effect. Plugin unload must abort polling and drain owned work. Do not restart the current agent's Host process.

## Invariants
- Check owner/chat/topic binding for every callback. Approval grants remain user-only.
- No DSH mutation happens via a local UI guess: show the acknowledged state.
- Preserve every completed normal assistant message and stopped partial text; never publish reasoning. Persist accepted send IDs before cosmetic cleanup. Do not blindly retry ambiguous sends.
- Coalesce replaceable drafts, never durable outputs. Respect 429 cooldowns. Keep unrelated topics independent.
- Session listing must not create topics. Create on explicit opening; native New Topic confirms a model before binding. End topic deletes only the Telegram topic, not DSH data.
- Tool logs are compact, collapsed, segmented around assistant messages, with relative monospace paths. Only the newest message owns general controls; final controls remain visible.
- File downloads require workspace containment and bounded reads. Removed files need authoritative pre-deletion content. Never invent bytes.
- Escape all untrusted text before Telegram HTML; keep entity offsets UTF-16-correct. Fetch widget resources only through SSRF-guarded bounded transport.

## Tests and releases
Add regression tests for behavioral fixes, including failures and cancellation. Tests use injected APIs, clocks, storage, and filesystem providers; no real bot token is needed. Report unit-test evidence separately from live activation/client verification. An installed version is not necessarily loaded; inspect runtime identity or `/version`.

The npm package is `dsh-telegram-remote`. Preserve existing credential/storage keys for migration. Keep README minimal: capability and Plugin Manager installation. Broader design notes belong in separate documents. Never publish personal admin IDs, absolute home paths, or runtime artifacts.
