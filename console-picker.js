import { PAGE, cut, label } from './console-render.js';

/** Live catalog/session navigation; owns no DSH preferences. */
export class ConsolePicker {
  constructor(console) { this.console = console; }
  async page(ctx, messageId, text, rows) {
    const reply_markup = { inline_keyboard: rows };
    const result = messageId ? await this.console.edit(ctx, messageId, text, reply_markup) : await this.console.send(ctx, text, { reply_markup });
    await this.console.latest(ctx, messageId || result.message_id);
    return result;
  }
  navigation(ctx, page, total, action) {
    const rows = [];
    if (page > 0) rows.push(this.console.button('‹ Previous', ctx, { ...action, page: page - 1 }));
    if ((page + 1) * PAGE < total) rows.push(this.console.button('Next ›', ctx, { ...action, page: page + 1 }));
    return rows.length ? [rows] : [];
  }
  async sessions(ctx, page = 0, messageId) {
    const sessions = await this.console.bridge.list(); // Always live, including pagination.
    page = Math.min(Math.max(0, page), Math.max(0, Math.ceil(sessions.length / PAGE) - 1));
    const rows = [];
    for (const session of sessions.slice(page * PAGE, (page + 1) * PAGE)) {
      let mapping = await this.console.mapping(session.id);
      const text = `${session.running ? '▶ ' : ''}${session.title || session.id}${label(session.model) ? ` · ${label(session.model)}` : ''}`;
      rows.push([this.console.username && mapping && !mapping.deleted
        ? { text: cut(text, 60), url: `https://t.me/${this.console.username.replace(/^@/, '')}/${mapping.threadId}` }
        : this.console.button(text, ctx, { type: 'open', id: session.id })]);
    }
    rows.push([this.console.button('New session', ctx, {type:'new'})]);
    rows.push(...this.console.navigation(ctx, page, sessions.length, { type: 'sessions' }));
    return this.console.page(ctx, messageId, sessions.length ? `DSH sessions · page ${page + 1}` : 'No sessions. Use /new.', rows);
  }
  async providers(id, ctx, page = 0, messageId) {
    const models = await this.console.bridge.models();
    const metadata = await this.console.bridge.metadata(id);
    const providers = [...new Set(models.map(m => m.provider))];
    page = Math.max(0, Math.min(page, Math.max(0, Math.ceil(providers.length / PAGE) - 1)));
    const rows = providers.slice(page * PAGE, (page + 1) * PAGE).map(provider => [this.console.button(`${metadata?.selection?.provider === provider ? '✓ ' : ''}${provider}`, ctx, { type: 'models', id, provider, page: 0 })]);
    rows.push(...this.console.navigation(ctx, page, providers.length, { type: 'providers', id, picker: true }));
    if (this.console.draftsUnsupported && await this.console.running(id)) rows.push([this.console.button('⏹ Stop', ctx, { type: 'stop', id })]);
    return this.console.page(ctx, messageId, 'Choose provider (live DSH catalog)', rows);
  }
  async models(id, ctx, provider, page = 0, messageId, notice = '', metadata) {
    metadata ??= await this.console.bridge.metadata(id);
    const models = (await this.console.bridge.models()).filter(m => m.provider === provider);
    page = Math.max(0, Math.min(page, Math.max(0, Math.ceil(models.length / PAGE) - 1)));
    const visible = models.slice(page * PAGE, (page + 1) * PAGE);
    const selected = m => metadata?.selection?.provider === provider && metadata?.selection?.model === m.id;
    const rows = visible.map(m => [this.console.button(`${selected(m) ? '✓ ' : ''}${m.name || m.id}`, ctx, { type: 'select', id, provider, model: m.id, page })]);
    rows.push(...this.console.navigation(ctx, page, models.length, { type: 'models', id, provider }));
    rows.push([this.console.button('‹ Providers', ctx, { type: 'providers', id, page: 0, picker: true }), ...(this.console.draftsUnsupported && await this.console.running(id) ? [this.console.button('⏹ Stop', ctx, { type: 'stop', id })] : [])]);
    return this.console.page(ctx, messageId, cut(`${provider} · page ${page + 1}${notice ? `\n${notice}` : ''}\n${visible.map(m => `${selected(m) ? '✓ ' : ''}${m.name || m.id}${m.description ? ` — ${m.description}` : ''}`).join('\n')}`), rows);
  }

  select(action, ctx, messageId) {
    // The callback spinner is already answered by the router. Never recursively
    // enter the session queue (refresh uses it too).
    return this.console.serial(action.id, async () => {
      const prior = await this.console.bridge.metadata(action.id);
      let metadata = prior, notice = '';
      try {
        const ack = await this.console.bridge.selectModel(action.id, { provider: action.provider, model: action.model });
        if (!ack || ack.ok === false || ack.accepted === false || ack.success === false || ack.error) throw new Error(ack?.error || ack?.reason || 'DSH did not acknowledge selection');
        metadata = await this.console.bridge.metadata(action.id);
        if (metadata?.selection?.provider !== action.provider || metadata?.selection?.model !== action.model) {
          metadata = prior;
          throw new Error('DSH has not confirmed this selection yet');
        }
        notice = ack.appliesNextTurn ? 'Applies next turn.' : ack.running || ack.deferred ? 'Applies at the next DSH step boundary.' : '';
      } catch (error) {
        metadata = prior;
        notice = `⚠ Model unchanged: ${cut(error.message, 240)}`;
      }
      return this.models(action.id, ctx, action.provider, action.page || 0, messageId, notice, metadata);
    });
  }
}
