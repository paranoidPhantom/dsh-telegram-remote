# Telegram Remote — developer handoff

## Start here

Telegram Remote is a **working, in-process DSH plugin**, not a separate bot daemon. DSH owns session truth; Telegram is a remote view. The worker/child-process design in `ISOLATION.md` is **a proposal only — NOT implemented**. Do not describe existing queue optimizations as process isolation.

Read `package.json` for the current version and `git status` before editing. The npm package, GitHub repository, Client factory ID, and bundle module name are `dsh-telegram-remote`. The source directory may still be named `dsh-telegram-console`; do not rename persistent keys simply to match branding. This repository uses MIT; artwork provenance is in `THIRD_PARTY_NOTICES.md`.

## Setup and checks

```sh
npm ci --ignore-scripts
npm test
npm pack --dry-run
```

Source is plain ESM JavaScript; there is no source build step. `client.js` uses the Harness module loader and `React.createElement`, not JSX or a standalone server. `esbuild` is used at runtime for widget module compilation; an environment without its platform binary may require its approved install script. Validate edited modules with `node --check`.

Tests inject Telegram APIs, clocks, storage, filesystem providers, and lightweight Client mocks. Never use a real token in fixtures. Run the whole suite after cross-module changes; do not hardcode the test count in documentation. Packaging tests check identity, locale/readme resources, locked defaults, and safety boundaries. Inspect the actual archive, not just the manifest's `files` list.

## Code map

| Area | Files / responsibility |
| --- | --- |
| Activation | `index.js`: dependency injection, settings, events, timers, prompt sections, polling lifecycle |
| DSH bridge | `bridge.js`: live/cold session operations, exact queue steering, file access; `session-selection.js`: fresh model suggestions |
| Projections | `run-projection.js`: pure turn fold; `touched-files.js`: successful file-change aggregation and confined downloads |
| Bot routing | `console.js`: owner authorization, opaque callbacks, commands, latest toolbar ownership |
| Topic lifecycle | `console-sessions.js`: confirmed new sessions, queued native-topic prompts, Telegram-only topic deletion |
| Pickers | `console-picker.js`: lazy session listing and in-place model/provider selection |
| Output delivery | `console-delivery.js`: durable output receipts, segmented logs, native drafts, stopped partials; `stream-scheduler.js`: bounded/coalesced frames |
| Telegram carrier | `adapter.js`: node-telegram-bot-api adapter, HTTPS carrier, scheduling lanes, cooldowns, native media |
| Settings | `settings-host.js`: authenticated write-only credentials/settings endpoint; `client.js`: themed Settings section |
| Localization | `bot-i18n.js`: bot dictionaries; `dsh-locale.js`: Host preference; `locale/*.json`: inventory metadata; Client keeps its UI dictionaries |
| Rendering | `answer-format.js`: Markdown subset to Telegram entities; `console-render.js`: collapsed logs/status; `tool-format.js`: bounded semantic tool/approval HTML; `path-display.js`: presentation-only relative paths |
| Files | `send-file.js`: model-facing artifact tool; `media-kind.js`: conservative extension + signature selection |
| Widgets | `compiler.js`, `safe-fetch.js`, `widget-pipeline.js`, `widget-delivery.js`: guarded resource inlining and send-before-delete replacement |
| Lifecycle | `runtime-lifecycle.js`: abort and drain work owned by one activation |

## Persistent state and security

- **Secrets:** use `ctx.credentials.modifyRecord/readRecord` with key `telegram-console/bot`; the local provider persists it in DSH's `.credentials.yaml`. Never edit that file yourself, return the saved token to the browser, or place it in config, argv, logs, fixtures, or Git. Settings verify writes by reading back internally; a blank token means keep the existing one.
- **Delivery/settings:** storage domain `telegram_console_delivery`, table `delivery`. Keys include `settings:adminUserId`, `poll-offset`, `console:topic:*`, `console:run:*`, and `widget:*`. Store message IDs, hashes, cursors, and plugin settings—not a competing database of DSH state. Runtime render caches may be derived/in-memory.
- **Locked first run:** the shipped patch uses `ownerId: 0`. No user is authorized until configured through Settings. Do not restore a personal default ID or absolute home path.
- **Admin changes:** clear pending controls and detach old topic bindings. Never let old-admin callbacks authorize operations for a new owner.
- **Settings route:** `/telegram-console/settings` uses Harness `connection.requestRejection/admit`, owner admission, bounded JSON input, and no-store responses. Desktop origins need Harness trust checks, NOT an arbitrary equality check against the internal HTTP origin. Preserve CSRF/Host/Origin protection.
- **Compatibility:** preserve `telegram-console` row/section IDs, credential and storage names unless implementing an explicit migration. Package branding alone is not a reason to change them.

## DSH / Cordis integration

Use live `cordis_inspect_list/query` before relying on a Service, Event, Config, Tool, or Slot API. Runtime contracts outrank examples. Installed Desktop sources inside `app.asar` need Harness file-read tools; native shell discovery cannot inspect that archive. Do not edit the DSH installation or write profile manifests by hand.

