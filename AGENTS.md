# Telegram Remote — developer handoff

## Start here

Telegram Remote is a **TypeScript DSH plugin with a supervised child process**, not an independent bot daemon. The Host retains DSH session truth and authority; the child owns Telegram networking, rendering and scheduling. DSH must remain running. Read [ISOLATION.md](ISOLATION.md) for the implemented boundary and recovery/verification limits; source implementation is not proof of successful Desktop activation or Telegram UI behavior.

Read `package.json` for the current version and `git status` before editing. The npm package, GitHub repository, Client factory ID, and bundle module name are `dsh-telegram-remote`. The source directory may still be named `dsh-telegram-console`; do not rename persistent keys simply to match branding. This repository uses MIT; artwork provenance is in `THIRD_PARTY_NOTICES.md`.

## Setup and checks

```sh
npm ci --ignore-scripts
npm run typecheck
npm run typecheck:test
npm test
npm run test:isolation
npm run build
npm pack --ignore-scripts --dry-run
```

Implementation and tests are TypeScript under `src/` and `test/`. `scripts/build.mjs` emits ESM JavaScript/declarations into `dist/`, bundles `src/client/index.ts` into the classic Harness module-loader `client.js`, and writes the thin root `index.js` entry. Edit source, not generated entries. `npm test` compiles tests into `.build/unit/`; isolation tests use `.build/isolation/`. The suite runner clears only its verified generated directory before compiling, preventing stale renamed tests from running. `npm run test:all` runs both suites; `npm run verify:package` rebuilds and inspects an actual archive with extracted-entry smoke checks. `npm run typecheck` checks Host/child and Client projects; `npm run typecheck:test` checks tests. Build before packing with `--ignore-scripts` (which skips `prepack`). `esbuild` is also used at runtime for widget compilation; its platform binary may require an approved install script. `node --check` on emitted JavaScript supplements, not replaces, TypeScript checks.

Tests inject Telegram APIs, clocks, storage, filesystem providers, and lightweight Client mocks. Never use a real token in fixtures. Run the whole suite after cross-module changes; do not hardcode the test count in documentation. Packaging tests check identity, locale/readme resources, locked defaults, and safety boundaries. Inspect the actual archive, not just the manifest's `files` list.

## Code map

| Area | Files / responsibility |
| --- | --- |
| Activation | `src/index.ts`: Host wiring, settings, semantic event publication, prompts, file/widget tools and child rotation |
| Supervision | `src/host/launcher.ts`, `supervisor.ts`, `lease.ts`: sanitized non-detached fork, handshake, restart budget, owned-PID shutdown and local bot exclusion |
| Authority and recovery | `src/host/authority.ts`, `approvals.ts`, `operations.ts`, `inbox.ts`, `resources.ts`: Host-only capabilities, decision IDs, operation journal, inbound admission and bounded resource handles |
| IPC | `src/protocol/`: validated versioned JSON, generation fences, bounded RPC, cancellation and process transport |
| Child runtime | `src/child/index.ts`, `runtime.ts`, `host-port.ts`, `ingress.ts`: entry/handshake, Telegram surface, RPC bridge, polling/admission and priority dispatch |
| DSH bridge | `src/bridge/bridge.ts`, `session-selection.ts`: live/cold sessions, exact queue steering, file access and fresh model suggestions |
| Projections | `src/projection/run-projection.ts`, `types.ts`; `src/files/touched-files.ts`: pure folds, successful file-change aggregation and confined downloads |
| Bot | `src/bot/console.ts`, `console-sessions.ts`, `console-picker.ts`, `contracts.ts`: owner controls, topics, model confirmation and explicit surface contracts |
| Delivery | `src/delivery/console-delivery.ts`, `stream-scheduler.ts`, `runtime-lifecycle.ts`: output receipts, segmented logs, native drafts, coalescing and owned async work |
| Telegram carrier | `src/telegram/adapter.ts`, `safe-fetch.ts`: API transport, lanes/cooldowns/native media and guarded fetching |
| Settings / Client | `src/host/settings-host.ts`; `src/client/`: authenticated credential/settings endpoint and themed Harness Settings section |
| Localization | `src/i18n/`: bot dictionaries, Host locale and topic mode; `locale/*.json`: inventory metadata; `src/client/messages.ts`: UI dictionaries |
| Rendering | `src/rendering/`: Telegram entities, collapsed logs, semantic tool/approval HTML and presentation-only paths |
| Files / widgets | `src/files/send-file.ts`, `media-kind.ts`; `src/host/widget-pipeline.ts`, `src/widgets/`: Host-confined reads, chunked resource transfer, child compilation/delivery and source fallback |
| Build / tests | `scripts/build.mjs`, `tsconfig*.json`, `test/*.test.ts`, `test/isolation/*.test.ts`: emitted package and separate regression/IPC suites |

