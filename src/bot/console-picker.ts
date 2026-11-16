import { errorMessage, messageResult } from "./contracts.js";
import type {
  TopicContext,
  SessionMetadata,
  SessionId,
  ModelEntry,
  InlineButton,
  NavigationAction,
  SelectAction,
  PickerPort,
  PendingInitiation,
} from "./contracts.js";
import { PAGE, cut, label } from "../rendering/console-render.js";

/** Live catalog/session navigation; owns no DSH preferences. */
export class ConsolePicker {
  constructor(readonly console: PickerPort) {
    this.console = console;
  }
  get t() {
    return this.console.t;
  }
  async page(
    ctx: TopicContext,
    messageId: number | undefined,
    text: string,
    rows: InlineButton[][],
  ) {
    const reply_markup = { inline_keyboard: rows };
    const result = messageId
      ? await this.console.edit(ctx, messageId, text, reply_markup)
      : await this.console.send(ctx, text, { reply_markup });
    await this.console.latest(
      ctx,
      messageId || messageResult(result).message_id,
    );
    return result;
  }
  navigation(
    ctx: TopicContext,
    page: number,
    total: number,
    action: NavigationAction,
  ) {
    const rows = [];
    if (page > 0)
      rows.push(
        this.console.button(this.t("previous"), ctx, {
          ...action,
          page: page - 1,
        }),
      );
    if ((page + 1) * PAGE < total)
      rows.push(
        this.console.button(this.t("next"), ctx, { ...action, page: page + 1 }),
      );
    return rows.length ? [rows] : [];
  }
  async sessions(ctx: TopicContext, page = 0, messageId?: number) {
    const sessions = await this.console.bridge.list(); // Always live, including pagination.
    page = Math.min(
      Math.max(0, page),
      Math.max(0, Math.ceil(sessions.length / PAGE) - 1),
    );
    const rows = [];
    for (const session of sessions.slice(page * PAGE, (page + 1) * PAGE)) {
      const text = `${session.running ? "▶ " : ""}${session.title || session.id}${label(session.model) ? ` · ${label(session.model)}` : ""}`;
      rows.push([
        this.console.button(text, ctx, { type: "open", id: session.id }),
      ]);
    }
    rows.push([
      this.console.button(this.t("newSession"), ctx, { type: "new" }),
    ]);
    rows.push(
      ...this.console.navigation(ctx, page, sessions.length, {
        type: "sessions",
      }),
    );
    return this.console.page(
      ctx,
      messageId,
      sessions.length
        ? this.t("sessionsPage", { page: page + 1 })
        : this.t("noSessions"),
      rows,
    );
  }
  pendingText(pending: PendingInitiation) {
    return this.t("createSession", {
      provider: pending.model.provider,
      model: pending.model.model,
      effort: pending.model.reasoningEffort
        ? ` · ${pending.model.reasoningEffort}`
        : "",
      hint: this.t(pending.native ? "nativeNewHint" : "newHint"),
    });
  }
  pendingControls(pending: PendingInitiation, ctx: TopicContext) {
    return [
      this.console.button(this.t("confirmNew"), ctx, {
        type: "new-confirm",
        pending,
      }),
      this.console.button(this.t("cancel"), ctx, {
        type: "new-cancel",
        pending,
      }),
    ];
  }
  async providers(
    target: SessionId | PendingInitiation,
    ctx: TopicContext,
    page = 0,
    messageId?: number,
  ) {
    const models = await this.console.bridge.models();
    const selection =
      typeof target === "string"
        ? (await this.console.bridge.metadata(target))?.selection
        : target.model;
    const providers = [...new Set(models.map((m) => m.provider))];
    page = Math.max(
      0,
      Math.min(page, Math.max(0, Math.ceil(providers.length / PAGE) - 1)),
    );
    const rows = providers
      .slice(page * PAGE, (page + 1) * PAGE)
      .map((provider) => [
        this.console.button(
          `${selection?.provider === provider ? "✓ " : ""}${provider}`,
          ctx,
          typeof target === "string"
            ? { type: "models", id: target, provider, page: 0 }
            : { type: "new-models", pending: target, provider, page: 0 },
        ),
      ]);
    rows.push(
      ...this.console.navigation(
        ctx,
        page,
        providers.length,
        typeof target === "string"
          ? { type: "providers", id: target, picker: true }
          : { type: "new-providers", pending: target },
      ),
    );
    if (typeof target !== "string")
      rows.push(this.pendingControls(target, ctx));
    else if (
      this.console.draftsUnsupported &&
      (await this.console.running(target))
    )
      rows.push([
        this.console.button(this.t("stop"), ctx, { type: "stop", id: target }),
      ]);
    return this.console.page(
      ctx,
      messageId,
      typeof target === "string"
        ? this.t("chooseProvider")
        : `${this.pendingText(target)}\n\n${this.t("chooseProvider")}`,
      rows,
    );
  }
  async models(
    target: SessionId | PendingInitiation,
    ctx: TopicContext,
    provider: string,
    page = 0,
    messageId?: number,
    notice = "",
    metadata?: SessionMetadata | null,
  ) {
    if (typeof target === "string")
      metadata ??= await this.console.bridge.metadata(target);
    const selection =
      typeof target === "string" ? metadata?.selection : target.model;
    const models = (await this.console.bridge.models()).filter(
      (m) => m.provider === provider,
    );
    page = Math.max(
      0,
      Math.min(page, Math.max(0, Math.ceil(models.length / PAGE) - 1)),
    );
    const visible = models.slice(page * PAGE, (page + 1) * PAGE);
    const selected = (m: ModelEntry) =>
      selection?.provider === provider && selection?.model === m.id;
    const rows = visible.map((m) => [
      this.console.button(
        `${selected(m) ? "✓ " : ""}${m.name || m.id}`,
        ctx,
        typeof target === "string"
          ? { type: "select", id: target, provider, model: m.id, page }
          : {
              type: "new-select",
              pending: target,
              provider,
              model: m.id,
              page,
            },
      ),
    ]);
    rows.push(
      ...this.console.navigation(
        ctx,
        page,
        models.length,
        typeof target === "string"
          ? { type: "models", id: target, provider }
          : { type: "new-models", pending: target, provider },
      ),
    );
    rows.push([
      this.console.button(
        this.t("providers"),
        ctx,
        typeof target === "string"
          ? { type: "providers", id: target, page: 0, picker: true }
          : { type: "new-providers", pending: target, page: 0 },
      ),
      ...(typeof target === "string" &&
      this.console.draftsUnsupported &&
      (await this.console.running(target))
        ? [
            this.console.button(this.t("stop"), ctx, {
              type: "stop",
              id: target,
            }),
          ]
        : []),
    ]);
    if (typeof target !== "string")
      rows.push(this.pendingControls(target, ctx));
    return this.console.page(
      ctx,
      messageId,
      cut(
        `${typeof target === "string" ? "" : `${this.pendingText(target)}\n\n`}${this.t("modelsPage", { provider, page: page + 1 })}${notice ? `\n${notice}` : ""}\n${visible.map((m) => `${selected(m) ? "✓ " : ""}${m.name || m.id}${m.description ? ` — ${m.description}` : ""}`).join("\n")}`,
      ),
      rows,
    );
  }

