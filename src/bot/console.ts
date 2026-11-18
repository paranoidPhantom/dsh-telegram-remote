import {
  errorMessage,
  isRecord,
  messageResult,
  topicResult,
  topicBinding,
  controlsReceipt,
} from "./contracts.js";
import type {
  TopicContext,
  TopicBinding,
  BoundTopic,
  SessionMetadata,
  SessionId,
  RunView,
  ActiveRun,
  TelegramApiPort,
  ConsoleBridge,
  ConsoleStore,
  MessageOptions,
  InlineMarkup,
  InlineButton,
  ConsoleAction,
  StoredAction,
  NativePrompt,
  ApprovalRequest,
  ApprovalOutcome,
  PendingApproval,
  TelegramMessage,
  CallbackQuery,
  TelegramUpdate,
} from "./contracts.js";
import { randomBytes } from "node:crypto";
import { createTranslator } from "../i18n/bot-i18n.js";

import {
  TTL,
  cut,
  html,
  compactSession,
  missingTopic,
  missingMessage,
  notModified,
  gone,
} from "../rendering/console-render.js";
import { ConsoleQuestions } from "./console-questions.js";
import type { QuestionAnswer } from "../protocol/questions.js";
import { ConsolePicker } from "./console-picker.js";
import { ConsoleSessions } from "./console-sessions.js";
import { RunDelivery } from "../delivery/console-delivery.js";
import { formatApproval } from "../rendering/tool-format.js";
import { fileButtonName } from "../rendering/path-display.js";
import { topicModeError } from "../i18n/topic-mode.js";
import type { ToolNameRule } from "../rendering/tool-name.js";

/** Telegram-only delivery projection. No DSH session/model state is persisted.
 * Parent owns polling offsets and calls refresh/onRun for live bridge events.
 * Approval outcomes are returned to the caller; this class never calls resolveApproval.
 */