## Persistent state and security

- **Secrets:** use `ctx.credentials.modifyRecord/readRecord` with key `telegram-console/bot`; the local provider persists it in DSH's `.credentials.yaml`. Never edit that file yourself, return the saved token to the browser, or place it in config, argv, logs, fixtures, or Git. Settings verify writes by reading back internally; a blank token means keep the existing one.
- **Delivery/settings:** storage domain `telegram_console_delivery`, table `delivery`. Keys include `settings:adminUserId`, `settings:ownerEpoch`, `console:inbox`, `console:operation:*`, `poll-offset`, `console:topic:*`, `console:run:*`, and `widget:*`. Store message IDs, hashes, cursors, and plugin settings—not a competing database of DSH state. Runtime render caches may be derived/in-memory.
- **Locked first run:** the shipped patch uses `ownerId: 0`. No user is authorized until configured through Settings. Do not restore a personal default ID or absolute home path.
- **Admin changes:** clear pending controls and detach old topic bindings. Never let old-admin callbacks authorize operations for a new owner.
- **Settings route:** `/telegram-console/settings` uses Harness `connection.requestRejection/admit`, owner admission, bounded JSON input, and no-store responses. Desktop origins need Harness trust checks, NOT an arbitrary equality check against the internal HTTP origin. Preserve CSRF/Host/Origin protection.
- **Compatibility:** preserve `telegram-console` row/section IDs, credential and storage names unless implementing an explicit migration. Package branding alone is not a reason to change them.

## DSH / Cordis integration

Use live `cordis_inspect_list/query` before relying on a Service, Event, Config, Tool, or Slot API. Runtime contracts outrank examples. Installed Desktop sources inside `app.asar` need Harness file-read tools; native shell discovery cannot inspect that archive. Do not edit the DSH installation or write profile manifests by hand.

Register every route, tool, listener, timer, projection handle, and asynchronous lifetime under the owning Cordis effect. Unload must abort polling, cancel owned timers, dispose UI registrations, and drain work. A leaked settings route previously caused `duplicate exact route "/telegram-console/settings"` activation failures: test unload/reload, not only first activation. Do not restart the Host running your own agent.

Session projections are pure JSON folds; preserve reference identity for irrelevant events and bump `stateVersion` when their shape/semantics change. `runView` adds current working directory and touched-file metadata. `outputs` records committed normal text with sequence IDs and tool-count boundaries; transient `partialAnswer` is separate. Only explicit provider/session reasoning text may become a bounded 240-character preview (at most 64 per turn) in the collapsed log, clearly localized and escaped. Never expose raw chunks, encrypted reasoning/signatures, replay metadata or internal agent state; never mix reasoning into normal answers or drafts. Keep real tool counts/toolLog separate from chronological activity and its output logCount boundaries. Do not invent Session event types or treat bot delivery metadata as session truth.

## Bot behavior to preserve

