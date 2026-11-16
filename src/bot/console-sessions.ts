import { errorMessage, messageResult, topicBinding } from "./contracts.js";
import type {
  TopicContext,
  TopicBinding,
  SessionId,
  CloseAction,
  NativePrompt,
  PendingInitiation,
  PendingPickerAction,
  SessionActionsPort,
} from "./contracts.js";
import { PAGE, TTL, cut } from "../rendering/console-render.js";
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
          c.button(c.t("workspace"), ctx, {
            type: "new-workspaces",
            pending,
            page: 0,
          }),
        ],
        [
          c.button(c.t("model"), ctx, {
            type: "new-providers",
            pending,
            page: 0,
          }),
        ],
        [
          c.button(c.t("confirmNew"), ctx, { type: "new-confirm", pending }),
          c.button(c.t("cancel"), ctx, { type: "new-cancel", pending }),
        ],
      ];
      const text = c.t("createSession", {
        provider: model.provider,
        model: model.model,
        effort: model.reasoningEffort ? ` · ${model.reasoningEffort}` : "",
        workspace: c.t("workspaceDefault"),
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
  async pick(
    action: PendingPickerAction,
    ctx: TopicContext,
    messageId: number,
  ) {
    const c = this.console;
    const pending = action.pending;
    return c.serial(pending.key, async () => {
      if (!this.valid(pending, ctx)) return;
      if (action.type === "new-workspaces" || action.type === "new-workspace") {
        const workspaces = await c.bridge.workspaces();
        let notice = "";
        if (action.type === "new-workspace") {
          const selected = workspaces.find((w) => w.id === action.workspaceId);
          if (action.workspaceId === undefined) pending.workspace = undefined;
          else if (selected) pending.workspace = structuredClone(selected);
          else notice = c.t("workspaceUnavailable");
        }
        const page = Math.max(
          0,
          Math.min(
            action.page,
            Math.max(0, Math.ceil(workspaces.length / PAGE) - 1),
          ),
        );
        const rows = workspaces
          .slice(page * PAGE, (page + 1) * PAGE)
          .map((w) => [
            c.button(
              `${pending.workspace?.id === w.id ? "✓ " : ""}${w.title} · ${w.path}`,
              ctx,
              { type: "new-workspace", pending, workspaceId: w.id, page },
            ),
          ]);
        rows.unshift([
          c.button(
            `${pending.workspace ? "" : "✓ "}${c.t("workspaceDefault")}`,
            ctx,
            { type: "new-workspace", pending, page },
          ),
        ]);
        const nav = [];
        if (page > 0)
          nav.push(
            c.button(c.t("previous"), ctx, {
              type: "new-workspaces",
              pending,
              page: page - 1,
            }),
          );
        if ((page + 1) * PAGE < workspaces.length)
          nav.push(
            c.button(c.t("next"), ctx, {
              type: "new-workspaces",
              pending,
              page: page + 1,
            }),
          );
        if (nav.length) rows.push(nav);
        rows.push([
          c.button(c.t("model"), ctx, {
            type: "new-providers",
            pending,
            page: 0,
          }),
        ]);
        rows.push([
          c.button(c.t("confirmNew"), ctx, { type: "new-confirm", pending }),
          c.button(c.t("cancel"), ctx, { type: "new-cancel", pending }),
        ]);
        return c.edit(
          ctx,
          messageId,
          c.t("createSession", {
            provider: pending.model.provider,
            model: pending.model.model,
            effort: pending.model.reasoningEffort
              ? ` · ${pending.model.reasoningEffort}`
              : "",
            workspace: pending.workspace
              ? `${pending.workspace.title} · ${pending.workspace.path}`
              : c.t("workspaceDefault"),
            hint: c.t(pending.native ? "nativeNewHint" : "newHint"),
          }) + `\n\n${c.t("chooseWorkspace")}${notice ? `\n${notice}` : ""}`,
          { inline_keyboard: rows },
        );
      }
      if (action.type === "new-providers")
        return c.providers(pending, ctx, action.page, messageId);
      if (action.type === "new-select") {
        const models = await c.bridge.models();
        if (
          !models.some(
            (m) => m.provider === action.provider && m.id === action.model,
          )
        )
          return c.models(
            pending,
            ctx,
            action.provider,
            action.page || 0,
            messageId,
            c.t("modelUnchanged", { error: c.t("selectionUnconfirmed") }),
          );
        if (action.effortSelection) {
          const model = models.find(
            (m) => m.provider === action.provider && m.id === action.model,
          );
          if (
            !model?.reasoning?.efforts.length ||
            (action.reasoningEffort !== undefined &&
              !model.reasoning.efforts.some(
                (e) => e.id === action.reasoningEffort,
              ))
          )
            return c.models(
              pending,
              ctx,
              action.provider,
              action.page || 0,
              messageId,
              c.t("modelUnchanged", { error: c.t("selectionUnconfirmed") }),
            );
          pending.model = {
            provider: action.provider,
            model: action.model,
            ...(action.reasoningEffort !== undefined
              ? { reasoningEffort: action.reasoningEffort }
              : {}),
          };
        }
        if (
          pending.model.provider !== action.provider ||
          pending.model.model !== action.model
        )
          pending.model = { provider: action.provider, model: action.model };
      }
      return c.models(
        pending,
        ctx,
        action.provider,
        action.page || 0,
        messageId,
      );
    });
  }
  valid(pending: PendingInitiation, ctx: TopicContext) {
    return (
      !this.console.closed &&
      this.initiations.get(pending.key) === pending &&
      !pending.done &&
      pending.expires > Date.now() &&
      pending.ctx.chatId === ctx.chatId &&
      pending.ctx.threadId === ctx.threadId
    );
  }
  async confirm(
    pending: PendingInitiation,
    ctx: TopicContext,
    messageId: number,
    cancel = false,
  ) {
    const c = this.console;
    return c.serial(pending.key, async () => {
      if (!this.valid(pending, ctx)) return;
      if (cancel && pending.native) {
        // Do not delete a topic that has acquired a DSH binding meanwhile.
        if (await c.bound(ctx.chatId, ctx.threadId)) return;
        // Retain the controls if Telegram rejects deletion. No DSH session exists.
        await c.api.call("deleteForumTopic", {
          chat_id: ctx.chatId,
          message_thread_id: ctx.threadId,
        });
        await c.store.set(
          `console:topic:rejected:${ctx.chatId}:${ctx.threadId}`,
          { ...ctx, deleted: true, closed: true },
        );
      }
      pending.done = true;
      for (const [token, action] of c.actions)
        if ("pending" in action && action.pending === pending)
          c.actions.delete(token);
      if (cancel) {
        this.initiations.delete(pending.key);
        if (pending.native) return;
        return c.edit(ctx, messageId, c.t("creationCancelled"), {
          inline_keyboard: [],
        });
      }
      try {
        // Native topic already exists. Never create another topic or redirect it.
        if (pending.native && (await c.bound(ctx.chatId, ctx.threadId)))
          throw new Error(c.t("topicAlreadyBound"));
        if (
          pending.workspace &&
          !(await c.bridge.workspaces()).some(
            (w) => w.id === pending.workspace?.id,
          )
        )
          throw new Error(c.t("workspaceUnavailable"));
        const id = await c.bridge.create(pending.workspace?.id);
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