export class TelegramConsole {
  readonly translate: ReturnType<typeof createTranslator>;
  readonly questions: ConsoleQuestions;
  readonly picker: ConsolePicker;
  readonly sessionActions: ConsoleSessions;
  readonly delivery: RunDelivery;
  readonly api: TelegramApiPort;
  readonly bridge: ConsoleBridge;
  readonly store: ConsoleStore;
  readonly ownerId: number;
  readonly toolNameRules: readonly ToolNameRule[];
  readonly signal?: AbortSignal;
  username = "";
  runtimeVersion?: string;
  runtimePid?: number;
  runtimeIdentity?: {
    hostPid: number;
    childPid: number;
    build: string;
    generation: string;
  };
  readonly active = new Map<SessionId, ActiveRun>();
  draftsUnsupported = false;
  readonly actions = new Map<string, StoredAction>();
  readonly queues = new Map<string, Promise<unknown>>();
  readonly pending = new Set<PendingApproval>();
  readonly reasons = new Map<
    string,
    { expires: number; req: ApprovalRequest }
  >();
  readonly seen = new Set<string>();
  readonly clearedMarkup = new Set<string>();
  closed: boolean;
  readonly abort: () => void;
  constructor({
    api,
    bridge,
    store,
    ownerId = 0,
    signal,
    getLocale = () => "en",
    toolNameRules = [],
    onDeliveryWarning,
    submitQuestion,
  }: {
    api: TelegramApiPort;
    bridge: ConsoleBridge;
    store: ConsoleStore;
    ownerId?: number;
    signal?: AbortSignal;
    getLocale?: () => unknown;
    toolNameRules?: readonly ToolNameRule[];
    onDeliveryWarning?: import("./contracts.js").DeliveryPort["warning"];
    submitQuestion?(id: string, answer: QuestionAnswer): Promise<void>;
  }) {
    this.translate = createTranslator(getLocale);
    this.api = api;
    this.bridge = bridge;
    this.store = store;
    this.ownerId = Number(ownerId);
    this.toolNameRules = toolNameRules;
    this.signal = signal;
    this.closed = Boolean(signal?.aborted);

    // Children receive capability objects, not the routing/authorization facade.
    // Getters deliberately read live flags: native draft fallback can change
    // during a run, and shutdown must be observed after every queued admission.
    const owner = this;
    this.questions = new ConsoleQuestions({
      api,
      get t() {
        return owner.t;
      },
      submit:
        submitQuestion ??
        (async () => {
          throw new Error("Question submission unavailable");
        }),
    });
    const messages = {
      get t() {
        return owner.t;
      },
      send: this.send.bind(this),
      edit: this.edit.bind(this),
      latest: this.latest.bind(this),
      button: this.button.bind(this),
      serial: this.serial.bind(this),
    };
    this.picker = new ConsolePicker({
      ...messages,
      bridge,
      get draftsUnsupported() {
        return owner.draftsUnsupported;
      },
      running: this.running.bind(this),
      page: this.page.bind(this),
      navigation: this.navigation.bind(this),
    });
    this.sessionActions = new ConsoleSessions({
      ...messages,
      bridge,
      api,
      store,
      actions: this.actions,
      pending: this.pending,
      active: this.active,
      get closed() {
        return owner.closed;
      },
      get username() {
        return owner.username;
      },
      mapping: this.mapping.bind(this),
      bound: this.bound.bind(this),
      save: this.save.bind(this),
      card: this.card.bind(this),
      open: this.open.bind(this),
      providers: this.providers.bind(this),
      models: this.models.bind(this),
    });
    this.delivery = new RunDelivery({
      api,
      store,
      warning: onDeliveryWarning,
      get toolNameRules() {
        return owner.toolNameRules;
      },
      get t() {
        return owner.t;
      },
      get closed() {
        return owner.closed;
      },
      get draftsUnsupported() {
        return owner.draftsUnsupported;
      },
      set draftsUnsupported(value) {
        owner.draftsUnsupported = value;
      },
      active: this.active,
      clearedMarkup: this.clearedMarkup,
      serial: this.serial.bind(this),
      mapping: this.mapping.bind(this),
      save: this.save.bind(this),
      params: this.params.bind(this),
      controls: this.controls.bind(this),
      finalControls: this.finalControls.bind(this),
      clearMarkup: this.clearMarkup.bind(this),
      latest: this.latest.bind(this),
      edit: this.edit.bind(this),
      preview: this.preview.bind(this),
    });
    this.abort = () => {
      this.closed = true;
      this.actions.clear();
      this.sessionActions.clear();
      this.questions.close();
      this.active.clear();
      this.reasons.clear();
      for (const p of this.pending) p.finish("cancelled");
    };
    signal?.addEventListener("abort", this.abort, { once: true });
  }

  get t() {
    return this.translate;
  }

  close() {
    this.abort();
    this.signal?.removeEventListener("abort", this.abort);
  }

