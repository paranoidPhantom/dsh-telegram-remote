import {
  errorMessage,
  messageResult,
  historicalReceipt,
  runReceipt,
} from "../bot/contracts.js";
import type {
  TopicContext,
  TopicBinding,
  SessionId,
  RunView,
  TurnId,
  RunReceipt,
  CommittedOutput,
  MessageOptions,
  TelegramEntity,
  DeliveryPort,
} from "../bot/contracts.js";
import { randomBytes, createHash } from "node:crypto";
import { TodoDelivery } from "./todo-delivery.js";

const textHash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
// Only authoritative numeric turn ordering proves a receipt is a predecessor.
// Opaque legacy keys remain eligible for toolbar cleanup, not supersession.
const priorTurn = (candidate: TurnId, current: TurnId): boolean => {
  const number = (turn: TurnId) =>
    typeof turn === "number" || /^\d+$/.test(turn) ? Number(turn) : NaN;
  const before = number(candidate);
  const now = number(current);
  return (
    Number.isSafeInteger(before) && Number.isSafeInteger(now) && before < now
  );
};
// Telegram requires fallback text inside a custom-emoji entity.
const EMPTY_MESSAGE_HTML =
  '<tg-emoji emoji-id="5294363352070367389">⏳</tg-emoji>';
const hasText = (text: unknown): text is string =>
  typeof text === "string" && Boolean(text.trim());
const logRows = (view: RunView, delivery: RunReceipt) =>
  delivery.logFormat === "activity-v1"
    ? (view.runLog ?? view.toolLog ?? [])
    : (view.toolLog ?? []);
const draftText = (view: RunView): string =>
  Object.hasOwn(view, "partialAnswer")
    ? view.partialAnswer || ""
    : view.answer || "";
import { answerParts } from "../rendering/answer-format.js";
import { richAnswerParts } from "../rendering/rich-answer.js";