Register every route, tool, listener, timer, projection handle, and asynchronous lifetime under the owning Cordis effect. Unload must abort polling, cancel owned timers, dispose UI registrations, and drain work. A leaked settings route previously caused `duplicate exact route "/telegram-console/settings"` activation failures: test unload/reload, not only first activation. Do not restart the Host running your own agent.

Session projections are pure JSON folds; preserve reference identity for irrelevant events and bump `stateVersion` when their shape/semantics change. `runView` adds current working directory and touched-file metadata. `outputs` records committed normal text with sequence IDs and tool-count boundaries; transient `partialAnswer` is separate. Never expose reasoning chunks. Do not invent Session event types or treat bot delivery metadata as session truth.

## Bot behavior to preserve

### Topics, models, and controls
- `/sessions` **never creates topics just by listing**. Every session row is a callback button, even when a topic already exists. Only an explicit tap opens/creates the topic and then offers its link. Bot API cannot force client navigation.
- Native Telegram **New Topic** is supported. Confirm a live DSH model suggestion before creating/binding a DSH session. Preserve first prompts and original request IDs while waiting. Pending initiation text is currently memory-only and does not survive a Host restart.
- `/new` / New session uses the same owner-only model confirmation, then supplies a topic link. DSH owns defaults and selection; no bot-side preferred model. Native DSH model changes apply at the **next step boundary**, not necessarily the next turn.
- Model/provider picker edits the **same message** and marks the DSH-confirmed provider/model with ✓. No separate acknowledgement messages; preserve the previous selection and show an inline failure when rejected. Serialize mutations without recursively entering the same session queue.
- End topic confirms deletion of the Telegram topic/history only. Never delete or stop the DSH session. Closed mappings remain tombstoned; late events must not revive them. Explicit reopening is allowed.
- General controls move to the latest message. Keep Model / Details / End topic and touched-file buttons on the final answer. Do not clear that toolbar in preview cleanup. Pending approval decisions retain their buttons until settled.
- Authorize every callback against the configured owner, private chat, topic, expiry, and exact operation. Callback actions grant authority; the agent must never approve its own calls.
- Steer now promotes the **exact original queued request** via DSH `updateQueue({action:{kind:'steer'}})`; never submit duplicate text.

### Streaming, logs, and delivery
- Use native `sendMessageDraft` with stable nonzero draft IDs and `can_stop: true`. Validate native stopped-generation updates against chat/topic/current draft. Custom Stop is a fallback only when drafts are unsupported.
- Empty draft placeholder is **`Deep diving`**, without ellipsis (localized equivalents apply).
- Latest tool call lives in the draft, with custom emoji `5220046725493828505`. Move it into the collapsed log when another tool/text replaces it or the turn ends. Do not dump read-file contents. Keep workspace-relative paths monospace in both drafts and logs.
- Each completed normal assistant message becomes durable output immediately. Seal the preceding tool-log segment above it; later tools start a new log below it. Preserve all prior messages and stopped partial text; deduplicate committed outputs/finals.
- Persist accepted Telegram message IDs before cosmetic toolbar/log updates. Never replay an ambiguous send blindly; inspect pending receipts rather than claiming success. Transport errors and Telegram rejection are not interchangeable.
- Telegram HTML must escape untrusted data; entity offsets/lengths are UTF-16, including astral emoji. Local Markdown file references become monospace labels, not clickable local-path links. External HTTP(S) links remain links. Keep chunk boundaries and tags valid.
- Typing is a best-effort native chat action, not custom status text. It is throttled and renewed after drafts; client visibility is not guaranteed by a unit test.

### Throughput constraints
- Existing lanes: persistent sends paced per chat (~1100 ms), edits per message and drafts per topic (~300 ms), global outbound concurrency capped at 4. Polling and callback acknowledgements bypass normal outbound lanes. Respect Telegram's global 429 cooldown.
- Coalesce replaceable progress/drafts, never durable outputs or approval lifecycle decisions. Cache semantic page/control state; random callback IDs must not force otherwise identical edits. Update only changed pages.
- Heartbeats have one pending slot per session and read the latest view when admitted. Legacy toolbar migration runs once per activation, not every turn.
- Known remaining bottlenecks: polling awaits each update handler; session queues mix several kinds of work; sealing a log is awaited before its following output. `cosmetic()` suppresses some failures and current diagnostics retain only the last error, not a complete delivery trace. Investigate these before adding queues or promising real-time performance.

