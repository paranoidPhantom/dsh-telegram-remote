import { TTL, cut } from './console-render.js';
import { TOPIC_MODE_HELP, topicModeError } from './topic-mode.js';

/** Session initiation snapshots live DSH selection; only explicit confirmation creates. */
export class ConsoleSessions {
  constructor(console) { this.console = console; this.initiations = new Map(); this.sequence = 0; }
  clear() { this.initiations.clear(); }
  topicKey(ctx) { return `native-topic:${ctx.chatId}:${ctx.threadId}`; }
  async requestNew(ctx, messageId, native = false, prompt) {
    const c = this.console;
    const key = native ? this.topicKey(ctx) : `new:${ctx.chatId}:${ctx.threadId}:${++this.sequence}`;
    return c.serial(key, async () => {
      if (native) {
        const bound = await c.bound(ctx.chatId, ctx.threadId);
        if (bound) { if (prompt) await c.bridge.prompt(bound.id, prompt.text, prompt.requestId); return bound; }
        // Deleted bindings are never replaced implicitly by a late native event.
        for (const [name, value] of await c.store.entries()) {
          if (name.startsWith('console:topic:') && Number(value?.chatId) === Number(ctx.chatId) && Number(value?.threadId) === Number(ctx.threadId)) return;
        }
      }
      let pending = this.initiations.get(key);
      if (pending && prompt && !pending.prompts.some(p => p.requestId === prompt.requestId)) pending.prompts.push(prompt);
      if (pending && pending.expires > Date.now()) return;
      const source = await c.bound(ctx.chatId, ctx.threadId);
      const model = await c.bridge.newSessionSelection(source?.id);
      if (!model?.provider || !model?.model) throw new Error('DSH has no model selected. Choose a default model in DSH first.');
      pending = { ctx: { ...ctx }, model: structuredClone(model), native, prompts: pending?.prompts || (prompt ? [prompt] : []), expires: Date.now() + TTL, key };
      this.initiations.set(key, pending);
      const rows = [[c.button('Confirm new session', ctx, { type: 'new-confirm', pending }), c.button('Cancel', ctx, { type: 'new-cancel', pending })]];
      const text = `Create DSH session with ${model.provider} / ${model.model}${model.reasoningEffort ? ` · ${model.reasoningEffort}` : ''}?${native ? '\nYour messages wait here until you confirm.' : '\nAfter confirmation, open the new topic using its link.'}`;
      try {
        const sent = messageId ? await c.edit(ctx, messageId, text, { inline_keyboard: rows }) : await c.send(ctx, text, { reply_markup: { inline_keyboard: rows } });
        pending.messageId = messageId || sent.message_id;
        await c.latest(ctx, pending.messageId);
      } catch (error) { this.initiations.delete(key); throw error; }
    });
  }
  async confirm(pending, ctx, messageId, cancel = false) {
    const c = this.console;
    return c.serial(pending.key, async () => {
      if (c.closed || this.initiations.get(pending.key) !== pending || pending.done || pending.expires <= Date.now()) return;
      pending.done = true;
      for (const [token, action] of c.actions) if (action.pending === pending) c.actions.delete(token);
      if (cancel) {
        this.initiations.delete(pending.key);
        return c.edit(ctx, messageId, 'Session creation cancelled. Queued messages were not sent to DSH.', { inline_keyboard: [] });
      }
      try {
        // Native topic already exists. Never create another topic or redirect it.
        if (pending.native && await c.bound(ctx.chatId, ctx.threadId)) throw new Error('This topic is already bound.');
        const id = await c.bridge.create();
        const ack = await c.bridge.selectModel(id, pending.model);
        if (!ack || ack.ok === false || ack.accepted === false || ack.success === false || ack.error) throw new Error(ack?.reason || ack?.error || 'DSH did not acknowledge model selection');
        if (c.closed) return;
        let mapping;
        if (pending.native) {
          mapping = { chatId: ctx.chatId, threadId: ctx.threadId };
          await c.save(id, mapping);
          // Keep the confirmation as latest controls; pin a separate compact card.
          mapping.latestControlMessageId = messageId;
          await c.save(id, mapping);
          await c.card(id, mapping, await c.bridge.metadata(id));
        } else mapping = await c.open(id, ctx);
        if (!mapping) throw new Error('Unable to open the new session topic');
        const url = c.username ? `https://t.me/${c.username.replace(/^@/, '')}/${mapping.threadId}` : null;
        await c.edit(ctx, messageId, pending.native ? 'Session ready in this topic.' : 'New session ready. Open the topic below; Telegram cannot switch topics automatically.', { inline_keyboard: url ? [[{ text: 'Open session', url }]] : [] });
        while (pending.prompts.length) {
          const prompt = pending.prompts[0];
          await c.bridge.prompt(id, prompt.text, prompt.requestId);
          pending.prompts.shift();
        }
        this.initiations.delete(pending.key);
      } catch (error) {
        // Retain unsent native text in memory, but never replay a partially sent queue.
        pending.done = false;
        pending.expires = 0;
        await c.edit(ctx, messageId, topicModeError(error)?TOPIC_MODE_HELP:`⚠ Session setup failed: ${cut(error.message, 350)}. No new-topic link was published. Use /sessions to inspect DSH before retrying.`, { inline_keyboard: [] });
      }
    });
  }
  async requestClose(id, ctx, messageId) {
    const c = this.console, mapping = await c.mapping(id);
    if (!mapping || mapping.deleted) return;
    const rows = [[c.button('Delete Telegram topic', ctx, { type: 'close-confirm', id, targetThreadId: mapping.threadId }), c.button('Cancel', ctx, { type: 'close-cancel', id })]];
    const text = 'Close session in Telegram? This deletes only its Telegram topic. The DSH session and any active DSH run are preserved and continue. Reopen it later with /sessions.';
    return messageId ? c.edit(ctx, messageId, text, { inline_keyboard: rows }) : c.send(ctx, text, { reply_markup: { inline_keyboard: rows } });
  }
  async confirmClose(action) {
    const c = this.console;
    return c.serial(action.id, async () => {
      const mapping = await c.mapping(action.id);
      if (!mapping || mapping.deleted || Number(mapping.threadId) !== Number(action.targetThreadId)) return;
      // Commit the tombstone only after Telegram acknowledges deletion.
      await c.api.call('deleteForumTopic', { chat_id: mapping.chatId, message_thread_id: mapping.threadId });
      await c.save(action.id, { ...mapping, deleted: true, closed: true });
      c.active.delete(action.id);
      for (const [token, value] of c.actions) if (value.id === action.id) c.actions.delete(token);
      for (const pending of c.pending) if (pending.sessionId === action.id) pending.finish('unavailable');
    });
  }
}
