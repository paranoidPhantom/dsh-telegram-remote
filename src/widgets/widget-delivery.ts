import path from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

export type WidgetChatId = string | number;
export type WidgetThreadId = string | number | null | undefined;

export interface WidgetDeliveryMetadata {
  message_id: number;
  sent_at: string;
  content_hash: string;
}

/** Delivery receipts only; this is not a mirror of DSH session state. */
export interface WidgetDeliveryStore {
  get(key: string): Promise<WidgetDeliveryMetadata | null | undefined>;
  set(key: string, value: WidgetDeliveryMetadata): Promise<unknown>;
}

export interface SendWidgetParams {
  chat_id: WidgetChatId;
  message_thread_id?: number;
  html: string;
  caption: string;
  protect_content: true;
  allow_queries: false;
  is_shared: false;
}

export interface DeleteWidgetParams {
  chat_id: WidgetChatId;
  message_id: number;
}

/** Result is the Bot API result, not its envelope; sends are checked below. */
export interface WidgetDeliveryAPI {
  call(method: "sendWidget", params: SendWidgetParams): Promise<unknown>;
  call(method: "deleteMessage", params: DeleteWidgetParams): Promise<unknown>;
}

export interface WidgetDeliveryOptions {
  api: WidgetDeliveryAPI;
  store: WidgetDeliveryStore;
}

export interface WidgetDeliveryInput {
  chatId: WidgetChatId;
  threadId?: number | null;
  filename: string;
  compiled: { html: string; hash: string };
  caption?: string;
}

export interface WidgetDeliveryResult {
  status: "unchanged" | "replaced" | "sent";
  messageId: number;
}

export function widgetDeliveryKey(
  chatId: WidgetChatId,
  threadId: WidgetThreadId,
  filename: string,
): string {
  return `widget:${JSON.stringify([String(chatId), threadId == null ? null : String(threadId), path.basename(filename)])}`;
}

function isWidgetMessage(message: unknown): message is { message_id: number } {
  return (
    typeof message === "object" &&
    message !== null &&
    "message_id" in message &&
    typeof message.message_id === "number" &&
    Number.isSafeInteger(message.message_id)
  );
}

function errorDescription(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    if ("description" in error && error.description)
      return String(error.description);
    if ("message" in error && error.message) return String(error.message);
  }
  return String(error);
}

/** Replacement sends first, deletes old second, and persists only after both. */
export class WidgetDelivery {
  #queues = new Map<string, Promise<WidgetDeliveryResult>>();
  readonly api: WidgetDeliveryAPI;
  readonly store: WidgetDeliveryStore;

  constructor({ api, store }: WidgetDeliveryOptions) {
    if (!api?.call || !store?.get || !store?.set)
      throw new TypeError("WidgetDelivery requires api.call and store.get/set");
    this.api = api;
    this.store = store;
  }

  deliver({
    chatId,
    threadId,
    filename,
    compiled,
    caption,
  }: WidgetDeliveryInput): Promise<WidgetDeliveryResult> {
    const key = widgetDeliveryKey(chatId, threadId, filename);
    const prior = this.#queues.get(key) || Promise.resolve();
    const task = prior
      .catch(() => {})
      .then(async (): Promise<WidgetDeliveryResult> => {
        if (!compiled?.html || typeof compiled.html !== "string")
          throw new Error("Compiled widget HTML required");
        const raw = Buffer.byteLength(compiled.html);
        const compressed = deflateSync(compiled.html, { level: 9 }).length;
        if (raw > 32768 || compressed > 4096)
          throw new Error("Compiled widget exceeds Telegram limits");
        const hash = createHash("sha256").update(compiled.html).digest("hex");
        if (compiled.hash !== hash)
          throw new Error("Compiled widget hash does not match HTML");
        const old = await this.store.get(key);
        if (old?.content_hash === hash)
          return { status: "unchanged", messageId: old.message_id };
        // Telegram Bot API 10.4 sendWidget takes HTML as a string, not InputFile.
        // https://core.telegram.org/bots/api/methods/sendwidget.md
        const message = await this.api.call("sendWidget", {
          chat_id: chatId,
          ...(threadId == null ? {} : { message_thread_id: threadId }),
          html: compiled.html,
          caption: (caption || path.basename(filename)).slice(0, 1024),
          protect_content: true,
          allow_queries: false,
          is_shared: false,
        });
        if (!isWidgetMessage(message))
          throw new Error("sendWidget returned no valid message_id");
        if (old?.message_id != null) {
          try {
            await this.api.call("deleteMessage", {
              chat_id: chatId,
              message_id: old.message_id,
            });
          } catch (error) {
            const description = errorDescription(error);
            if (
              !/message (?:to delete )?not found|message_id_invalid/i.test(
                description,
              )
            ) {
              // Roll back the new send; keep the registry pointing to the old one.
              try {
                await this.api.call("deleteMessage", {
                  chat_id: chatId,
                  message_id: message.message_id,
                });
              } catch (rollbackError) {
                throw new AggregateError(
                  [error, rollbackError],
                  "Old widget deletion and new-widget rollback failed; registry unchanged",
                );
              }
              throw error;
            }
          }
        }
        await this.store.set(key, {
          message_id: message.message_id,
          sent_at: new Date().toISOString(),
          content_hash: hash,
        });
        return {
          status: old ? "replaced" : "sent",
          messageId: message.message_id,
        };
      });
    this.#queues.set(key, task);
    task
      .finally(() => {
        if (this.#queues.get(key) === task) this.#queues.delete(key);
      })
      .catch(() => {});
    return task;
  }
}