### Topics, models, and controls
- `/sessions` **never creates topics just by listing**. Every session row is a callback button, even when a topic already exists. Only an explicit tap opens/creates the topic and then offers its link. Bot API cannot force client navigation.
- Native Telegram **New Topic** is supported. Confirm a live DSH model suggestion before creating/binding a DSH session. Preserve first prompts and original request IDs while waiting. Pending model-confirmation state is child-memory-only; do not promise survival across child or Host restart merely because inbound updates are journaled.
- `/new` / New session uses the same owner-only model confirmation, then supplies a topic link. DSH owns defaults and selection; no bot-side preferred model. Native DSH model changes apply at the **next step boundary**, not necessarily the next turn.
- Model/provider picker edits the **same message** and marks the DSH-confirmed provider/model with ✓. No separate acknowledgement messages; preserve the previous selection and show an inline failure when rejected. Serialize mutations without recursively entering the same session queue.
- End topic confirms deletion of the Telegram topic/history only. Never delete or stop the DSH session. Closed mappings remain tombstoned; late events must not revive them. Explicit reopening is allowed.
- General controls move to the latest message. Keep Model / End topic and touched-file buttons on the final answer. Session diagnostics and directory live in the pinned initialization card, not a Details button. Do not clear the final toolbar in preview cleanup. Pending approval decisions retain their buttons until settled; settled cards retain the reviewed operation and remove decision buttons.
- Authorize every callback against the configured owner, private chat, topic, expiry, and exact operation. Callback actions grant authority; the agent must never approve its own calls.
- Steer now promotes the **exact original queued request** via DSH `updateQueue({action:{kind:'steer'}})`; never submit duplicate text.

### Streaming, logs, and delivery
- Use native `sendMessageDraft` with stable nonzero draft IDs and `can_stop: true`. Validate native stopped-generation updates against chat/topic/current draft. Custom Stop is a fallback only when drafts are unsupported.
- Empty draft placeholder is **`Deep diving`**, without ellipsis (localized equivalents apply). The real message's empty placeholder is one custom emoji `5294363352070367389` (⏳ fallback), including when native drafts are unsupported; subsequent answer text remains plain/formatted as appropriate.
- Latest tool call lives in the draft. `toolNameRules` in plugin config selects per-tool plain/custom emoji consistently in drafts, call formatting and logs (ordered case-insensitive `*` globs against full/normalized names); built-in category icons use the owner-selected IDs in `TOOL_ICONS.md`, with 🔩 / `5260249805522744465` for unknown tools. Logs have no ordered numbering or working/finished title. Move the latest call into the collapsed log when another tool/text replaces it or the turn ends. Do not dump read-file contents. Keep workspace-relative paths monospace in both drafts and logs.
- Each completed normal assistant message becomes durable output immediately. Seal the preceding tool-log segment above it; later tools start a new log below it. Preserve all prior messages and stopped partial text; deduplicate committed outputs/finals.
- Persist accepted Telegram message IDs before cosmetic toolbar/log updates. Never replay an ambiguous send blindly; inspect pending receipts rather than claiming success. Transport errors and Telegram rejection are not interchangeable.
- Telegram HTML must escape untrusted data; entity offsets/lengths are UTF-16, including astral emoji. Local Markdown file references become monospace labels, not clickable local-path links. External HTTP(S) links remain links. Keep chunk boundaries and tags valid.
- Typing is a best-effort native chat action, not custom status text. It is throttled and renewed after drafts; client visibility is not guaranteed by a unit test.

### Throughput constraints
- Existing lanes: persistent sends paced per chat (~1100 ms), edits per message and drafts per topic (~300 ms), global outbound concurrency capped at 4. Polling and callback acknowledgements bypass normal outbound lanes. Respect Telegram's global 429 cooldown.
- Coalesce replaceable progress/drafts, never durable outputs or approval lifecycle decisions. Cache semantic page/control state; random callback IDs must not force otherwise identical edits. Update only changed pages.
- Heartbeats have one pending slot per session and read the latest view when admitted. Legacy toolbar migration runs once per activation, not every turn.
- Polling now awaits Host inbox admission, not handler completion. Child ingress dispatches bounded normal work with per-topic gates and a reserved serial priority slot for Stop/approval actions; authorization still applies. Host RPC/storage stalls can still delay admission or controls, session queues still mix work, and sealing a log is awaited before its following output. `cosmetic()` suppresses some failures; status diagnostics are not a complete delivery trace. Snapshot coalescing is not a durable committed-output queue; verify loss/replay boundaries before promising real-time or lossless delivery.

