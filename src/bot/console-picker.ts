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
  async providers(
    id: SessionId,
    ctx: TopicContext,
    page = 0,
    messageId?: number,
  ) {
    const models = await this.console.bridge.models();
    const metadata = await this.console.bridge.metadata(id);
    const providers = [...new Set(models.map((m) => m.provider))];
    page = Math.max(
      0,
      Math.min(page, Math.max(0, Math.ceil(providers.length / PAGE) - 1)),
    );
    const rows = providers
      .slice(page * PAGE, (page + 1) * PAGE)
      .map((provider) => [
        this.console.button(
          `${metadata?.selection?.provider === provider ? "✓ " : ""}${provider}`,
          ctx,
          { type: "models", id, provider, page: 0 },
        ),
      ]);
    rows.push(
      ...this.console.navigation(ctx, page, providers.length, {
        type: "providers",
        id,
        picker: true,
      }),
    );
    if (this.console.draftsUnsupported && (await this.console.running(id)))
      rows.push([
        this.console.button(this.t("stop"), ctx, { type: "stop", id }),
      ]);
    return this.console.page(ctx, messageId, this.t("chooseProvider"), rows);
  }
  async models(
    id: SessionId,
    ctx: TopicContext,
    provider: string,
    page = 0,
    messageId?: number,
    notice = "",
    metadata?: SessionMetadata | null,
  ) {
    metadata ??= await this.console.bridge.metadata(id);
    const models = (await this.console.bridge.models()).filter(
      (m) => m.provider === provider,
    );
    page = Math.max(
      0,
      Math.min(page, Math.max(0, Math.ceil(models.length / PAGE) - 1)),
    );
    const visible = models.slice(page * PAGE, (page + 1) * PAGE);
    const selected = (m: ModelEntry) =>
      metadata?.selection?.provider === provider &&
      metadata?.selection?.model === m.id;
    const rows = visible.map((m) => [
      this.console.button(`${selected(m) ? "✓ " : ""}${m.name || m.id}`, ctx, {
        type: "select",
        id,
        provider,
        model: m.id,
        page,
      }),
    ]);
    rows.push(
      ...this.console.navigation(ctx, page, models.length, {
        type: "models",
        id,
        provider,
      }),
    );
    rows.push([
      this.console.button(this.t("providers"), ctx, {
        type: "providers",
        id,
        page: 0,
        picker: true,
      }),
      ...(this.console.draftsUnsupported && (await this.console.running(id))
        ? [this.console.button(this.t("stop"), ctx, { type: "stop", id })]
        : []),
    ]);
    return this.console.page(
      ctx,
      messageId,
      cut(
        `${this.t("modelsPage", { provider, page: page + 1 })}${notice ? `\n${notice}` : ""}\n${visible.map((m) => `${selected(m) ? "✓ " : ""}${m.name || m.id}${m.description ? ` — ${m.description}` : ""}`).join("\n")}`,
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
