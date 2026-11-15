import { randomBytes } from 'node:crypto';

import { TTL, str, cut, html, chunks, compactSession, missingTopic, missingMessage, notModified, gone } from './console-render.js';
import { ConsolePicker } from './console-picker.js';
import { ConsoleSessions } from './console-sessions.js';
import { RunDelivery } from './console-delivery.js';
import { formatApproval } from './tool-format.js';
import { fileButtonName } from './path-display.js';
import { TOPIC_MODE_HELP, topicModeError } from './topic-mode.js';

/** Telegram-only delivery projection. No DSH session/model state is persisted.
 * Parent owns polling offsets and calls refresh/onRun for live bridge events.
 * Approval outcomes are returned to the caller; this class never calls resolveApproval.
 */
export class TelegramConsole {
  constructor({ api, bridge, store, ownerId = 5491328220, signal }) {
    this.picker = new ConsolePicker(this);
    this.sessionActions = new ConsoleSessions(this);
    this.delivery = new RunDelivery(this);
    this.api = api;
    this.bridge = bridge;
    this.store = store;
    this.ownerId = Number(ownerId);
    this.signal = signal;
    this.username = '';
    this.active = new Map();
    this.draftsUnsupported = false;
    this.actions = new Map();
    this.queues = new Map();
    this.pending = new Set();
    this.reasons = new Map();
    this.seen = new Set();
    this.clearedMarkup = new Set();
    this.closed = Boolean(signal?.aborted);
    this.abort = () => {
      this.closed = true;
      this.actions.clear();
      this.sessionActions.clear();
      this.active.clear();
      this.reasons.clear();
      for (const p of this.pending) p.finish('cancelled');
    };
    signal?.addEventListener('abort', this.abort, { once: true });
  }

  close() {
    this.abort();
    this.signal?.removeEventListener('abort', this.abort);
  }

  serial(id, task) {
    const previous = this.queues.get(String(id)) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.queues.set(String(id), next);
    return next.finally(() => { if (this.queues.get(String(id)) === next) this.queues.delete(String(id)); });
  }

  key(id) { return `console:topic:${id}`; }
  async mapping(id) { return this.store.get(this.key(id)); }
  async getTopic(id) {
    const mapping = await this.mapping(id);
    return mapping && !mapping.deleted ? { chatId: mapping.chatId, threadId: mapping.threadId } : undefined;
  }
  async save(id, value) { await this.store.set(this.key(id), value); }
  async bound(chatId, threadId) {
    if (!threadId) return null;
    for (const [key, value] of await this.store.entries()) {
      if (key.startsWith('console:topic:') && value && !value.deleted && Number(value.chatId) === Number(chatId) && Number(value.threadId) === Number(threadId)) {
        return { id: key.slice('console:topic:'.length), ...value };
      }
    }
    return null;
  }

  context(message) { return { chatId: message.chat.id, threadId: message.message_thread_id || 0 }; }
  params(ctx) { return { chat_id: ctx.chatId, ...(ctx.threadId ? { message_thread_id: ctx.threadId } : {}) }; }
  async send(ctx, text, extra = {}) {
    const sent = await this.api.call('sendMessage', { ...this.params(ctx), text, disable_notification: true, ...extra });
    await this.latest(ctx, sent.message_id);
    return sent;
  }
  async edit(ctx, messageId, text, reply_markup) {
    if(reply_markup?.inline_keyboard?.flat().length)this.clearedMarkup.delete(`${ctx.chatId}:${messageId}`);
    try {
      return await this.api.call('editMessageText', { chat_id: ctx.chatId, message_id: messageId, text, ...(reply_markup ? { reply_markup } : {}) });
    } catch (e) { if (!notModified(e)) throw e; }
  }