// Plain text needs no rich structure. Markdown goes through the native rich
// parser rather than being flattened into legacy message entities.
const hasMarkdown = (text: string) =>
  /[*_`~|\[\]#$<>=!]|^\s*(?:[-+]\s|\d+[.)]\s|={3,}\s*$)/m.test(text);
const deliveryParts = (
  text: string,
  rich: boolean,
): {
  text: string;
  entities?: TelegramEntity[];
  rich_message?: { markdown: string };
}[] =>
  rich
    ? richAnswerParts(text).map((part) => ({ text: "", rich_message: part }))
    : answerParts(text);
import { relativePathText } from "../rendering/path-display.js";
import { displayToolName, matchToolName } from "../rendering/tool-name.js";
import {
  chunks,
  unsupportedDraft,
  missingTopic,
  toolLogPages,
} from "../rendering/console-render.js";

// Distinguish Telegram send failure from failure to persist an accepted ID.
// Persistence/authority failures must still fail closed, not become successful ACKs.
class SendFailure extends Error {
  constructor(readonly original: unknown) {
    super("Telegram send failed");
  }
}
const deliveryDisposition = (error: unknown): "uncertain" | "rejected" => {
  const fields =
    error && typeof error === "object"
      ? (error as { code?: unknown; errorCode?: unknown })
      : {};
  const code = Number(fields.code ?? fields.errorCode);
  return Number.isInteger(code) &&
    code >= 400 &&
    code < 500 &&
    code !== 408 &&
    code !== 429
    ? "rejected"
    : "uncertain";
};
const deliveryWarning = (delivery: RunReceipt | undefined) =>
  delivery?.quarantine || delivery?.outputs?.some((output) => output.quarantine)
    ? ("warning" as const)
    : undefined;

/** Serialized run delivery, Telegram draft lifecycle and durable message ids. */
export class RunDelivery {
  readonly todos: TodoDelivery;
  readonly pageFrames = new Map<string, string>();
  readonly activations = new Map<string, string>();
  readonly heartbeats = new Map<string, Promise<void>>();
  constructor(readonly console: DeliveryPort) {
    this.todos = new TodoDelivery(console);
  }
  async refreshDrafts() {
    await Promise.all(
      [...this.console.active].map(([id]) => {
        if (this.heartbeats.has(id)) return this.heartbeats.get(id);
        // Read the active view only when this queue slot runs. A queued heartbeat
        // must not replay an older frame after a newly admitted bridge update.
        const pending = this.console
          .serial(id, async () => {
            const run = this.console.active.get(id);
            if (!run || this.console.closed) return;
            const mapping = await this.console.mapping(id);
            if (!mapping || mapping.deleted) return;
            await this.preview(
              mapping,
              {
                id,
                draftId: run.draftId,
                chatId: mapping.chatId,
                threadId: mapping.threadId,
                ...runReceipt(
                  await this.console.store.get(
                    `console:run:${id}:${run.view.turn}`,
                  ),
                ),
              },
              run.view,
            );
          })
          .finally(() => {
            if (this.heartbeats.get(id) === pending) this.heartbeats.delete(id);
          });
        this.heartbeats.set(id, pending);
        return pending;
      }),
    );
  }
  pageKey(mapping: TopicContext, messageId: number | undefined) {
    return `${mapping.chatId}:${messageId}`;
  }
  // Only semantic control state belongs in a frame: opaque callback tokens are
  // intentionally regenerated only when a page actually needs delivery.
  frame(text: string, controls: readonly unknown[]) {
    return textHash(JSON.stringify([text, controls]));
  }
  async log(
    mapping: TopicBinding,
    delivery: RunReceipt,
    view: RunView,
    key: string,
  ) {
    const start = delivery.logStart || 0;
    const rows = logRows(view, delivery);
    const latest = rows.at(-1);
    const end =
      view.logEnd ??
      (view.final || draftText(view) || latest?.kind === "reasoning"
        ? rows.length
        : Math.max(start, rows.length - 1));
    const pages = toolLogPages(
      rows.slice(start, end),
      view.final,
      view.cwd,
      this.console.t,
      this.console.toolNameRules,
    );
    if (!pages.length) return;
    delivery.logMessageIds ||=
      !delivery.logStart && delivery.messageId && !delivery.answerPreview
        ? [delivery.messageId]
        : [];
    const current = await this.console.mapping(delivery.id);
    const owner = current?.latestControlMessageId;
    const lastId = delivery.logMessageIds.at(-1);
    const owns = !owner || owner === lastId || owner === delivery.messageId;
    for (const [i, page] of pages.entries()) {
      const controls = !view.final && owns && i === pages.length - 1;
      const signature = this.frame(page, [
        controls,
        controls && this.console.draftsUnsupported,
      ]);
      const messageId = delivery.logMessageIds[i];
      const cacheKey = this.pageKey(mapping, messageId);
      const cached = this.pageFrames.get(cacheKey);
      // latest() may have cleared a cached keyboard while another surface owned
      // the controls. Reclaiming it requires a fresh keyboard even with same text.
      const cleared = controls && this.console.clearedMarkup?.has(cacheKey);
      if (messageId && cached === signature && !cleared) continue;
      const markup = controls
        ? this.console.controls(delivery.id, mapping, true)
        : { inline_keyboard: [] };
      if (messageId) {
        await this.console.api
          .call("editMessageText", {
            chat_id: mapping.chatId,
            message_id: messageId,
            text: page,
            parse_mode: "HTML",
            reply_markup: markup,
          })
          .catch((error) => {
            if (!/not modified/i.test(errorMessage(error))) throw error;
          });
      } else {
        const sent = messageResult(
          await this.console.api.call("sendMessage", {
            ...this.console.params(mapping),
            text: page,
            disable_notification: true,
            parse_mode: "HTML",
            reply_markup: markup,
          }),
        );
        delivery.logMessageIds.push(sent.message_id);
        await this.console.store.set(key, delivery);
      }
      const deliveredKey = this.pageKey(mapping, delivery.logMessageIds[i]);
      this.pageFrames.set(deliveredKey, signature);
      if (controls) this.console.clearedMarkup?.delete(deliveredKey);
    }
    // Reflow may compact pages when a running row becomes a shorter result.
    // All rows above were delivered before removing surplus old pages.
    while (delivery.logMessageIds.length > pages.length) {
      const messageId = delivery.logMessageIds.at(-1);
      await this.console.api.call("deleteMessage", {
        chat_id: mapping.chatId,
        message_id: messageId,
      });
      delivery.logMessageIds.pop();
      this.pageFrames.delete(this.pageKey(mapping, messageId));
      await this.console.store.set(key, delivery);
    }
    // Logs are a separate durable surface. Native drafts contain only answers.
    if (!view.final && owns && owner !== delivery.logMessageIds.at(-1))
      await this.console.latest(mapping, delivery.logMessageIds.at(-1));
  }
  async preview(
    mapping: TopicBinding | undefined,
    delivery: RunReceipt,
    view: RunView,
  ) {
    if (!mapping || mapping.deleted || delivery.final || delivery.superseded)
      return;
    const latestTool =
      !draftText(view) &&
      logRows(view, delivery).length > (delivery.logStart || 0) &&
      logRows(view, delivery).at(-1)?.kind !== "reasoning"
        ? logRows(view, delivery).at(-1)
        : null;
    const summary = latestTool
      ? relativePathText(latestTool.summary || "", view.cwd)
      : "";
    const icon = matchToolName(latestTool?.name, this.console.toolNameRules);
    const prefix = latestTool
      ? `${icon.emoji} ${displayToolName(latestTool.name) || "Tool"}`
      : "";
    const previewText = latestTool
      ? `${prefix}${summary ? ` — ${summary}` : ""}`
      : draftText(view) || this.console.t("deepDiving");
    const formatted: { text: string; entities: TelegramEntity[] } = latestTool
      ? {
          text: previewText.slice(0, 4096),
          entities: summary
            ? [
                {
                  type: "code",
                  offset: prefix.length + 3,
                  length: Math.min(summary.length, 4096 - prefix.length - 3),
                },
              ]
            : [],
        }
      : (answerParts(previewText)[0] ?? { text: "", entities: [] });
    if (latestTool && icon.customEmojiId)
      formatted.entities.unshift({
        type: "custom_emoji",
        offset: 0,
        length: icon.emoji.length,
        custom_emoji_id: icon.customEmojiId,
      });
    if (!this.console.draftsUnsupported) {
      try {
        const rich = !latestTool && hasMarkdown(previewText);
        await this.console.api.call(
          rich ? "sendRichMessageDraft" : "sendMessageDraft",
          {
            ...this.console.params(mapping),
            draft_id: delivery.draftId,
            ...(rich
              ? { rich_message: richAnswerParts(previewText)[0] }
              : formatted),
            can_stop: true,
          },
        );
        // Sending the draft can clear chat actions; renew typing afterward.
        if (this.console.api.typing)
          void this.console.api
            .typing(this.console.params(mapping))
            .catch(() => {});
        return;
      } catch (e) {
        if (!unsupportedDraft(e)) throw e;
        this.console.draftsUnsupported = true;
      }
    }
    await this.console.api.call("sendChatAction", {
      ...this.console.params(mapping),
      action: "typing",
    });
    if (
      delivery.messageId &&
      delivery.logMessageIds?.includes(delivery.messageId)
    ) {
      // This fallback is answer-only and must not steal/clear log Stop controls.
      const sent = messageResult(
        await this.console.api.call("sendMessage", {
          ...this.console.params(mapping),
          text: EMPTY_MESSAGE_HTML,
          parse_mode: "HTML",
          disable_notification: true,
        }),
      );
      delivery.messageId = sent.message_id;
      delivery.answerPreview = true;
    }
    const current = await this.console.mapping(delivery.id);
    const empty = !draftText(view);
    const text = empty
      ? EMPTY_MESSAGE_HTML
      : (chunks(draftText(view))[0] ?? "");
    const controls = current?.latestControlMessageId === delivery.messageId;
    const key = this.pageKey(mapping, delivery.messageId);
    const signature = this.frame(text, [
      controls,
      controls && this.console.draftsUnsupported,
    ]);
    if (
      this.pageFrames.get(key) === signature &&
      !(controls && this.console.clearedMarkup?.has(key))
    )
      return;
    if (!delivery.messageId) return;
    const markup = controls
      ? this.console.controls(delivery.id, mapping, true)
      : { inline_keyboard: [] };
    if (!empty && hasMarkdown(draftText(view))) {
      await this.console.api.call("editMessageText", {
        chat_id: mapping.chatId,
        message_id: delivery.messageId,
        rich_message: richAnswerParts(draftText(view))[0],
        reply_markup: markup,
      });
    } else {
      await this.console.edit(
        mapping,
        delivery.messageId,
        text,
        markup,
        empty ? "HTML" : undefined,
      );
    }
    this.pageFrames.set(key, signature);
  }
  // Telegram accepted sends must be recorded before moving/clearing controls.
  async cosmetic(task: () => Promise<unknown>) {
    try {
      await task();
    } catch {
      this.warn("DELIVERY_INVALID", "delivery-cosmetic");
    }
  }
  private warn(
    code: "DELIVERY_UNCERTAIN" | "DELIVERY_REJECTED" | "DELIVERY_INVALID",
    operation: "deliver-output" | "deliver-view" | "delivery-cosmetic",
  ) {
    try {
      this.console.warning?.({ code, operation });
    } catch {
      /* Observer only. */
    }
  }
  async sendRecorded(
    mapping: TopicBinding,
    delivery: RunReceipt,
    key: string,
    text: string,
    extra: MessageOptions,
    ids: number[],
  ) {
    let sent;
    try {
      sent = messageResult(
        await this.console.api.call(
          extra.rich_message ? "sendRichMessage" : "sendMessage",
          {
            ...this.console.params(mapping),
            ...(extra.rich_message ? {} : { text }),
            disable_notification: true,
            ...extra,
          },
        ),
      );
    } catch (error) {
      throw new SendFailure(error);
    }
    ids.push(sent.message_id);
    await this.console.store.set(key, delivery);
    return sent;
  }
  async output(
    mapping: TopicBinding,
    delivery: RunReceipt,
    key: string,
    output: CommittedOutput,
    final: boolean,
    segmentEnd?: number,
  ) {
    delivery.outputs ||= [];
    let record = delivery.outputs.find((item) => item.id === output.id);
    if (record?.quarantine) return;
    if (record?.pending) {
      record.quarantine = "uncertain";
      await this.console.store.set(key, delivery);
      this.warn("DELIVERY_UNCERTAIN", "deliver-output");
      return;
    }
    if (record?.complete) return;
    if (!record) {
      record = {
        id: output.id,
        hash: textHash(output.text),
        ...(hasMarkdown(output.text) ? { format: "rich-v1" as const } : {}),
        messageIds: [],
        ...(segmentEnd === undefined ? {} : { segmentEnd }),
      };
      delivery.outputs.push(record);
    }
    let parts;
    try {
      // Never change chunk boundaries of an existing legacy receipt.
      parts = deliveryParts(output.text, record.format === "rich-v1");
    } catch {
      record.quarantine = "invalid";
      await this.console.store.set(key, delivery);
      this.warn("DELIVERY_INVALID", "deliver-output");
      return;
    }
    const deliveredParts = record.messageIds.length;
    for (const [i, part] of parts.entries()) {
      if (i < deliveredParts) continue;
      // An interrupted/ambiguous request must not be replayed by a heartbeat.
      record.pending = true;
      await this.console.store.set(key, delivery);
      try {
        await this.sendRecorded(
          mapping,
          delivery,
          key,
          part.text,
          {
            ...(part.rich_message
              ? { rich_message: part.rich_message }
              : { entities: part.entities }),
            disable_notification: i > 0,
            ...(i === parts.length - 1
              ? {
                  reply_markup: this.console.controls(
                    delivery.id,
                    mapping,
                    !final,
                  ),
                }
              : {}),
          },
          record.messageIds,
        );
      } catch (error) {
        if (!(error instanceof SendFailure) || this.console.closed) throw error;
        record.quarantine = deliveryDisposition(error.original);
        // Retain pending=true for uncertain sends; definitive rejection is known
        // not delivered. Neither is complete, and neither is blindly replayed.
        record.pending = record.quarantine === "uncertain";
        await this.console.store.set(key, delivery);
        this.warn(
          record.quarantine === "uncertain"
            ? "DELIVERY_UNCERTAIN"
            : "DELIVERY_REJECTED",
          "deliver-output",
        );
        return;
      }
      record.pending = false;
      await this.console.store.set(key, delivery);
    }
    record.complete = true;
    delivery.lastOutputHash = record.hash;
    await this.console.store.set(key, delivery);
    await this.cosmetic(() =>
      this.console.latest(mapping, record.messageIds.at(-1)),
    );
  }
  async completedOutput(
    mapping: TopicBinding,
    delivery: RunReceipt,
    key: string,
    output: CommittedOutput,
    view: RunView,
  ) {
    const known = delivery.outputs?.find((item) => item.id === output.id);
    const recordedEnd = known?.segmentEnd;
    const boundary =
      typeof recordedEnd === "number" && Number.isInteger(recordedEnd)
        ? recordedEnd
        : delivery.logFormat === "activity-v1" &&
            typeof output.logCount === "number" &&
            Number.isInteger(output.logCount)
          ? output.logCount
          : typeof output.toolCount === "number" &&
              Number.isInteger(output.toolCount)
            ? output.toolCount
            : known?.complete
              ? delivery.logStart || 0
              : logRows(view, delivery).length;
    if (known?.complete && !known.pending) {
      if ((delivery.logStart || 0) >= boundary) return;
      // The accepted output can outlive the following boundary checkpoint.
      // Repair only metadata: resealing would edit a log above published text.
    } else {
      // Seal this segment before publishing the text. Subsequent calls get new IDs.
      await this.cosmetic(() =>
        this.log(
          mapping,
          delivery,
          { ...view, logEnd: boundary, final: true },
          key,
        ),
      );
      await this.output(
        mapping,
        delivery,
        key,
        output,
        Boolean(view.final),
        boundary,
      );
    }
    delivery.sealedLogMessageIds = [
      ...new Set([
        ...(delivery.sealedLogMessageIds || []),
        ...(delivery.logMessageIds || []),
      ]),
    ];
    delivery.logStart = boundary;
    delivery.logMessageIds = [];
    await this.console.store.set(key, delivery);
  }
  async finishPreview(
    mapping: TopicBinding,
    delivery: RunReceipt,
    view: RunView,
  ) {
    // Retire only transient controls, never the durable answer toolbar.
    const lastOutput = delivery.outputs
      ?.filter((output) => output.complete)
      .at(-1)
      ?.messageIds?.at(-1);
    if (lastOutput) {
      await this.cosmetic(() =>
        this.console.api.call("editMessageReplyMarkup", {
          chat_id: mapping.chatId,
          message_id: lastOutput,
          reply_markup: this.console.finalControls(delivery.id, mapping, view),
        }),
      );
      await this.cosmetic(() => this.console.latest(mapping, lastOutput));
      this.console.clearedMarkup?.delete(this.pageKey(mapping, lastOutput));
    }
    if (delivery.messageId && delivery.messageId !== lastOutput)
      await this.cosmetic(() =>
        this.console.clearMarkup(mapping, delivery.messageId),
      );
    if (
      delivery.messageId &&
      !delivery.logMessageIds?.includes(delivery.messageId) &&
      !delivery.sealedLogMessageIds?.includes(delivery.messageId)
    ) {
      await this.cosmetic(() =>
        this.console.api.call("deleteMessage", {
          chat_id: mapping.chatId,
          message_id: delivery.messageId,
        }),
      );
    }
  }
  async onRun(
    id: SessionId,
    view: RunView,
    options: { replay?: boolean } = {},
  ) {
    if (this.console.closed) return;
    if (view.turn == null)
      throw new TypeError("onRun requires a stable view.turn");
    // Snapshot at admission, not after awaiting storage: a subsequent turn must
    // capture and retire its actual predecessor in queue order.
    view = structuredClone(view);
    return this.console.serial(id, async () => {
      let mapping = await this.console.mapping(id);
      if (!mapping || mapping.deleted || this.console.closed) return;
      await this.cosmetic(() => this.todos.onRun(id, mapping!, view));
      // The checklist receipt is stored on the mapping; retain it in subsequent
      // lifecycle saves, without making checklist failures gate normal output.
      mapping = await this.console.mapping(id);
      if (!mapping || mapping.deleted || this.console.closed) return;
      const key = `console:run:${id}:${view.turn}`;
      const stored = await this.console.store.get(key);
      let existing;
      try {
        existing = historicalReceipt(stored);
      } catch {
        // Keep malformed evidence untouched. A later turn must not be held by it.
        this.warn("DELIVERY_INVALID", "deliver-view");
        return "warning" as const;
      }
      if (existing?.final || existing?.superseded)
        return deliveryWarning(existing as RunReceipt);
      // Valid legacy rows may predate the required delivery context. Upgrade in
      // place without dropping accepted IDs or pending-send ambiguity markers.
      let delivery: RunReceipt | undefined = existing
        ? {
            ...existing,
            id,
            draftId: existing.draftId ?? (randomBytes(4).readUInt32BE(0) || 1),
            chatId: existing.chatId ?? mapping.chatId,
            threadId: existing.threadId ?? mapping.threadId,
          }
        : undefined;
      const previous = this.console.active.get(id);
      if (
        mapping.activeTurn != null &&
        priorTurn(mapping.activeTurn, view.turn) &&
        !previous
      ) {
        const priorStored = await this.console.store.get(
          `console:run:${id}:${mapping.activeTurn}`,
        );
        let prior;
        try {
          prior = historicalReceipt(priorStored);
        } catch {
          this.warn("DELIVERY_INVALID", "deliver-view");
        }
        if (prior && !prior.final)
          await this.console.store.set(
            `console:run:${id}:${mapping.activeTurn}`,
            { ...prior, superseded: true },
          );
      }
      const retired: (number | undefined)[] = [];
      if (!delivery) {
        // One migration sweep per topic activation; later turns only retire the
        // current owner. Never rescan all historical runs on every new turn.
        const activation = `${mapping.chatId}:${mapping.threadId || 0}`;
        if (this.activations.get(id) !== activation) {
          for (const [oldKey, stored] of await this.console.store.entries()) {
            if (!oldKey.startsWith(`console:run:${id}:`)) continue;
            const turn = oldKey.slice(`console:run:${id}:`.length);
            if (String(view.turn) === turn) continue;
            const isPrior = priorTurn(turn, view.turn);
            // Numeric current/future rows belong to replay, not migration. Old
            // opaque keys have no provable order: clear legacy controls only.
            if (!isPrior && /^\d+$/.test(turn)) continue;
            let old;
            try {
              old = historicalReceipt(stored);
            } catch {
              this.warn("DELIVERY_INVALID", "deliver-view");
              continue;
            }
            if (!old) continue;
            retired.push(
              old.messageId,
              ...(old.logMessageIds || []),
              ...(old.finalMessageIds || []),
              ...(old.outputs || []).flatMap((output) => output.messageIds),
            );
            if (isPrior && !old.final && !old.superseded)
              await this.console.store.set(oldKey, {
                ...old,
                superseded: true,
              });
          }
          this.activations.set(id, activation);
        } else if (previous && priorTurn(previous.view.turn, view.turn)) {
          const priorKey = `console:run:${id}:${previous.view.turn}`;
          const priorStored = await this.console.store.get(priorKey);
          let prior;
          try {
            prior = historicalReceipt(priorStored);
          } catch {
            this.warn("DELIVERY_INVALID", "deliver-view");
          }
          if (prior && !prior.final && !prior.superseded)
            await this.console.store.set(priorKey, {
              ...prior,
              superseded: true,
            });
        }
        if (previous && previous.view.turn !== view.turn)
          this.console.active.delete(id);
        retired.push(mapping.latestControlMessageId || mapping.cardId);
        delivery = {
          id,
          logFormat: "activity-v1",
          draftId: randomBytes(4).readUInt32BE(0) || 1,
          chatId: mapping.chatId,
          threadId: mapping.threadId,
        };

        mapping = {
          ...mapping,
          ...(await this.console.mapping(id)),
          activeTurn: view.turn,
        };
        await this.console.save(id, mapping);
        await this.console.store.set(key, delivery);
      }
      try {
        if (!view.toolLog?.length && previous?.view.turn === view.turn)
          view.toolLog = previous.view.toolLog;
        if (!view.runLog && previous?.view.turn === view.turn)
          view.runLog = previous.view.runLog;
        for (const output of view.outputs || []) {
          if (typeof output.id === "string" && hasText(output.text))
            await this.completedOutput(mapping, delivery, key, output, view);
        }
        if (!view.final && options.replay) {
          // Historical boundaries contain committed outputs, not live progress.
          // Never register them for heartbeat drafts or create a placeholder.
          // A later live snapshot resumes the ordinary native draft lifecycle.
          if (previous?.view.turn === view.turn) this.console.active.delete(id);
          await this.cosmetic(() =>
            this.log(
              mapping,
              delivery,
              { ...view, logEnd: logRows(view, delivery).length },
              key,
            ),
          );
          for (const messageId of new Set(retired))
            await this.cosmetic(() =>
              this.console.clearMarkup(mapping, messageId),
            );
          await this.console.store.set(key, delivery);
          return deliveryWarning(delivery);
        }
        if (!view.final) {
          this.console.active.set(id, { view, draftId: delivery.draftId });
          if (!delivery.messageId && !delivery.quarantine) {
            let sent;
            try {
              sent = messageResult(
                await this.console.api.call("sendMessage", {
                  ...this.console.params(mapping),
                  text: EMPTY_MESSAGE_HTML,
                  parse_mode: "HTML",
                  disable_notification: true,
                  reply_markup: this.console.controls(id, mapping, true),
                }),
              );
            } catch (error) {
              throw new SendFailure(error);
            }
            delivery.messageId = sent.message_id;
            await this.console.store.set(key, delivery);
            await this.cosmetic(() =>
              this.console.latest(mapping, sent.message_id),
            );
          }
          await this.cosmetic(() => this.log(mapping, delivery, view, key));
          for (const messageId of new Set(retired))
            await this.cosmetic(() =>
              this.console.clearMarkup(mapping, messageId),
            );
          const unsupported = this.console.draftsUnsupported;
          await this.cosmetic(() =>
            this.console.preview(mapping, delivery, view),
          );
          if (!unsupported && this.console.draftsUnsupported)
            await this.cosmetic(() => this.log(mapping, delivery, view, key));
          await this.console.store.set(key, delivery);
          return deliveryWarning(delivery);
        }
        // Committed messages are already durable. A stopped current attempt is
        // separate output, even when an earlier assistant message was delivered.
        const stopped = /stop|cancel|abort/i.test(view.status || "");
        const partial =
          stopped && hasText(view.partialAnswer) ? view.partialAnswer : "";
        if (partial && textHash(partial) !== delivery.lastOutputHash) {
          await this.output(
            mapping,
            delivery,
            key,
            { id: `partial:${view.partialId || view.turn}`, text: partial },
            true,
          );
        }
        const hasOutputs = (view.outputs || []).some((output) =>
          hasText(output.text),
        );
        if (hasOutputs || partial) {
          this.console.active.delete(id);
          delivery.final = true;
          await this.console.store.set(key, delivery);
          for (const messageId of new Set(retired))
            await this.cosmetic(() =>
              this.console.clearMarkup(mapping, messageId),
            );
          await this.cosmetic(() => this.log(mapping, delivery, view, key));
          await this.finishPreview(mapping, delivery, view);
          return deliveryWarning(delivery);
        }
        if (delivery.quarantine) {
          this.console.active.delete(id);
          return "warning" as const;
        }
        // Persist each sent chunk before proceeding: retries never resend an
        // already delivered answer prefix, and failure never deletes the preview.
        const finalText =
          view.answer ||
          (/fail|error/i.test(view.status || "")
            ? this.console.t("unableComplete")
            : /stop|cancel/i.test(view.status || "")
              ? this.console.t("stopped")
              : this.console.t("noAnswer"));
        if (delivery.finalMessageIds === undefined && hasMarkdown(finalText)) {
          delivery.finalFormat = "rich-v1";
          // Persist representation before any send; legacy partial receipts keep
          // their original entity chunks on recovery.
          await this.console.store.set(key, delivery);
        }
        const parts = deliveryParts(
          finalText,
          delivery.finalFormat === "rich-v1",
        );
        delivery.finalMessageIds ||= [];
        this.console.active.delete(id);

        if (
          this.console.draftsUnsupported &&
          delivery.messageId &&
          parts.length === 1 &&
          !delivery.finalMessageIds.length
        ) {
          await this.console.api.call("editMessageText", {
            chat_id: mapping.chatId,
            message_id: delivery.messageId,
            ...(parts[0]?.rich_message
              ? { rich_message: parts[0].rich_message }
              : parts[0]),
            reply_markup: this.console.finalControls(id, mapping, view),
          });
          await this.console.store.set(key, {
            ...delivery,
            final: true,
            finalMessageIds: [delivery.messageId],
          });
          await this.cosmetic(() =>
            this.console.latest(mapping, delivery.messageId),
          );
          for (const messageId of new Set(retired))
            await this.cosmetic(() =>
              this.console.clearMarkup(mapping, messageId),
            );
          await this.cosmetic(() => this.log(mapping, delivery, view, key));
          return;
        }
        const deliveredParts = delivery.finalMessageIds.length;
        for (const [i, part] of parts.entries()) {
          if (i < deliveredParts) continue;
          await this.sendRecorded(
            mapping,
            delivery,
            key,
            part.text,
            {
              ...(part.rich_message
                ? { rich_message: part.rich_message }
                : { entities: part.entities }),
              disable_notification: i > 0,
              ...(i === parts.length - 1
                ? {
                    reply_markup: this.console.finalControls(id, mapping, view),
                  }
                : {}),
            },
            delivery.finalMessageIds,
          );
        }
        await this.console.store.set(key, { ...delivery, final: true });
        await this.cosmetic(() =>
          this.console.latest(mapping, delivery.finalMessageIds?.at(-1)),
        );
        for (const messageId of new Set(retired))
          await this.cosmetic(() =>
            this.console.clearMarkup(mapping, messageId),
          );
        await this.cosmetic(() => this.log(mapping, delivery, view, key));
        if (
          delivery.messageId &&
          !delivery.logMessageIds?.includes(delivery.messageId) &&
          !delivery.sealedLogMessageIds?.includes(delivery.messageId)
        ) {
          try {
            await this.console.api.call("deleteMessage", {
              chat_id: mapping.chatId,
              message_id: delivery.messageId,
            });
          } catch {
            /* Final is safely delivered. Retain an inert preview if deletion fails. */
          }
        }
      } catch (e) {
        if (e instanceof SendFailure && !this.console.closed) {
          delivery.quarantine = deliveryDisposition(e.original);
          await this.console.store.set(key, delivery);
          this.warn(
            delivery.quarantine === "uncertain"
              ? "DELIVERY_UNCERTAIN"
              : "DELIVERY_REJECTED",
            "deliver-view",
          );
          this.console.active.delete(id);
          return "warning" as const;
        }
        if (!missingTopic(e)) throw e;
        await this.console.save(id, { ...mapping, deleted: true });
        this.console.active.delete(id);
      }
    });
  }
}
