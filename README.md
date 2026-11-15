# Telegram Remote

Owner-only persistent Host plugin, implementing the revised Telegram-only concept. No Mini App, Nuxt, public endpoint, tunnel, or separate server. Each session opens a private-chat topic with a pinned control card, provider-grouped paginated model buttons and latest-response controls. Stop appears only during active runs; diagnostics are hidden behind Details. Commands: /sessions, /new, /status, /stop, /files, /help.

## Deployment

Installed through DSH Plugin Manager using this package directory. Owner ID is configured in cordis.patch.yml, never learned from the first visitor. The bot must have private topic mode enabled in BotFather; send /start to it before it can message you. An existing webhook is not deleted automatically. Only one poller may use the bot token.

Secrets live in DSH credentials record `telegram-console/bot`. First installation consumes the exact sibling `.telegram-console-bootstrap` file (mode 0600), stores its token through credentials.modifyRecord and deletes the handoff only after acknowledgement. Do not package or commit that handoff. Rotate the token via BotFather if its appearance in conversation history is unacceptable. No token is in this package.

Runtime state is in `.runtime-status.json` (no credentials). It reports connecting/running/degraded, bot identity and last error. Connection initialization retries once per minute. Telegram delivery metadata (topic/card/run/widget message IDs and polling offset) lives in DSH storageDomain `telegram_console_delivery`; no DSH session database or model preference is maintained by the bot.

## Implemented and tested

Live session listing and passive metadata reads; native prompt admission with stable Telegram request IDs, queue and stop; topic creation/rename and missing-topic recreation; pinned controls; write-through model selection; native animated ephemeral drafts with a durable Stop placeholder, then answer-only final messages (no completion receipt), paced 800 ms streaming and four-second heartbeat; unsupported draft methods fall back to editing the placeholder; owner-bound, expiring opaque callbacks; allow-once/deny approval answerer; durable artifact attachment reads; coalesced successful native write/edit tool outcomes; resource compiler and serialized send-before-delete widget replacement with compiled hash deduplication.

## Structure and runtime identity

`console.js` owns command/callback routing; `console-picker.js` owns catalog interactions; `console-delivery.js` owns run/draft/log delivery; `console-render.js` contains pure renderers. `run-projection.js` derives the ordered tool log from committed DSH events. `widget-pipeline.js` owns widget publication independently. `runtime-lifecycle.js` aborts and drains activation-owned asynchronous work on unload.

Runtime diagnostics include version, host PID and activation start time. `/version` reports the build actually handling Telegram updates. An installed package version alone does not establish the active module generation; restart DSH when a package update requires it.

## Topic lifecycle

Native Telegram New Topic and the first prompt in an unknown topic ask the owner to confirm a live DSH model suggestion before binding a new session. Pending first prompts are held in activation memory until confirmation (not durable across restarts). `/new` or New session in the session list offers the same model confirmation, then creates the topic and supplies a direct Open topic link; the Bot API cannot force navigation.

Close session asks for confirmation, deletes the Telegram topic and its messages, and marks only its delivery binding closed. It never deletes/stops the DSH session. A closed session remains in `/sessions` and reopens only on explicit selection. Existing DSH work can continue without a Telegram view.

## Turn files

Final response controls include successfully touched filenames with added/removed/edited icons. Paths in tool summaries are workspace-relative monospace; callbacks retain canonical source identity. Downloads are limited to files recorded for that turn and 10 MiB, with provider-level workspace containment checks. Removed-file downloads require a complete captured pre-deletion version in the authoritative log; otherwise an explicit unavailable message is returned. The file list reflects supported native mutation tools and live workspace-change metadata, not an unrestricted filesystem watcher.

## Chat UX

- Every tool call in the turn is retained in an ordered durable log, with running/completed/failed/cancelled states and expandable bounded result previews. Large logs span multiple Telegram messages without dropping earlier calls. Argument/result previews are bounded; the canonical full data remains in DSH.
- Queued-message receipts offer Steer now (owner-only), promoting the exact DSH queue item matched by its original request ID; already-consumed items report that state rather than duplicate the prompt.
- Delivery caches unchanged log pages, avoids native-draft typing round trips, bounds heartbeat work, and migrates legacy controls only once per activation. Telegram pacing and 429 cooldowns remain enforced.
- The provider/model picker stays in the same message through navigation and selection. A ✓ marks the provider/model confirmed by DSH; failures leave the previous choice checked and show an inline error, never a new acknowledgement message.
- Each committed normal assistant message is published immediately as durable formatted chat output, including messages before tool calls. Completed messages are never overwritten by later steps. Stopping publishes the currently streamed partial text; reasoning chunks are excluded. Delivery IDs and hashes deduplicate subsequent events/finals. Cosmetic log/control failures do not block output persistence.
- Answers are the message, not a debug run log. Successful finals have no status header, step/tool counts, elapsed counter, or separate completion receipt.
- Native drafts use a stable draft ID so Telegram clients can animate incoming text. A minimal durable placeholder provides Stop immediately; it is removed only after the final answer is safely sent. Clients or bots without draft support use paced edits instead. Heartbeats renew the ephemeral preview during long reasoning.
- Run controls move to the latest response, clearing old inline keyboards. Stop is absent when idle; pending approval decisions retain their own owner-only buttons until settled.
- The pinned card is a compact identity/status summary; metadata is formatted for people. Details are opt-in and expandable. /status explicitly reads current DSH state; there is no ambiguous Refresh button.
- /sessions links directly into visible sessions’ topics. Listing a visible page may create a topic for a session not opened in Telegram before, without creating any new DSH session.

## Explicit limitations versus concept

- DSH currently applies model changes at the **next step boundary**, potentially within the same turn, not strictly the next turn. Native behavior is preserved, not emulated in bot state. Native selection also saves the DSH default in the background.
- Approval API exposes Allow once/Deny, not per-kind Always allow, commands/paths or a durable denial-reason field. Optional reasons remain Telegram-only. A pending approval claimed by this adapter is answered in Telegram; it is not raced against Desktop approvals.
- Widget trigger covers successful `write`, `edit`, `write_file`, `edit_file`, and path-shaped `apply_patch` tool results. Shell writes/external editors and compound patches are not universal file-write events and are not tracked. Rapid writes coalesce for 200 ms, not necessarily all writes across a whole turn.
- Plan approval/revision and rich subagent trace rows are not implemented; normal agent plan text remains visible. Details is bounded to recent history. /files uploads up to ten durable file attachment blocks, each at most 10 MiB; arbitrary links in final text are not auto-uploaded.
- Model picker is paginated, not a searchable dropdown. Live cards refresh on committed title/model/directory/turn changes; expired controls recover on tap or /status. No offline server can update Telegram while the Host process itself is down.
- Compiler fails on unsupported import maps, unresolved dynamic/bare imports, complex CSS import qualifiers, iframe/object/embed/base/srcdoc. Required JS/CSS is never silently dropped for size; fonts then largest images are optional. Runtime JS networking detection is conservative warning-only, not full JavaScript analysis. Telegram's sandbox remains the execution boundary.
- Widget assets use the local Host filesystem, confined to the real session root. Remote filesystem backends need a provider-based compiler adapter.

## Verification

Run `npm test`. Offline tests validate security guards, resource transforms, deterministic budgets/hash, replacement and failure semantics, authorization/callback binding, topic controls, model rejection and run idempotency. These do not prove Telegram client rendering or a real agent round-trip. See the final delivery report for live activation/network results.

Artwork is an original SVG authored for this plugin (MIT-licensed with package source).