### Files and widgets
- `send_file` uploads a finished artifact and includes its workspace-relative path in the caption. Enforce canonical workspace containment, regular-file status, cancellation, and the 10 MiB cap.
- Native media selection currently covers JPEG/PNG photos, GIF animations, MP4 video, MP3/M4A audio after extension + signature checks. Other formats stay documents. Only definitive format rejection may fall back to document; do not retry ambiguous network sends.
- Final file buttons use exact recorded turn/path allowlists. Added/removed/edited emoji IDs are in `console.js`. Removed files require authoritative full pre-deletion bytes; never reconstruct arbitrary missing files from incomplete hunks. Current historical downloads are confined to the recorded/header workspace and can reject switched-workspace paths.
- Widgets use guarded bounded resource fetching, private-IP/redirect/DNS checks, deterministic compilation, and compiled-hash deduplication. Limits: 32 KiB raw HTML and 4 KiB zlib-9. Replacement sends first, deletes old second. Queries are disabled.
- **Do not promise production widget availability.** Telegram has rejected general bots with `INPUT_MEDIA_WIDGET_NOT_ALLOWED` despite older docs claiming private-chat support. Treat this as server eligibility, not invalid HTML; preserve the source-document fallback. Consult current upstream status before changing behavior.

## Localization and documentation

Supported languages: **en, zh, ru**; regional/underscore tags normalize to the base. Bot language comes from `settings.describe({redactSecrets:true})` → locale namespace `value.preference`, read dynamically by `dsh-locale.js`. Unsupported/unset values fall back to English; do not use Telegram `language_code`, browser language, or OS language for bot selection.

Add every plugin-owned bot message/button to all three dictionaries in `bot-i18n.js`; keep key/placeholder parity. Translate metadata and Settings UI too. Do not translate model answers, file contents, tool/provider identifiers, paths, or arbitrary backend details. Settings GET exposes only normalized locale and token presence, never token value. Prefer semantic action IDs over comparing translated button labels.

Keep `README.md`, `README.zh-CN.md`, and `README.ru.md` concise, equivalent, mutually linked, and carrying the same npm badge/install instructions. Update their capability claims when behavior changes. `README*.md` and `locale/*.json` must remain in packed resources. Design details belong here or in `ISOLATION.md` / `WIDGETS.md`, not the minimal README.

## Verification and release checklist

1. Add focused regressions, then run all tests and syntax checks. Useful groups: `output-preservation` / `projection-output` / `log-segments`; `delivery-efficiency` / `adapter` / `stream-scheduler`; `native-sessions` / `console`; `settings-host` / `settings-route`; `bot-i18n` / `dsh-locale` / `readme-locales`; `touched-files` / `send-file` / `media-kind`; `compiler` / `widget-delivery`; `release`.
2. Inspect `git diff --check`, staged changes, and archive contents. Exclude `.runtime-status.json`, credentials, `.env*`, bootstrap files, `node_modules`, logs, and generated tarballs. Never publish personal IDs or home paths in shipped configuration/source. Preserve MIT `LICENSE` and third-party notices; the Telegram logo comes from the Iconify logos collection, not original project artwork.
3. Bump package version and refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`. Verify package name, patch module, and Client loader ID all equal `dsh-telegram-remote`. Published npm versions cannot be overwritten; repack after any release-content change.
4. Build and inspect `npm pack --ignore-scripts`; run secret/personal-path checks on the actual tarball. Publish the verified archive with `npm publish ./dsh-telegram-remote-<version>.tgz --access public`. MFA/EOTP may require the human to authenticate locally; never request their password, token, or OTP in chat. Verify npm version, `latest` tag, and tarball checksum before claiming publication.
5. Git remote is `https://github.com/paranoidPhantom/dsh-telegram-remote` (origin commonly SSH), branch `main`. Commit/push only when authorized; never force-push or include unrelated changes.
6. Install/update only through Harness Plugin Manager. It may require remove-then-install for local replacements; do not manually edit profile dependencies or bypass install-script approval. Never activate both legacy `@local/dsh-telegram-console` and renamed packages as independent pollers.
7. **Installed is not loaded.** Check the returned activation result and runtime identity. Runtime diagnostics default to `<resolved packageDir>/.runtime-status.json` (or explicit `statusPath`); discover packageDir via Inspect, not a historical generation path or the source workspace. `/version` reports the bot handling requests. Same semantic version local generations may differ. Ask the user to restart DSH when needed; never restart your own Host.
8. Separate unit-test, activation, and actual Telegram/Desktop UI evidence. Desktop cannot always be exercised by browser MCP. Do not claim a credential save, custom emoji, typing animation, or rich-text appearance was visually verified from mocks alone. Runtime `lastError` can be stale; correlate DSH committed events and delivery receipts for missing messages.

## Next-agent isolation work

If asked to implement isolation, first read `ISOLATION.md`. Recommended direction is a **supervised child process**, not an unreferenced detached daemon: move Telegram networking/rendering/scheduling to the child; keep DSH state, credentials authority, prompts, model changes, and approval decisions in the Host. Define versioned bounded IPC, replay/cursor and backpressure semantics, one-poller ownership, and shutdown on parent death/unload. Send credentials over a private pipe, never argv/logs. Test busy Host, child crash, lost IPC, duplicate updates, credential rotation, restart, and uninstall. None of this process split exists yet; measure the existing head-of-line delays before attributing every lag to agent computation.