  button(text, ctx, action) {
    const now = Date.now();
    for (const [key, value] of this.actions) if (value.expires < now) this.actions.delete(key);
    const token = randomBytes(12).toString('base64url');
    this.actions.set(token, { ...action, chatId: ctx.chatId, threadId: ctx.threadId || 0, expires: now + TTL });
    const appearance = text === 'Model' ? {style:'primary',icon_custom_emoji_id:'5258466217273871977'}
      : action.type === 'details' ? {icon_custom_emoji_id:'5454371323595744068'}
      : action.type === 'close' ? {style:'danger',icon_custom_emoji_id:'5341570033405412393'}
      : action.type === 'steer' ? {icon_custom_emoji_id:'5220197908342648622'}
      : action.type === 'turn-file' ? {icon_custom_emoji_id:{added:'5371101764676241385',removed:'5370673711055653338',edited:'5375052056551770853'}[action.kind]} : {};
    return { text: cut(text, 60), callback_data: token, ...appearance };
  }
  controls(id, ctx, running = this.active.has(id)) {
    return { inline_keyboard: [[...(running && this.draftsUnsupported ? [this.button('⏹ Stop', ctx, { type: 'stop', id })] : []),
      this.button('Model', ctx, { type: 'providers', id, page: 0 }), this.button('Details', ctx, { type: 'details', id }), this.button('End topic', ctx, { type: 'close', id })]] };
  }
  finalControls(id,ctx,view){
    const markup=this.controls(id,ctx,false);
    for(const file of view.touchedFiles||[])markup.inline_keyboard.push([this.button(fileButtonName(file.path),ctx,{type:'turn-file',id,turn:view.turn,path:file.path,kind:file.kind})]);
    return markup;
  }
  async clearMarkup(ctx, messageId) {
    const key=`${ctx.chatId}:${messageId}`;
    if (!messageId || this.clearedMarkup.has(key) || [...this.pending].some(p => !p.done && p.messageId === messageId)) return;
    try { await this.api.call('editMessageReplyMarkup', { chat_id: ctx.chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }); }
    catch (e) { if (!missingMessage(e) && !notModified(e)) throw e; }
    this.clearedMarkup.add(key);
  }
  async latest(ctx, messageId) {
    const bound = await this.bound(ctx.chatId, ctx.threadId);
    const key = bound ? this.key(bound.id) : `console:controls:${ctx.chatId}:${ctx.threadId || 0}`;
    const mapping = bound ? await this.mapping(bound.id) : await this.store.get(key) || {};
    const previousId = mapping.latestControlMessageId || mapping.cardId;
    if (previousId !== messageId) await this.clearMarkup(ctx, previousId);
    mapping.latestControlMessageId = messageId;
    await this.store.set(key, mapping);
    return mapping;
  }
  compact(id, metadata) {
    return compactSession(id, metadata, this.active.has(id));
  }
  async card(id, mapping, metadata) {
    const text = this.compact(id, metadata);
    // Passive refreshes must never teleport controls back onto the pinned card.
    const owns = !mapping.latestControlMessageId || mapping.latestControlMessageId === mapping.cardId;
    const markup = owns && metadata ? this.controls(id, mapping, Boolean(metadata.running || this.active.has(id))) : { inline_keyboard: [] };
    if (mapping.cardId) {
      try { await this.edit(mapping, mapping.cardId, text, markup); return; }
      catch (e) { if (!missingMessage(e)) throw e; }
    }
    const message = await this.send(mapping, text, { reply_markup: markup });
    Object.assign(mapping, await this.mapping(id), { cardId: message.message_id });
    await this.save(id, mapping);
    if (owns) await this.latest(mapping, message.message_id);
    await this.api.call('pinChatMessage', { chat_id: mapping.chatId, message_id: mapping.cardId, disable_notification: true });
  }
  async status(id, ctx) {
    const metadata = await this.bridge.metadata(id);
    const sent = await this.send(ctx, this.compact(id, metadata), { reply_markup: this.controls(id, ctx, Boolean(metadata?.running || this.active.has(id))) });
    await this.latest(ctx, sent.message_id);
  }
  async details(id, ctx) {
    const metadata = await this.bridge.metadata(id);
    const diagnostics = [metadata?.cwd && `Directory: ${metadata.cwd}`, await this.bridge.details(id)].filter(Boolean).join('\n\n');
    for (const part of chunks(diagnostics, 3000)) {
      const sent = await this.send(ctx, `<blockquote expandable>${html(part)}</blockquote>`, { parse_mode: 'HTML', reply_markup: this.controls(id, ctx) });
      await this.latest(ctx, sent.message_id);
    }
  }