  select(action: SelectAction, ctx: TopicContext, messageId: number) {
    // The callback spinner is already answered by the router. Never recursively
    // enter the session queue (refresh uses it too).
    return this.console.serial(action.id, async () => {
      const prior = await this.console.bridge.metadata(action.id);
      let metadata = prior,
        notice = "";
      try {
        const ack = await this.console.bridge.selectModel(action.id, {
          provider: action.provider,
          model: action.model,
        });
        if (
          !ack ||
          ack.ok === false ||
          ack.accepted === false ||
          ack.success === false ||
          ack.error
        )
          throw new Error(
            ack?.error || ack?.reason || this.t("selectionUnacknowledged"),
          );
        metadata = await this.console.bridge.metadata(action.id);
        if (
          metadata?.selection?.provider !== action.provider ||
          metadata?.selection?.model !== action.model
        ) {
          metadata = prior;
          throw new Error(this.t("selectionUnconfirmed"));
        }
        notice = ack.appliesNextTurn
          ? this.t("nextTurn")
          : ack.running || ack.deferred
            ? this.t("nextStep")
            : "";
      } catch (error) {
        metadata = prior;
        notice = this.t("modelUnchanged", {
          error: cut(errorMessage(error), 240),
        });
      }
      return this.models(
        action.id,
        ctx,
        action.provider,
        action.page || 0,
        messageId,
        notice,
        metadata,
      );
    });
  }
}