  serial<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(String(id)) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.queues.set(String(id), next);
    return next.finally(() => {
      if (this.queues.get(String(id)) === next) this.queues.delete(String(id));
    });
  }

  key(id: SessionId) {
    return `console:topic:${id}`;
  }
  async mapping(id: SessionId): Promise<TopicBinding | undefined> {
    return topicBinding(await this.store.get(this.key(id)));
  }
  async getTopic(id: SessionId) {
    const mapping = await this.mapping(id);
    return mapping && !mapping.deleted
      ? { chatId: mapping.chatId, threadId: mapping.threadId }
      : undefined;
  }
  async save(id: SessionId, value: TopicBinding) {
    await this.store.set(this.key(id), value);
  }
  async bound(chatId: number, threadId: number): Promise<BoundTopic | null> {
    if (!threadId) return null;
    for (const [key, stored] of await this.store.entries()) {
      if (!key.startsWith("console:topic:")) continue;
      const value = topicBinding(stored);
      if (
        key.startsWith("console:topic:") &&
        value &&
        !value.deleted &&
        Number(value.chatId) === Number(chatId) &&
        Number(value.threadId) === Number(threadId)
      ) {
        return { id: key.slice("console:topic:".length), ...value };
      }
    }
    return null;
  }

  context(message: TelegramMessage) {
    return {
      chatId: message.chat.id,
      threadId: message.message_thread_id || 0,
    };
  }
  params(ctx: TopicContext) {
    return {
      chat_id: ctx.chatId,
      ...(ctx.threadId ? { message_thread_id: ctx.threadId } : {}),
    };
  }
  async send(ctx: TopicContext, text: string, extra: MessageOptions = {}) {
    const sent = messageResult(
      await this.api.call("sendMessage", {
        ...this.params(ctx),
        text,
        disable_notification: true,
        ...extra,
      }),
    );
    await this.latest(ctx, sent.message_id);
    return sent;
  }
  async edit(
    ctx: TopicContext,
    messageId: number,
    text: string,
    reply_markup?: InlineMarkup,
    parse_mode?: "HTML",
  ) {
    if (reply_markup?.inline_keyboard?.flat().length)
      this.clearedMarkup.delete(`${ctx.chatId}:${messageId}`);
    try {
      return await this.api.call("editMessageText", {
        chat_id: ctx.chatId,
        message_id: messageId,
        text,
        ...(reply_markup ? { reply_markup } : {}),
        ...(parse_mode ? { parse_mode } : {}),
      });
    } catch (e) {
      if (!notModified(e)) throw e;
    }
  }

  button(text: string, ctx: TopicContext, action: ConsoleAction): InlineButton {
    const now = Date.now();
    for (const [key, value] of this.actions)
      if (value.expires < now) this.actions.delete(key);
    const token = randomBytes(12).toString("base64url");
    this.actions.set(token, {
      ...action,
      chatId: ctx.chatId,
      threadId: ctx.threadId || 0,
      expires: now + TTL,
    });
    const appearance: Pick<InlineButton, "style" | "icon_custom_emoji_id"> =
      action.type === "providers" && !action.picker
        ? { style: "primary", icon_custom_emoji_id: "5258466217273871977" }
        : action.type === "approve"
          ? { style: "success" }
          : action.type === "deny"
            ? { style: "danger" }
            : action.type === "close"
              ? { style: "danger", icon_custom_emoji_id: "5341570033405412393" }
              : action.type === "steer"
                ? { icon_custom_emoji_id: "5220197908342648622" }
                : action.type === "turn-file"
                  ? {
                      icon_custom_emoji_id: {
                        added: "5371101764676241385",
                        removed: "5370673711055653338",
                        edited: "5375052056551770853",
                      }[action.kind],
                    }
                  : {};
    return { text: cut(text, 60), callback_data: token, ...appearance };
  }
  controls(
    id: SessionId,
    ctx: TopicContext,
    running = this.active.has(id),
  ): InlineMarkup {
    return {
      inline_keyboard: [
        [
          ...(running && this.draftsUnsupported
            ? [this.button(this.t("stop"), ctx, { type: "stop", id })]
            : []),
          this.button(this.t("model"), ctx, { type: "providers", id, page: 0 }),
          this.button(this.t("endTopic"), ctx, { type: "close", id }),
        ],
      ],
    };
  }
  finalControls(id: SessionId, ctx: TopicContext, view: RunView) {
    const markup = this.controls(id, ctx, false);
    for (const file of view.touchedFiles || [])
      markup.inline_keyboard.push([
        this.button(fileButtonName(file.path), ctx, {
          type: "turn-file",
          id,
          turn: view.turn,
          path: file.path,
          kind: file.kind,
        }),
      ]);
    return markup;
  }
  async clearMarkup(ctx: TopicContext, messageId: number | undefined) {
    const key = `${ctx.chatId}:${messageId}`;
    if (
      !messageId ||
      this.clearedMarkup.has(key) ||
      this.questions.protects(messageId, ctx) ||
      [...this.pending].some((p) => !p.done && p.messageId === messageId)
    )
      return;
    try {
      await this.api.call("editMessageReplyMarkup", {
        chat_id: ctx.chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
    } catch (e) {
      if (!missingMessage(e) && !notModified(e)) throw e;
    }
    this.clearedMarkup.add(key);
  }
  async latest(ctx: TopicContext, messageId: number | undefined) {
    const bound = await this.bound(ctx.chatId, ctx.threadId);
    const key = bound
      ? this.key(bound.id)
      : `console:controls:${ctx.chatId}:${ctx.threadId || 0}`;
    const mapping = bound
      ? (await this.mapping(bound.id)) || bound
      : controlsReceipt(await this.store.get(key));
    const previousId = mapping.latestControlMessageId || mapping.cardId;
    if (previousId !== messageId) await this.clearMarkup(ctx, previousId);
    mapping.latestControlMessageId = messageId;
    await this.store.set(key, mapping);
    return mapping;
  }
  compact(id: SessionId, metadata?: SessionMetadata | null) {
    return compactSession(id, metadata, this.active.has(id), this.t);
  }
  async card(
    id: SessionId,
    mapping: TopicBinding,
    metadata?: SessionMetadata | null,
  ) {
    const diagnostics = metadata
      ? [
          metadata.cwd && this.t("directoryPath", { path: metadata.cwd }),
          await this.bridge.details(id),
        ]
          .filter(Boolean)
          .join("\n\n")
      : "";
    const escapedPreview = (value: string, budget: number) => {
      let text = "";
      for (const character of value.toWellFormed()) {
        const escaped = html(character);
        if (text.length + escaped.length > budget) return `${text}…`;
        text += escaped;
      }
      return text;
    };
    const text = `${escapedPreview(this.compact(id, metadata), 1000)}${diagnostics ? `\n\n<blockquote expandable>${escapedPreview(diagnostics, 2700)}</blockquote>` : ""}`;
    // Passive refreshes must never teleport controls back onto the pinned card.
    const owns =
      !mapping.latestControlMessageId ||
      mapping.latestControlMessageId === mapping.cardId;
    const markup =
      owns && metadata
        ? this.controls(
            id,
            mapping,
            Boolean(metadata.running || this.active.has(id)),
          )
        : { inline_keyboard: [] };
    if (mapping.cardId) {
      try {
        await this.edit(mapping, mapping.cardId, text, markup, "HTML");
        return;
      } catch (e) {
        if (!missingMessage(e)) throw e;
      }
    }
    const message = await this.send(mapping, text, {
      parse_mode: "HTML",
      reply_markup: markup,
    });
    Object.assign(mapping, await this.mapping(id), {
      cardId: message.message_id,
    });
    await this.save(id, mapping);
    if (owns) await this.latest(mapping, message.message_id);
    await this.api.call("pinChatMessage", {
      chat_id: mapping.chatId,
      message_id: mapping.cardId,
      disable_notification: true,
    });
  }
  async status(id: SessionId, ctx: TopicContext) {
    const metadata = await this.bridge.metadata(id);
    const sent = await this.send(ctx, this.compact(id, metadata), {
      reply_markup: this.controls(
        id,
        ctx,
        Boolean(metadata?.running || this.active.has(id)),
      ),
    });
    await this.latest(ctx, sent.message_id);
  }

  async refresh(id: SessionId) {
    return this.serial(id, async () => {
      const mapping = await this.mapping(id);
      if (!mapping || mapping.deleted || this.closed) return;
      let metadata;
      try {
        metadata = await this.bridge.metadata(id);
      } catch (e) {
        if (!gone(e)) {
          if (mapping.cardId)
            await this.edit(
              mapping,
              mapping.cardId,
              this.t("offline"),
              !mapping.latestControlMessageId ||
                mapping.latestControlMessageId === mapping.cardId
                ? this.controls(id, mapping)
                : { inline_keyboard: [] },
            );
          return;
        }
      }
      try {
        if (!metadata) {
          await this.api.call("editForumTopic", {
            chat_id: mapping.chatId,
            message_thread_id: mapping.threadId,
            name: this.t("sessionGoneTitle"),
          });
          await this.card(id, mapping, null);
          return;
        }
        const title = cut(metadata.title || id, 128);
        if (mapping.topicTitle !== title) {
          await this.api.call("editForumTopic", {
            chat_id: mapping.chatId,
            message_thread_id: mapping.threadId,
            name: title,
          });
          mapping.topicTitle = title;
          await this.save(id, mapping);
        }
        await this.card(id, mapping, metadata);
      } catch (e) {
        if (!missingTopic(e)) throw e;
        mapping.deleted = true;
        await this.save(id, mapping);
      }
    });
  }

  async open(
    id: SessionId,
    ctx: TopicContext,
  ): Promise<TopicBinding | undefined> {
    return this.serial(id, async () => {
      const metadata = await this.bridge.metadata(id);
      if (!metadata) {
        await this.send(ctx, this.t("sessionGoneSessions"));
        return;
      }
      let mapping = await this.mapping(id);
      const title = cut(metadata.title || id, 128);
      if (mapping && !mapping.deleted) {
        try {
          if (mapping.topicClosed) {
            await this.api.call("reopenForumTopic", {
              chat_id: mapping.chatId,
              message_thread_id: mapping.threadId,
            });
            mapping.topicClosed = false;
          }
          await this.api.call("editForumTopic", {
            chat_id: mapping.chatId,
            message_thread_id: mapping.threadId,
            name: title,
          });
        } catch (e) {
          if (!missingTopic(e)) throw e;
          mapping = undefined;
        }
      }
      if (!mapping || mapping.deleted) {
        const topic = await this.api.call("createForumTopic", {
          chat_id: ctx.chatId,
          name: title,
        });
        mapping = {
          chatId: ctx.chatId,
          threadId: topicResult(topic),
          topicTitle: title,
        };
        await this.save(id, mapping);
      }
      mapping.topicTitle = title;
      await this.save(id, mapping);
      await this.card(id, mapping, metadata);
      return mapping;
    });
  }

  page(...args: Parameters<ConsolePicker["page"]>) {
    return this.picker.page(...args);
  }
  navigation(...args: Parameters<ConsolePicker["navigation"]>) {
    return this.picker.navigation(...args);
  }
  sessions(...args: Parameters<ConsolePicker["sessions"]>) {
    return this.picker.sessions(...args);
  }
  providers(...args: Parameters<ConsolePicker["providers"]>) {
    return this.picker.providers(...args);
  }
  models(...args: Parameters<ConsolePicker["models"]>) {
    return this.picker.models(...args);
  }

  async callback(query: CallbackQuery): Promise<unknown> {
    const message = query.message;
    const ctx = message && this.context(message);
    const action = query.data ? this.actions.get(query.data) : undefined;
    const authorized =
      Number(query.from?.id) === this.ownerId &&
      message?.chat?.type === "private" &&
      Number(ctx?.chatId) === this.ownerId;
    if (
      !authorized ||
      !message ||
      !ctx ||
      (action &&
        (Number(action.chatId) !== Number(ctx.chatId) ||
          Number(action.threadId) !== Number(ctx.threadId)))
    ) {
      await this.api.call("answerCallbackQuery", {
        callback_query_id: query.id,
        text: this.t("unauthorized"),
        show_alert: true,
      });
      return;
    }
    if (query.data?.startsWith("q:")) {
      await this.api.call("answerCallbackQuery", {
        callback_query_id: query.id,
      });
      return this.questions.callback(query.data, ctx);
    }
    if (!action || action.expires <= Date.now()) {
      if (action) this.actions.delete(query.data || "");
      if (action && "pending" in action && "expires" in action.pending) {
        action.pending.expires = 0;
        await this.api.call("answerCallbackQuery", {
          callback_query_id: query.id,
          text: this.t("confirmationExpiredAlert"),
        });
        return this.edit(
          ctx,
          message.message_id,
          this.t("confirmationExpired"),
          { inline_keyboard: [] },
        );
      }
      await this.api.call("answerCallbackQuery", {
        callback_query_id: query.id,
        text: this.t("controlsExpired"),
      });
      const bound = await this.bound(ctx.chatId, ctx.threadId);
      if (bound)
        await this.providers(
          bound.id,
          ctx,
          0,
          message.message_id === bound.cardId ? undefined : message.message_id,
        );
      else await this.sessions(ctx, 0, message.message_id);
      return;
    }
    await this.api.call("answerCallbackQuery", { callback_query_id: query.id });
    switch (action.type) {
      case "new":
        return this.requestNew(ctx, message.message_id);
      case "new-workspaces":
      case "new-workspace":
      case "new-providers":
      case "new-models":
      case "new-select":
        return this.sessionActions.pick(action, ctx, message.message_id);
      case "new-confirm":
        return this.sessionActions.confirm(
          action.pending,
          ctx,
          message.message_id,
        );
      case "new-cancel":
        return this.sessionActions.confirm(
          action.pending,
          ctx,
          message.message_id,
          true,
        );
      case "close":
        return this.sessionActions.requestClose(action.id, ctx);
      case "close-confirm":
        return this.sessionActions.confirmClose(action);
      case "close-cancel":
        return this.edit(
          ctx,
          message.message_id,
          this.t("topicKept"),
          this.controls(action.id, ctx),
        );
      case "turn-file": {
        const file = await this.bridge.fileForTurn(
          action.id,
          action.turn,
          action.path,
        );
        return this.api.document({
          chatId: ctx.chatId,
          threadId: ctx.threadId,
          name: file.name,
          content: file.content,
          caption: file.name,
        });
      }
      case "steer": {
        this.actions.delete(query.data || "");
        const result = await this.bridge.steerQueued(
          action.id,
          action.requestId,
        );
        return this.edit(
          ctx,
          message.message_id,
          result.accepted
            ? this.t("steeringNow")
            : result.reason || this.t("noLongerQueued"),
          { inline_keyboard: [] },
        );
      }
      case "sessions":
        return this.sessions(ctx, action.page, message.message_id);
      case "open": {
        const mapping = await this.open(action.id, ctx);
        if (mapping && this.username)
          return this.edit(ctx, message.message_id, this.t("topicReady"), {
            inline_keyboard: [
              [
                {
                  text: this.t("openTopic"),
                  url: `https://t.me/${this.username.replace(/^@/, "")}/${mapping.threadId}`,
                },
              ],
            ],
          });
        return;
      }
      case "refresh":
        return this.status(action.id, ctx);
      case "providers":
        return this.providers(
          action.id,
          ctx,
          action.page,
          action.picker ? message.message_id : undefined,
        );
      case "models":
        return this.models(
          action.id,
          ctx,
          action.provider,
          action.page,
          message.message_id,
        );
      case "stop":
        if (await this.running(action.id)) return this.bridge.stop(action.id);
        return;
      case "select": {
        this.actions.delete(query.data || "");
        try {
          return await this.picker.select(action, ctx, message.message_id);
        } catch (error) {
          // Selection never creates an acknowledgement/error message, even if
          // catalog refresh fails. Keep the existing picker and its checkmark.
          // A transport outage may also prevent editing; /status remains usable.
          return;
        }
      }
      case "approve":
      case "deny": {
        const pending = action.pending;
        if (pending.done) return;
        if (action.type === "approve") return pending.finish("allowed-once");
        // Reject immediately; an optional reason cannot strand a DSH approval.
        pending.finish("rejected");
        const reply = await this.send(ctx, this.t("deniedReason"), {
          reply_markup: { force_reply: true, selective: true },
        });
        this.reasons.set(`${ctx.chatId}:${ctx.threadId}:${reply.message_id}`, {
          expires: Date.now() + TTL,
          req: pending.req,
        });
        return;
      }
    }
  }

  requestNew(...args: Parameters<ConsoleSessions["requestNew"]>) {
    return this.sessionActions.requestNew(...args);
  }
  bindNativeTopic(ctx: TopicContext, prompt?: NativePrompt) {
    return this.sessionActions.requestNew(ctx, undefined, true, prompt);
  }

  async requireTopics(ctx: TopicContext) {
    const me = await this.api.call("getMe");
    if (isRecord(me) && me.has_topics_enabled === false) {
      await this.send(ctx, this.t("topicModeHelp"));
      return false;
    }
    return true;
  }
  async handleUpdate(update: TelegramUpdate): Promise<unknown> {
    if (this.closed) return;
    if (update.callback_query) {
      try {
        return await this.callback(update.callback_query);
      } catch (e) {
        const m = update.callback_query.message;
        if (
          Number(update.callback_query.from?.id) === this.ownerId &&
          m &&
          Number(m.chat.id) === this.ownerId
        )
          return this.send(
            this.context(m),
            this.t("warning", {
              error: topicModeError(e)
                ? this.t("topicModeHelp")
                : cut(errorMessage(e), 500),
            }),
            { disable_notification: false },
          );
        return;
      }
    }
    if (update.stopped_message_generation) {
      const stopped = update.stopped_message_generation;
      if (
        Number(stopped.chat?.id) !== this.ownerId ||
        stopped.chat?.type !== "private"
      )
        return;
      const bound = await this.bound(
        stopped.chat.id,
        stopped.message_thread_id || 0,
      );
      const run = bound && this.active.get(bound.id);
      if (bound && run && Number(stopped.draft_id) === run.draftId)
        await this.bridge.stop(bound.id);
      return;
    }
    const message = update.message;
    if (
      !message ||
      Number(message.from?.id) !== this.ownerId ||
      message.chat?.type !== "private" ||
      Number(message.chat.id) !== this.ownerId
    )
      return;
    const ctx = this.context(message);
    const requestId = `telegram:${ctx.chatId}:${message.message_id}`;
    if (this.seen.has(requestId)) return;
    this.seen.add(requestId);
    if (this.seen.size > 4096)
      this.seen.delete(this.seen.values().next().value || "");
    try {
      let bound = await this.bound(ctx.chatId, ctx.threadId);
      // Telegram may create a topic automatically for a command in General.
      // Topic creation alone is not intent to create a DSH session: leave the
      // topic intact and wait for a non-command prompt (or explicit /new).
      if (message.forum_topic_created && !message.text?.trim()) return;
      if (
        (message.forum_topic_deleted ||
          message.forum_topic_closed ||
          message.forum_topic_reopened) &&
        bound
      ) {
        const mapping = await this.mapping(bound.id);
        await this.save(bound.id, {
          ...bound,
          ...mapping,
          ...(message.forum_topic_deleted
            ? { deleted: true }
            : { topicClosed: Boolean(message.forum_topic_closed) }),
        });
        if (message.forum_topic_deleted) this.active.delete(bound.id);
        return;
      }
      const text = message.text?.trim();
      if (!text) return;
      if (await this.questions.reply(message)) return;
      const reasonKey = `${ctx.chatId}:${ctx.threadId}:${message.reply_to_message?.message_id}`;
      const reason = this.reasons.get(reasonKey);
      if (reason) {
        this.reasons.delete(reasonKey);
        if (reason.expires > Date.now()) {
          if (typeof reason.req.onReason === "function")
            await reason.req.onReason(cut(text, 1000));
          else await this.send(ctx, this.t("reasonNoted"));
        }
        return;
      }
      const command = text
        .match(/^\/(\w+)(?:@\w+)?(?:\s|$)/)?.[1]
        ?.toLowerCase();
      if (command === "version")
        return await this.send(
          ctx,
          this.t("version", {
            version: this.runtimeVersion || this.t("unknown"),
            pid: this.runtimePid || this.t("unknown"),
          }) +
            (this.runtimeIdentity
              ? `\n${this.t("versionRuntime", this.runtimeIdentity)}`
              : ""),
        );
      if (command === "sessions" || command === "start") {
        if (!(await this.requireTopics(ctx))) return;
        return await this.sessions(ctx);
      }
      if (command === "new") return await this.requestNew(ctx);
      if (command === "help") return await this.send(ctx, this.t("help"));
      if (!bound && ctx.threadId && !command) {
        await this.bindNativeTopic(ctx, { text, requestId });
        return;
      }
      if (!bound) return await this.send(ctx, this.t("openSessionHint"));
      const metadata = await this.bridge.metadata(bound.id);
      if (!metadata) {
        await this.refresh(bound.id);
        return await this.send(ctx, this.t("sessionGone"));
      }
      if (command === "status") return await this.status(bound.id, ctx);
      if (command === "stop") {
        if (await this.running(bound.id)) await this.bridge.stop(bound.id);
        return;
      }
      if (command === "files") {
        for (const file of await this.bridge.files(bound.id))
          await this.api.document({
            chatId: ctx.chatId,
            threadId: ctx.threadId,
            name: file.name,
            content: file.content,
            caption: file.name,
          });
        return;
      }
      if (command) return await this.send(ctx, this.t("unknownCommand"));
      await this.bridge.prompt(bound.id, text, requestId);
      if (metadata.running)
        await this.send(ctx, this.t("queued"), {
          reply_markup: {
            inline_keyboard: [
              [
                this.button(this.t("steerNow"), ctx, {
                  type: "steer",
                  id: bound.id,
                  requestId,
                }),
              ],
            ],
          },
        });
    } catch (e) {
      await this.send(
        ctx,
        this.t("warning", {
          error: topicModeError(e)
            ? this.t("topicModeHelp")
            : gone(e)
              ? this.t("goneRetry")
              : cut(errorMessage(e), 500),
        }),
        { disable_notification: false },
      );
    }
  }

  async running(id: SessionId) {
    if (this.active.has(id)) return true;
    return Boolean((await this.bridge.metadata(id))?.running);
  }
  refreshDrafts(...args: Parameters<RunDelivery["refreshDrafts"]>) {
    return this.delivery.refreshDrafts(...args);
  }
  preview(...args: Parameters<RunDelivery["preview"]>) {
    return this.delivery.preview(...args);
  }
  onRun(...args: Parameters<RunDelivery["onRun"]>) {
    return this.delivery.onRun(...args);
  }

  async approval(
    id: SessionId,
    req: ApprovalRequest = {},
  ): Promise<ApprovalOutcome> {
    if (this.closed) return "cancelled";
    const mapping = await this.mapping(id);
    if (!mapping || mapping.deleted) return "unavailable";
    if (req.signal?.aborted) return "cancelled";
    // Keep the reviewed operation visible after settlement, not just an opaque outcome.
    const requestHtml = formatApproval(req, this.t);
    const settledHtml = (outcome: ApprovalOutcome) =>
      `<b>${html(this.t("approvalOutcome", { outcome: this.t(`outcome.${outcome}`) }))}</b>${requestHtml.slice(requestHtml.indexOf("</b>") + 4)}`;
    let resolve: (outcome: ApprovalOutcome) => void = () => {
      throw new Error("Approval promise not initialized");
    };
    const result = new Promise<ApprovalOutcome>((r) => {
      resolve = r;
    });
    const pending: PendingApproval = {
      abort: () => {},
      req,
      sessionId: id,
      done: false,
      finish: (outcome) => {
        if (pending.done) return;
        pending.done = true;
        pending.outcome = outcome;
        clearTimeout(pending.timer);
        req.signal?.removeEventListener("abort", pending.abort);
        this.pending.delete(pending);
        for (const [token, action] of this.actions)
          if ("pending" in action && action.pending === pending)
            this.actions.delete(token);
        resolve(outcome);
        if (pending.messageId)
          void this.edit(
            mapping,
            pending.messageId,
            settledHtml(outcome),
            { inline_keyboard: [] },
            "HTML",
          ).catch(() => {});
      },
    };
    pending.abort = () => pending.finish("cancelled");
    req.signal?.addEventListener("abort", pending.abort, { once: true });
    this.pending.add(pending);
    pending.timer = setTimeout(
      () => pending.finish("unavailable"),
      Math.min(req.timeoutMs || TTL, TTL),
    );
    pending.timer.unref?.();
    try {
      await this.serial(id, async () => {
        if (pending.done || this.closed) {
          pending.finish("cancelled");
          return;
        }
        const message = await this.send(mapping, requestHtml, {
          parse_mode: "HTML",
          disable_notification: false,
          reply_markup: {
            inline_keyboard: [
              [
                this.button(this.t("allowOnce"), mapping, {
                  type: "approve",
                  pending,
                }),
                this.button(this.t("deny"), mapping, { type: "deny", pending }),
              ],
            ],
          },
        });
        pending.messageId = message.message_id;
        await this.latest(mapping, message.message_id);
        // Abort/timeout may win while Telegram is sending the card.
        if (pending.done)
          await this.edit(
            mapping,
            pending.messageId,
            settledHtml(pending.outcome || "unavailable"),
            { inline_keyboard: [] },
            "HTML",
          );
      });
    } catch {
      pending.finish("unavailable");
    }
    return result;
  }
}

export default TelegramConsole;
