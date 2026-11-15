# Telegram Remote: execution isolation proposal

## Current facts

The bot is an async loop inside the DSH Host process. It does not have its own Node process. Normal awaited network/model calls yield the event loop; an agent being active does not inherently block Telegram. Synchronous work (projection folds, rendering/hashing, JSON serialization, widget transforms) and explicit queues can block or delay it.

There are also head-of-line queues that moving networking alone cannot fix:
- pollUpdates awaits handleUpdate for each incoming update before reading the next; slow UI/catalog work can delay incoming Stop/approval updates.
- session serial queues mix output delivery, picker actions, heartbeat and metadata work.
- completedOutput awaits sealing the preceding tool log before sending text; a slow log request can delay the answer.
- native drafts, edits and durable sends have Telegram-side limits. Isolation cannot bypass flood control.

## Recommendation: supervised child process, not an unmanaged daemon

A worker thread has an independent JS event loop and is a useful incremental stage, but still shares the host process lifetime and address space. For actual crash/GC/event-loop isolation, use a child process supervised by a small Host plugin. Do not set detached:true or unref it: that would recreate the orphan poller problem after uninstall/restart.

The child owns Telegram polling, rate-limit scheduling, message rendering, delivery metadata cache, callback routing and widget compilation. The Host owns DSH session truth, model changes, prompt admission, queue steering, and actual approval decisions. No Cordis Context/Agent/Session object crosses IPC.

## Boundary

Use versioned JSON IPC envelopes {version,id,type,payload}. Host publishes sequenced per-session output/tool/status changes; child requests bounded snapshots on startup/gaps. Parent answers explicit operations (list/create/metadata/selectModel/prompt/steer/stop). Approval requests carry unguessable decision IDs and cancellation; only allowlisted Telegram user actions can answer them. Never expose an approval-granting agent tool.

Resolve bot credentials through DSH credentials in the Host. Deliver the secret once over the private IPC pipe, never argv/environment/logs; child keeps it only in memory. Credential/admin changes revoke pending controls and restart or reconfigure the child. DSH-owned credential storage remains the only persistent secret source.

Delivery metadata stays in one store with exactly one writer. Persist delivery receipts before acknowledgement; retain source event cursors for replay. Unknown/ambiguous sends must not be replayed blindly (Telegram has no general send idempotency key).

## Lifecycle and backpressure

- Parent starts one child per bot, with a single-poller lease and child PID/build status.
- IPC disconnect or parent death makes child stop polling immediately and exit after bounded drain.
- Unload: revoke admission, cancel approvals, send shutdown, wait bounded interval, then terminate only the owned child.
- Supervise failures with exponential backoff, maximum restart budget and explicit offline status.
- Bound IPC queues; coalesce drafts/progress by session; never discard committed assistant outputs or unanswered approval lifecycle events. Fair scheduling between topics.
- Do not wait for rendering/network delivery before accepting native Stop updates. Separate inbound acknowledgement/admission from slow work.

## Order of implementation

1. Fix head-of-line queue boundaries and instrument event-to-send latency, pending queue length and 429 waits.
2. Extract a transport-independent DSH bridge protocol and contract-test fake IPC.
3. Move Telegram surface/runtime into supervised child process; leave state mutation in Host.
4. Test parent busy-loop, child crash, host restart/uninstall, duplicate updates, lost IPC, credential rotation and multiple active topics.

This is a proposal, not an implemented process split. User-visible branding is Telegram Remote; package id, credential record keys and delivery-domain names remain stable for upgrade compatibility.