### Files and widgets
- `send_file` uploads a finished artifact and includes its workspace-relative path in the caption. Enforce canonical workspace containment, regular-file status, cancellation, and the 10 MiB cap.
- Native media selection currently covers JPEG/PNG photos, GIF animations, MP4 video, MP3/M4A audio after extension + signature checks. Other formats stay documents. Only definitive format rejection may fall back to document; do not retry ambiguous network sends.
- Final file buttons use exact recorded turn/path allowlists. Added/removed/edited emoji IDs are in `src/bot/console.ts`. Removed files require authoritative full pre-deletion bytes; never reconstruct arbitrary missing files from incomplete hunks. Current historical downloads are confined to the recorded/header workspace and can reject switched-workspace paths.
- Widgets use guarded bounded resource fetching, private-IP/redirect/DNS checks, deterministic compilation, and compiled-hash deduplication. Limits: 32 KiB raw HTML and 4 KiB zlib-9. Replacement sends first, deletes old second. Queries are disabled.
- **Do not promise production widget availability.** Telegram has rejected general bots with `INPUT_MEDIA_WIDGET_NOT_ALLOWED` despite older docs claiming private-chat support. Treat this as server eligibility, not invalid HTML; preserve the source-document fallback. Consult current upstream status before changing behavior.

## Tool icon configuration

Set `toolNameRules` in the plugin's DSH config and reload the plugin (not the credential Settings form). The first matching rule wins. `pattern` is a case-insensitive glob with only `*` special; it matches the full tool name or the final namespace/MCP component (`functions.read`, `fs/read`, and `mcp__fs__read` normalize to `read`). Explicit rules override built-in category defaults documented in `TOOL_ICONS.md`; unknown tools use 🔩 and Telegram custom emoji `5260249805522744465`. A matched rule may set `emoji` (fallback text, default 🔩) and `customEmojiId` (decimal string); omitting the ID uses plain text. Maximum 100 rules, 200 characters per pattern and 32 UTF-16 units per fallback emoji. Tool identifiers and summaries remain escaped text; rules cannot inject markup. This shared matcher also classifies file mutations for compact log detail filtering.

```yaml
toolNameRules:
  - pattern: 'read*'
    emoji: '👀'
    customEmojiId: '5280881372418816002' # read-files default
  - pattern: '*'
    emoji: '🔩' # plain fallback for all other tools
```

## Localization and documentation

Supported languages: **en, zh, ru**; regional/underscore tags normalize to the base. Bot language comes from `settings.describe({redactSecrets:true})` → locale namespace `value.preference`, resolved by `src/i18n/dsh-locale.ts`. The child receives locale at initialization and the Host forwards detected preference changes through `settings.update`; the lifecycle-owned check runs once per second. Treat that as eventual propagation, not a visually verified instantaneous UI change. Unsupported/unset values fall back to English; do not use Telegram `language_code`, browser language, or OS language for bot selection.

Add every plugin-owned bot message/button to all three dictionaries in `src/i18n/bot-i18n.ts`; keep key/placeholder parity. Translate metadata and Settings UI too. Do not translate model answers, file contents, tool/provider identifiers, paths, or arbitrary backend details. Settings GET exposes only normalized locale and token presence, never token value. Prefer semantic action IDs over comparing translated button labels.

Keep `README.md`, `README.zh-CN.md`, and `README.ru.md` concise, equivalent, mutually linked, and carrying the same npm badge/install instructions. Update their capability claims when behavior changes. `README*.md` and `locale/*.json` must remain in packed resources. Design details belong here or in `ISOLATION.md` / `WIDGETS.md`, not the minimal README.

