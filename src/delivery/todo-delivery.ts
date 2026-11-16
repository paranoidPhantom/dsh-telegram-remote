import { createHash } from "node:crypto";
import {
  errorMessage,
  messageResult,
  type DeliveryPort,
  type RunView,
  type TodoItem,
  type TopicBinding,
} from "../bot/contracts.js";
import type { Translator } from "../i18n/bot-i18n.js";
import { html } from "../rendering/console-render.js";
import { toolEmojiHtml, type ToolNameRule } from "../rendering/tool-name.js";

/** Conservative HTML-source budget also bounds Telegram's parsed UTF-16 text. */
export function todoText(
  todos: readonly TodoItem[],
  t: Translator,
  rules?: readonly ToolNameRule[],
): string {
  const done = todos.filter((item) => item.status === "completed").length;
  const active = todos.filter((item) => item.status === "in_progress").length;
  let text = `${toolEmojiHtml("todo_write", rules)} <b>${html(t("todoTitle"))}</b>\n${html(t("todoCounts", { done, total: todos.length, active }))}`;
  if (!todos.length) return `${text}\n${html(t("todoEmpty"))}`;
  let shown = 0;
  for (const item of todos.slice(0, 40)) {
    let content = "";
    for (const character of item.content
      .toWellFormed()
      .replace(/\s+/g, " ")
      .trim()) {
      const escaped = html(character);
      if (content.length + escaped.length > 240) {
        content += "…";
        break;
      }
      content += escaped;
    }
    const row = `\n${item.status === "completed" ? "☑" : item.status === "in_progress" ? "▶" : "☐"} ${content}`;
    // Reserve enough space for a localized omission count at every boundary.
    const omitted = `\n${html(t("todoOmitted", { count: todos.length - shown - 1 }))}`;
    if (text.length + row.length + omitted.length > 4096) break;
    text += row;
    shown++;
  }
  if (shown < todos.length)
    text += `\n${html(t("todoOmitted", { count: todos.length - shown }))}`;
  return text;
}

/** Called only inside RunDelivery's owning per-session serial queue. No timers,
 * tool-argument interpretation, latest-control ownership, or session text store. */
export class TodoDelivery {
  constructor(readonly port: DeliveryPort) {}
  async onRun(id: string, mapping: TopicBinding, view: RunView): Promise<void> {
    if (!view.todos || !view.todoVersion || this.port.closed) return;
    const current = async () => {
      if (this.port.closed) return undefined;
      const now = await this.port.mapping(id);
      return now &&
        !now.deleted &&
        !now.closed &&
        now.chatId === mapping.chatId &&
        now.threadId === mapping.threadId
        ? now
        : undefined;
    };
    let now = await current();
    if (!now) return;
    let receipt = now.todoReceipt;
    if (
      receipt &&
      (receipt.chatId !== now.chatId || receipt.threadId !== now.threadId)
    )
      receipt = undefined;
    if (receipt?.version !== undefined && view.todoVersion < receipt.version)
      return;
    if (!receipt?.messageId && !view.todos.length) return;
    // An interrupted send has no safe automatic replay: Telegram has no send
    // idempotency key. The pending marker intentionally requires reconciliation.
    if (receipt?.pending) return;
    const text = todoText(view.todos, this.port.t, this.port.toolNameRules);
    const hash = createHash("sha256").update(text).digest("hex");
    receipt = { ...receipt, chatId: now.chatId, threadId: now.threadId };
    const save = async () => {
      now = await current();
      if (!now) return false;
      await this.port.save(id, { ...now, todoReceipt: { ...receipt } });
      return true;
    };
    if (!receipt.messageId) {
      receipt.pending = true;
      if (!(await save()) || !(await current())) return;
      const sent = messageResult(
        await this.port.api
          .call("sendMessage", {
            ...this.port.params(mapping),
            text,
            parse_mode: "HTML",
            disable_notification: true,
          })
          .catch(async (error: unknown) => {
            const code =
              typeof error === "object" && error !== null && "code" in error
                ? Number(error.code)
                : NaN;
            // Explicit Telegram 4xx rejection proves no accepted send. Transport and
            // server failures remain ambiguous and retain the pending marker.
            if (Number.isInteger(code) && code >= 400 && code < 500) {
              receipt!.pending = false;
              await save();
            }
            throw error;
          }),
      );
      receipt.messageId = sent.message_id;
      receipt.hash = hash;
      receipt.version = view.todoVersion;
      receipt.pending = false;
      // Accepted ID is persisted BEFORE pin; pin failures retry without resending.
      if (!(await save())) return;
    } else if (receipt.hash !== hash) {
      if (!(await current())) return;
      await this.port.api
        .call("editMessageText", {
          chat_id: mapping.chatId,
          message_id: receipt.messageId,
          text,
          parse_mode: "HTML",
        })
        .catch((error) => {
          if (!/not modified/i.test(errorMessage(error))) throw error;
        });
      receipt.hash = hash;
      receipt.version = view.todoVersion;
      if (!(await save())) return;
    } else if (receipt.version !== view.todoVersion) {
      receipt.version = view.todoVersion;
      if (!(await save())) return;
    }
    if (!receipt.pinned && (await current())) {
      await this.port.api.call("pinChatMessage", {
        chat_id: mapping.chatId,
        message_id: receipt.messageId,
        disable_notification: true,
      });
      receipt.pinned = true;
      await save();
    }
  }
}
