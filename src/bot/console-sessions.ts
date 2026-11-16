import { errorMessage, messageResult, topicBinding } from "./contracts.js";
import type {
  TopicContext,
  TopicBinding,
  SessionId,
  CloseAction,
  NativePrompt,
  PendingInitiation,
  SessionActionsPort,
} from "./contracts.js";
import { TTL, cut } from "../rendering/console-render.js";
import { topicModeError } from "../i18n/topic-mode.js";

/** Session initiation snapshots live DSH selection; only explicit confirmation creates. */
export class ConsoleSessions {
  readonly initiations = new Map<string, PendingInitiation>();
  sequence = 0;
  constructor(readonly console: SessionActionsPort) {}
  clear() {
    this.initiations.clear();
  }
  topicKey(ctx: TopicContext) {
    return `native-topic:${ctx.chatId}:${ctx.threadId}`;
  }
  async requestNew(
    ctx: TopicContext,
    messageId?: number,
    native = false,
    prompt?: NativePrompt,
  ) {
    const c = this.console;
    const key = native
      ? this.topicKey(ctx)
      : `new:${ctx.chatId}:${ctx.threadId}:${++this.sequence}`;
    return c.serial(key, async () => {
      if (native) {
        const bound = await c.bound(ctx.chatId, ctx.threadId);
        if (bound) {
          if (prompt)
            await c.bridge.prompt(bound.id, prompt.text, prompt.requestId);
          return bound;
        }
        // Deleted bindings are never replaced implicitly by a late native event.
        for (const [name, stored] of await c.store.entries()) {
          if (!name.startsWith("console:topic:")) continue;
          const value = topicBinding(stored);
          if (
            name.startsWith("console:topic:") &&
            Number(value?.chatId) === Number(ctx.chatId) &&
            Number(value?.threadId) === Number(ctx.threadId)
          )
            return;
        }
      }
      let pending = this.initiations.get(key);
      if (
        pending &&
        prompt &&
        !pending.prompts.some((p) => p.requestId === prompt.requestId)
      )
        pending.prompts.push(prompt);
      if (pending && pending.expires > Date.now()) return;
      const source = await c.bound(ctx.chatId, ctx.threadId);
      const model = await c.bridge.newSessionSelection(source?.id);
      if (!model?.provider || !model?.model) throw new Error(c.t("noModel"));
      pending = {
        ctx: { ...ctx },
        model: structuredClone(model),
        native,
        prompts: pending?.prompts || (prompt ? [prompt] : []),
        expires: Date.now() + TTL,
        key,
      };
      this.initiations.set(key, pending);
      const rows = [
        [
          c.button(c.t("confirmNew"), ctx, { type: "new-confirm", pending }),
          c.button(c.t("cancel"), ctx, { type: "new-cancel", pending }),
        ],
      ];
      const text = c.t("createSession", {
        provider: model.provider,
        model: model.model,
        effort: model.reasoningEffort ? ` · ${model.reasoningEffort}` : "",
        hint: c.t(native ? "nativeNewHint" : "newHint"),
      });
      try {
        const sent = messageId
          ? await c.edit(ctx, messageId, text, { inline_keyboard: rows })
          : await c.send(ctx, text, {
              reply_markup: { inline_keyboard: rows },
            });
        pending.messageId = messageId || messageResult(sent).message_id;
        await c.latest(ctx, pending.messageId);
      } catch (error) {
        this.initiations.delete(key);
        throw error;
      }
    });
  }
  async confirm(
    pending: PendingInitiation,
    ctx: TopicContext,
    messageId: number,
    cancel = false,
  ) {
    const c = this.console;
    return c.serial(pending.key, async () => {
      if (
        c.closed ||
        this.initiations.get(pending.key) !== pending ||
        pending.done ||
        pending.expires <= Date.now()
      )
        return;
      pending.done = true;
      for (const [token, action] of c.actions)
        if ("pending" in action && action.pending === pending)
          c.actions.delete(token);
      if (cancel) {
        this.initiations.delete(pending.key);
        return c.edit(ctx, messageId, c.t("creationCancelled"), {
          inline_keyboard: [],
        });
      }
      try {
        // Native topic already exists. Never create another topic or redirect it.
        if (pending.native && (await c.bound(ctx.chatId, ctx.threadId)))
          throw new Error(c.t("topicAlreadyBound"));
        const id = await c.bridge.create();
        const ack = await c.bridge.selectModel(id, pending.model);
        if (
          !ack ||
          ack.ok === false ||
          ack.accepted === false ||
          ack.success === false ||
          ack.error
        )
          throw new Error(
            ack?.reason || ack?.error || c.t("modelUnacknowledged"),
          );
        if (c.closed) return;
        let mapping: TopicBinding | undefined;
        if (pending.native) {
          mapping = { chatId: ctx.chatId, threadId: ctx.threadId };
          await c.save(id, mapping);
          // Keep the confirmation as latest controls; pin a separate compact card.
          mapping.latestControlMessageId = messageId;
          await c.save(id, mapping);
          await c.card(id, mapping, await c.bridge.metadata(id));
        } else mapping = await c.open(id, ctx);
        if (!mapping) throw new Error(c.t("cannotOpenTopic"));
        const url = c.username
          ? `https://t.me/${c.username.replace(/^@/, "")}/${mapping.threadId}`
          : null;
        await c.edit(
          ctx,
          messageId,
          pending.native ? c.t("nativeReady") : c.t("newReady"),
          { inline_keyboard: url ? [[{ text: c.t("openSession"), url }]] : [] },
        );
        while (pending.prompts.length) {
          const prompt = pending.prompts[0];
          if (!prompt) break;
          await c.bridge.prompt(id, prompt.text, prompt.requestId);
          pending.prompts.shift();
        }
        this.initiations.delete(pending.key);
      } catch (error) {
        // Retain unsent native text in memory, but never replay a partially sent queue.
        pending.done = false;
        pending.expires = 0;
        await c.edit(
          ctx,
          messageId,
          topicModeError(error)
            ? c.t("topicModeHelp")
            : c.t("setupFailed", { error: cut(errorMessage(error), 350) }),
          { inline_keyboard: [] },
        );
      }
    });
  }
  async requestClose(id: SessionId, ctx: TopicContext, messageId?: number) {
    const c = this.console,
      mapping = await c.mapping(id);
    if (!mapping || mapping.deleted) return;
    const rows = [
      [
        c.button(c.t("deleteTopic"), ctx, {
          type: "close-confirm",
          id,
          targetThreadId: mapping.threadId,
        }),
        c.button(c.t("cancel"), ctx, { type: "close-cancel", id }),
      ],
    ];
    const text = c.t("closeConfirmation");
    return messageId
      ? c.edit(ctx, messageId, text, { inline_keyboard: rows })
      : c.send(ctx, text, { reply_markup: { inline_keyboard: rows } });
  }
  async confirmClose(action: CloseAction) {
    const c = this.console;
    return c.serial(action.id, async () => {
      const mapping = await c.mapping(action.id);
      if (
        !mapping ||
        mapping.deleted ||
        Number(mapping.threadId) !== Number(action.targetThreadId)
      )
        return;
      // Commit the tombstone only after Telegram acknowledges deletion.
      await c.api.call("deleteForumTopic", {
        chat_id: mapping.chatId,
        message_thread_id: mapping.threadId,
      });
      await c.save(action.id, { ...mapping, deleted: true, closed: true });
      c.active.delete(action.id);
      for (const [token, value] of c.actions)
        if ("id" in value && value.id === action.id) c.actions.delete(token);
      for (const pending of c.pending)
        if (pending.sessionId === action.id) pending.finish("unavailable");
    });
  }
}