## Verification and release checklist

1. Add focused regressions, then run both test suites, Host/Client and test typechecks, build, and emitted-JavaScript syntax checks. Isolation coverage lives in `test/isolation/` (protocol/RPC, supervisor, lease, ingress/inbox, authority, approvals, operations and resources); unit mocks are not real process/Desktop evidence. Useful groups: `output-preservation` / `projection-output` / `log-segments`; `delivery-efficiency` / `adapter` / `stream-scheduler`; `native-sessions` / `console`; `settings-host` / `settings-route`; `bot-i18n` / `dsh-locale` / `readme-locales`; `touched-files` / `send-file` / `media-kind`; `compiler` / `widget-delivery`; `release`.
2. Inspect `git diff --check`, staged changes, and archive contents. Exclude `.runtime-status.json`, credentials, `.env*`, bootstrap files, `node_modules`, logs, and generated tarballs. Never publish personal IDs or home paths in shipped configuration/source. Preserve MIT `LICENSE` and artwork notices. `icon.svg` is the repository owner's custom composite of DeepSeek and Telegram logo elements; preserve both credits in `THIRD_PARTY_NOTICES.md`. Do not overwrite it or restore the removed standalone Telegram logo.
3. Bump package version and refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`. Verify package name, patch module, and Client loader ID all equal `dsh-telegram-remote`. Published npm versions cannot be overwritten; repack after any release-content change.
4. Run `npm run build`, then create an archive with `npm pack --ignore-scripts` and inspect it with `tar -tzf ./dsh-telegram-remote-<version>.tgz`. Verify emitted `dist/index.js`, `dist/child/index.js`, declarations, generated Client, locale/readme resources and absence of legacy duplicate implementations; run secret/personal-path checks on the actual tarball. Publish the verified archive with `npm publish ./dsh-telegram-remote-<version>.tgz --access public`. MFA/EOTP may require the human to authenticate locally; never request their password, token, or OTP in chat. Verify npm version, `latest` tag, and tarball checksum before claiming publication.
5. Git remote is `https://github.com/paranoidPhantom/dsh-telegram-remote` (origin commonly SSH), branch `main`. Commit/push only when authorized; never force-push or include unrelated changes.
6. Install/update only through Harness Plugin Manager. It may require remove-then-install for local replacements; do not manually edit profile dependencies or bypass install-script approval. Never activate both legacy `@local/dsh-telegram-console` and renamed packages as independent pollers.
7. **Installed is not loaded.** Check the returned activation result and runtime identity. Runtime diagnostics default to `<resolved packageDir>/.runtime-status.json` (or explicit `statusPath`); discover packageDir via Inspect, not a historical generation path or the source workspace. `/version` reports the bot handling requests. Same semantic version local generations may differ. Ask the user to restart DSH when needed; never restart your own Host.
8. Separate unit-test, activation, and actual Telegram/Desktop UI evidence. Desktop cannot always be exercised by browser MCP. Do not claim a credential save, custom emoji, typing animation, or rich-text appearance was visually verified from mocks alone. Runtime `lastError` can be stale; correlate DSH committed events and delivery receipts for missing messages.

## Continuing isolation work

Read [ISOLATION.md](ISOLATION.md) before changing the boundary. Preserve Host authority, private-pipe credentials, version/generation/owner fences, one-poller exclusion, and shutdown before lease/store release. Do not add a detached/unreferenced daemon or an in-process fallback. Inbox admission, DSH operation completion and Telegram delivery are separate acknowledgements. Recovery is evolving: verify actual storage durability, crash windows, bounded cold replay and committed-output coverage rather than declaring durable session cursors or exactly-once delivery complete. Exercise busy Host, real child launch/crash/disconnect, credential/admin rotation, unload/reload, Host restart and uninstall; record actual evidence separately from mocks.