  async refresh(id) {
    return this.serial(id, async () => {
      const mapping = await this.mapping(id);
      if (!mapping || mapping.deleted || this.closed) return;
      let metadata;
      try { metadata = await this.bridge.metadata(id); }
      catch (e) {
        if (!gone(e)) {
          if (mapping.cardId) await this.edit(mapping, mapping.cardId, '⚠ DSH offline. /status to retry.', !mapping.latestControlMessageId || mapping.latestControlMessageId === mapping.cardId ? this.controls(id, mapping) : { inline_keyboard: [] });
          return;
        }
      }
      try {
        if (!metadata) {
          await this.api.call('editForumTopic', { chat_id: mapping.chatId, message_thread_id: mapping.threadId, name: '⚠ Session gone' });
          await this.card(id, mapping, null);
          return;
        }
        const title = cut(metadata.title || id, 128);
        if (mapping.topicTitle !== title) {
          await this.api.call('editForumTopic', { chat_id: mapping.chatId, message_thread_id: mapping.threadId, name: title });
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

  async open(id, ctx) {
    return this.serial(id, async () => {
      const metadata = await this.bridge.metadata(id);
      if (!metadata) return this.send(ctx, 'Session gone in DSH. Use /sessions.');
      let mapping = await this.mapping(id);
      const title = cut(metadata.title || id, 128);
      if (mapping && !mapping.deleted) {
        try {
          if (mapping.topicClosed) {
            await this.api.call('reopenForumTopic', { chat_id: mapping.chatId, message_thread_id: mapping.threadId });
            mapping.topicClosed = false;
          }
          await this.api.call('editForumTopic', { chat_id: mapping.chatId, message_thread_id: mapping.threadId, name: title });
        } catch (e) { if (!missingTopic(e)) throw e; mapping = null; }
      }
      if (!mapping || mapping.deleted) {
        const topic = await this.api.call('createForumTopic', { chat_id: ctx.chatId, name: title });
        mapping = { chatId: ctx.chatId, threadId: topic.message_thread_id, topicTitle: title };
        await this.save(id, mapping);
      }
      mapping.topicTitle = title;
      await this.save(id, mapping);
      await this.card(id, mapping, metadata);
      return mapping;
    });
  }

  page(...args) { return this.picker.page(...args); }
  navigation(...args) { return this.picker.navigation(...args); }
  sessions(...args) { return this.picker.sessions(...args); }
  providers(...args) { return this.picker.providers(...args); }
  models(...args) { return this.picker.models(...args); }

  async callback(query) {
    const message = query.message;
    const ctx = message && this.context(message);
    const action = this.actions.get(query.data);
    const authorized = Number(query.from?.id) === this.ownerId && message?.chat?.type === 'private' && Number(ctx?.chatId) === this.ownerId;
    if (!authorized || (action && (Number(action.chatId) !== Number(ctx.chatId) || Number(action.threadId) !== Number(ctx.threadId)))) {
      await this.api.call('answerCallbackQuery', { callback_query_id: query.id, text: 'Not authorized.', show_alert: true });
      return;
    }
    if (!action || action.expires <= Date.now()) {
      if (action) this.actions.delete(query.data);
      if (action?.type === 'new-confirm' || action?.type === 'new-cancel') {
        action.pending.expires = 0;
        await this.api.call('answerCallbackQuery', { callback_query_id: query.id, text: 'Confirmation expired. Send another message here or use /new to confirm again.' });
        return this.edit(ctx, message.message_id, 'Confirmation expired. No DSH session was created. Queued topic messages are retained in memory; send another message here to confirm again.', { inline_keyboard: [] });
      }
      await this.api.call('answerCallbackQuery', { callback_query_id: query.id, text: 'Controls expired. Refreshed; choose again.' });
      const bound = await this.bound(ctx.chatId, ctx.threadId);
      if (bound) await this.providers(bound.id, ctx, 0, message.message_id === bound.cardId ? undefined : message.message_id);
      else await this.sessions(ctx, 0, message.message_id);
      return;
    }
    await this.api.call('answerCallbackQuery', { callback_query_id: query.id });
    switch (action.type) {
      case 'new': return this.requestNew(ctx, message.message_id);
      case 'new-confirm': return this.sessionActions.confirm(action.pending, ctx, message.message_id);
      case 'new-cancel': return this.sessionActions.confirm(action.pending, ctx, message.message_id, true);
      case 'close': return this.sessionActions.requestClose(action.id, ctx);
      case 'close-confirm': return this.sessionActions.confirmClose(action);
      case 'close-cancel': return this.edit(ctx, message.message_id, 'Topic kept. DSH session unchanged.', this.controls(action.id, ctx));
      case 'turn-file': {
        const file=await this.bridge.fileForTurn(action.id,action.turn,action.path);
        return this.api.document({chatId:ctx.chatId,threadId:ctx.threadId,name:file.name,content:file.content,caption:file.name});
      }
      case 'steer': {
        this.actions.delete(query.data);
        const result=await this.bridge.steerQueued(action.id,action.requestId);
        return this.edit(ctx,message.message_id,result.accepted?'Steering now.':result.reason||'This message is no longer queued.',{inline_keyboard:[]});
      }
      case 'sessions': return this.sessions(ctx, action.page, message.message_id);
      case 'open': {
        const mapping=await this.open(action.id,ctx);
        if(mapping&&this.username)return this.edit(ctx,message.message_id,'Session topic ready.',{inline_keyboard:[[{text:'Open topic',url:`https://t.me/${this.username.replace(/^@/,'')}/${mapping.threadId}`}]]});
        return;
      }
      case 'refresh': return this.status(action.id, ctx);
      case 'providers': return this.providers(action.id, ctx, action.page, action.picker ? message.message_id : undefined);
      case 'models': return this.models(action.id, ctx, action.provider, action.page, message.message_id);
      case 'stop': if (await this.running(action.id)) return this.bridge.stop(action.id); return;
      case 'details': return this.details(action.id, ctx);
      case 'select': {
        this.actions.delete(query.data);
        try { return await this.picker.select(action, ctx, message.message_id); }
        catch (error) {
          // Selection never creates an acknowledgement/error message, even if
          // catalog refresh fails. Keep the existing picker and its checkmark.
          // A transport outage may also prevent editing; /status remains usable.
          return;
        }
      }
      case 'approve':
      case 'deny': {
        const pending = action.pending;
        if (pending.done) return;
        if (action.type === 'approve') return pending.finish('allowed-once');
        // Reject immediately; an optional reason cannot strand a DSH approval.
        pending.finish('rejected');
        const reply = await this.send(ctx, 'Denied. Optional reason? Reply with one line.', { reply_markup: { force_reply: true, selective: true } });
        this.reasons.set(`${ctx.chatId}:${ctx.threadId}:${reply.message_id}`, { expires: Date.now() + TTL, req: pending.req });
        return;
      }
    }
  }

  requestNew(...args) { return this.sessionActions.requestNew(...args); }
  bindNativeTopic(ctx, prompt) { return this.sessionActions.requestNew(ctx, undefined, true, prompt); }

  async requireTopics(ctx) {
    const me=await this.api.call('getMe');
    if(me?.has_topics_enabled===false){await this.send(ctx,TOPIC_MODE_HELP);return false;}
    return true;
  }
  async handleUpdate(update) {
    if (this.closed) return;
    if (update.callback_query) {
      try { return await this.callback(update.callback_query); }
      catch (e) {
        const m = update.callback_query.message;
        if (Number(update.callback_query.from?.id) === this.ownerId && Number(m?.chat?.id) === this.ownerId) return this.send(this.context(m), `⚠ ${topicModeError(e)?TOPIC_MODE_HELP:cut(e.message, 500)}`, { disable_notification: false });
        return;
      }
    }
    if (update.stopped_message_generation) {
      const stopped = update.stopped_message_generation;
      if (Number(stopped.chat?.id) !== this.ownerId || stopped.chat?.type !== 'private') return;
      const bound = await this.bound(stopped.chat.id, stopped.message_thread_id || 0);
      const run = bound && this.active.get(bound.id);
      if (run && Number(stopped.draft_id) === run.draftId) await this.bridge.stop(bound.id);
      return;
    }
    const message = update.message;
    if (!message || Number(message.from?.id) !== this.ownerId || message.chat?.type !== 'private' || Number(message.chat.id) !== this.ownerId) return;
    const ctx = this.context(message);
    const requestId = `telegram:${ctx.chatId}:${message.message_id}`;
    if (this.seen.has(requestId)) return;
    this.seen.add(requestId);
    if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value);
    try {
      let bound = await this.bound(ctx.chatId, ctx.threadId);
      if (message.forum_topic_created) {
        if (ctx.threadId && !bound) await this.bindNativeTopic(ctx);
        return;
      }
      if ((message.forum_topic_deleted || message.forum_topic_closed || message.forum_topic_reopened) && bound) {
        const mapping = await this.mapping(bound.id);
        await this.save(bound.id, { ...mapping, ...(message.forum_topic_deleted ? { deleted: true } : { topicClosed: Boolean(message.forum_topic_closed) }) });
        if (message.forum_topic_deleted) this.active.delete(bound.id);
        return;
      }
      const text = message.text?.trim();
      if (!text) return;
      const reasonKey = `${ctx.chatId}:${ctx.threadId}:${message.reply_to_message?.message_id}`;
      const reason = this.reasons.get(reasonKey);
      if (reason) {
        this.reasons.delete(reasonKey);
        if (reason.expires > Date.now()) {
          if (typeof reason.req.onReason === 'function') await reason.req.onReason(cut(text, 1000));
          else await this.send(ctx, 'Reason noted in Telegram only; DSH approval API accepts outcomes, not denial reasons.');
        }
        return;
      }
      const command = text.match(/^\/(\w+)(?:@\w+)?(?:\s|$)/)?.[1]?.toLowerCase();
      if (command === 'version') return await this.send(ctx, `Telegram Remote ${this.runtimeVersion || 'unknown'} · host ${this.runtimePid || 'unknown'}`);
      if (command === 'sessions' || command === 'start') {if(!await this.requireTopics(ctx))return;return await this.sessions(ctx);}
      if (command === 'new') return await this.requestNew(ctx);
      if (command === 'help') return await this.send(ctx, '/sessions — open a live DSH session\n/new — create session\n/status — fresh compact status\n/stop — stop this session\n/files — deliver artifacts\n/help\nSend prompts inside a bound session topic. Model selection is in the pinned card. Approvals support Allow once or Deny, never Always allow.');
      if (!bound && ctx.threadId && !command) { await this.bindNativeTopic(ctx, { text, requestId }); return; }
      if (!bound) return await this.send(ctx, 'Open a session with /sessions, or create a new topic in Telegram.');
      const metadata = await this.bridge.metadata(bound.id);
      if (!metadata) { await this.refresh(bound.id); return await this.send(ctx, 'Session gone in DSH. Use /new or /sessions.'); }
      if (command === 'status') return await this.status(bound.id, ctx);
      if (command === 'stop') { if (await this.running(bound.id)) await this.bridge.stop(bound.id); return; }
      if (command === 'files') {
        for (const file of await this.bridge.files(bound.id)) await this.api.document({ chatId: ctx.chatId, threadId: ctx.threadId, name: file.name, content: file.content, caption: file.name });
        return;
      }
      if (command) return await this.send(ctx, 'Unknown command. Use /help.');
      await this.bridge.prompt(bound.id, text, requestId);
      if (metadata.running) await this.send(ctx, 'Queued in DSH.', {reply_markup:{inline_keyboard:[[this.button('Steer now',ctx,{type:'steer',id:bound.id,requestId})]]}});
    } catch (e) {
      await this.send(ctx, `⚠ ${topicModeError(e)?TOPIC_MODE_HELP:gone(e) ? 'Session gone. Use /new or /sessions.' : cut(e.message, 500)}`, { disable_notification: false });
    }
  }

  async running(id) {
    if (this.active.has(id)) return true;
    return Boolean((await this.bridge.metadata(id))?.running);
  }
  refreshDrafts(...args) { return this.delivery.refreshDrafts(...args); }
  preview(...args) { return this.delivery.preview(...args); }
  onRun(...args) { return this.delivery.onRun(...args); }

  async approval(id, req = {}) {
    if (this.closed) return 'cancelled';
    const mapping = await this.mapping(id);
    if (!mapping || mapping.deleted) return 'unavailable';
    if (req.signal?.aborted) return 'cancelled';
    let resolve;
    const result = new Promise(r => { resolve = r; });
    const pending = { req, sessionId: id, done: false, finish: outcome => {
      if (pending.done) return;
      pending.done = true;
      pending.outcome = outcome;
      clearTimeout(pending.timer);
      req.signal?.removeEventListener('abort', pending.abort);
      this.pending.delete(pending);
      for (const [token, action] of this.actions) if (action.pending === pending) this.actions.delete(token);
      resolve(outcome);
      if (pending.messageId) void this.edit(mapping, pending.messageId, `Approval: ${outcome}`, { inline_keyboard: [] }).catch(() => {});
    } };
    pending.abort = () => pending.finish('cancelled');
    req.signal?.addEventListener('abort', pending.abort, { once: true });
    this.pending.add(pending);
    pending.timer = setTimeout(() => pending.finish('unavailable'), Math.min(req.timeoutMs || TTL, TTL));
    pending.timer.unref?.();
    try {
      await this.serial(id, async () => {
        if (pending.done || this.closed) { pending.finish('cancelled'); return; }
        const message = await this.send(mapping, formatApproval(req), {
          parse_mode: 'HTML',
          disable_notification: false,
          reply_markup: { inline_keyboard: [[this.button('Allow once', mapping, { type: 'approve', pending }), this.button('Deny', mapping, { type: 'deny', pending })]] }
        });
        pending.messageId = message.message_id;
        await this.latest(mapping, message.message_id);
        // Abort/timeout may win while Telegram is sending the card.
        if (pending.done) await this.edit(mapping, pending.messageId, `Approval: ${pending.outcome}`, { inline_keyboard: [] });
      });
    } catch { pending.finish('unavailable'); }
    return result;
  }
}

export default TelegramConsole;
