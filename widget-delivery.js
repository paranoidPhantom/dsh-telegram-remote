import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export function widgetDeliveryKey(chatId, threadId, filename) {
  return `widget:${JSON.stringify([String(chatId), threadId == null ? null : String(threadId), path.basename(filename)])}`;
}

/** store: async get(key), set(key, {message_id,sent_at,content_hash}).
 * api: async call(method, params), returning the Bot API result (not its envelope).
 * Only delivery metadata is stored. Serialization is per registry key, not global.
 */
export class WidgetDelivery {
  #queues = new Map();
  constructor({ api, store }) {
    if (!api?.call || !store?.get || !store?.set) throw new TypeError('WidgetDelivery requires api.call and store.get/set');
    this.api = api; this.store = store;
  }
  deliver({ chatId, threadId, filename, compiled, caption }) {
    const key = widgetDeliveryKey(chatId, threadId, filename);
    const prior = this.#queues.get(key) || Promise.resolve();
    const task = prior.catch(() => {}).then(async () => {
      if (!compiled?.html || typeof compiled.html !== 'string') throw new Error('Compiled widget HTML required');
      const raw = Buffer.byteLength(compiled.html); const compressed = deflateSync(compiled.html, { level: 9 }).length;
      if (raw > 32768 || compressed > 4096) throw new Error('Compiled widget exceeds Telegram limits');
      const hash = createHash('sha256').update(compiled.html).digest('hex');
      if (compiled.hash !== hash) throw new Error('Compiled widget hash does not match HTML');
      const old = await this.store.get(key);
      if (old?.content_hash === hash) return { status: 'unchanged', messageId: old.message_id };
      // Telegram Bot API 10.4 sendWidget: html is a string, not an InputFile.
      // https://core.telegram.org/bots/api/methods/sendwidget.md
      const message = await this.api.call('sendWidget', {
        chat_id: chatId, ...(threadId == null ? {} : { message_thread_id: threadId }),
        html: compiled.html, caption: (caption || path.basename(filename)).slice(0, 1024),
        protect_content: true, allow_queries: false, is_shared: false
      });
      if (!Number.isSafeInteger(message?.message_id)) throw new Error('sendWidget returned no valid message_id');
      if (old?.message_id != null) {
        try { await this.api.call('deleteMessage', { chat_id: chatId, message_id: old.message_id }); }
        catch (error) {
          const description = String(error.description || error.message || error);
          if (!/message (?:to delete )?not found|message_id_invalid/i.test(description)) {
            // Roll back the new send when replacement failed; retain registry pointing at old.
            try { await this.api.call('deleteMessage', { chat_id: chatId, message_id: message.message_id }); }
            catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Old widget deletion and new-widget rollback failed; registry unchanged'); }
            throw error;
          }
        }
      }
      await this.store.set(key, { message_id: message.message_id, sent_at: new Date().toISOString(), content_hash: hash });
      return { status: old ? 'replaced' : 'sent', messageId: message.message_id };
    });
    this.#queues.set(key, task);
    task.finally(() => { if (this.#queues.get(key) === task) this.#queues.delete(key); }).catch(() => {});
    return task;
  }
}
