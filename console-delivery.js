import { randomBytes, createHash } from 'node:crypto';

const textHash = text => createHash('sha256').update(text).digest('hex');
const hasText = text => typeof text === 'string' && Boolean(text.trim());
const draftText = view => Object.hasOwn(view, 'partialAnswer') ? view.partialAnswer || '' : view.answer || '';
import { answerParts } from './answer-format.js';
import { relativePathText } from './path-display.js';
import { chunks, unsupportedDraft, missingTopic, toolLogPages } from './console-render.js';

/** Serialized run delivery, Telegram draft lifecycle and durable message ids. */
export class RunDelivery {
  constructor(console) {
    this.console = console;
    this.pageFrames = new Map();
    this.activations = new Map();
    this.heartbeats = new Map();
  }
  async refreshDrafts() {
    await Promise.all([...this.console.active].map(([id]) => {
      if (this.heartbeats.has(id)) return this.heartbeats.get(id);
      // Read the active view only when this queue slot runs. A queued heartbeat
      // must not replay an older frame after a newly admitted bridge update.
      const pending = this.console.serial(id, async () => {
        const run = this.console.active.get(id);
        if (run && !this.console.closed) await this.preview(await this.console.mapping(id),
          { id, draftId: run.draftId, ...await this.console.store.get(`console:run:${id}:${run.view.turn}`) }, run.view);
      }).finally(() => { if (this.heartbeats.get(id) === pending) this.heartbeats.delete(id); });
      this.heartbeats.set(id, pending);
      return pending;
    }));
  }
  pageKey(mapping, messageId) { return `${mapping.chatId}:${messageId}`; }
  // Only semantic control state belongs in a frame: opaque callback tokens are
  // intentionally regenerated only when a page actually needs delivery.
  frame(text, controls) { return textHash(JSON.stringify([text, controls])); }
  async log(mapping, delivery, view, key) {
    const start=delivery.logStart||0;
    const end=view.logEnd??(view.final||draftText(view)?(view.toolLog||[]).length:Math.max(start,(view.toolLog||[]).length-1));
    const pages = toolLogPages((view.toolLog||[]).slice(start,end), view.final, view.cwd);
    if (!pages.length) return;
    delivery.logMessageIds ||= !delivery.logStart && delivery.messageId && !delivery.answerPreview ? [delivery.messageId] : [];
    const current = await this.console.mapping(delivery.id);
    const owner = current?.latestControlMessageId;
    const lastId = delivery.logMessageIds.at(-1);
    const owns = !owner || owner === lastId || owner === delivery.messageId;
    for (let i = 0; i < pages.length; i++) {
      const controls = !view.final && owns && i === pages.length - 1;
      const signature = this.frame(pages[i], [controls, controls && this.console.draftsUnsupported]);
      const messageId = delivery.logMessageIds[i];
      const cacheKey = this.pageKey(mapping, messageId);
      const cached = this.pageFrames.get(cacheKey);
      // latest() may have cleared a cached keyboard while another surface owned
      // the controls. Reclaiming it requires a fresh keyboard even with same text.
      const cleared = controls && this.console.clearedMarkup?.has(cacheKey);
      if (messageId && cached === signature && !cleared) continue;
      const markup = controls ? this.console.controls(delivery.id, mapping, true) : { inline_keyboard: [] };
      if (messageId) {
        await this.console.api.call('editMessageText', { chat_id: mapping.chatId, message_id: messageId, text: pages[i], parse_mode: 'HTML', reply_markup: markup }).catch(error => {
          if (!/not modified/i.test(error.message)) throw error;
        });
      } else {
        const sent = await this.console.api.call('sendMessage', { ...this.console.params(mapping), text: pages[i], disable_notification: true, parse_mode: 'HTML', reply_markup: markup });
        delivery.logMessageIds.push(sent.message_id);
        await this.console.store.set(key, delivery);
      }
      const deliveredKey = this.pageKey(mapping, delivery.logMessageIds[i]);
      this.pageFrames.set(deliveredKey, signature);
      if (controls) this.console.clearedMarkup?.delete(deliveredKey);
    }
    // Reflow may compact pages when a running row becomes a shorter result.
    // All rows above were delivered before removing surplus old pages.
    while (delivery.logMessageIds.length > pages.length) {
      const messageId = delivery.logMessageIds.at(-1);
      await this.console.api.call('deleteMessage', { chat_id: mapping.chatId, message_id: messageId });
      delivery.logMessageIds.pop();
      this.pageFrames.delete(this.pageKey(mapping, messageId));
      await this.console.store.set(key, delivery);
    }
    // Logs are a separate durable surface. Native drafts contain only answers.
    if (!view.final && owns && owner !== delivery.logMessageIds.at(-1)) await this.console.latest(mapping, delivery.logMessageIds.at(-1));
  }
  async preview(mapping, delivery, view) {
    if (!mapping || mapping.deleted || delivery.final || delivery.superseded) return;
    const latestTool=!draftText(view)&&(view.toolLog||[]).length>(delivery.logStart||0)?view.toolLog.at(-1):null;
    const summary=latestTool?relativePathText(latestTool.summary||'',view.cwd):'';
    const prefix=latestTool?`🔧 ${latestTool.name}`:'';
    const previewText=latestTool?`${prefix}${summary?` — ${summary}`:''}`:draftText(view)||'Deep diving';
    const formatted=latestTool?{text:previewText.slice(0,4096),entities:summary?[{type:'code',offset:prefix.length+3,length:Math.min(summary.length,4096-prefix.length-3)}]:[]}:answerParts(previewText)[0];
    if(latestTool)formatted.entities.unshift({type:'custom_emoji',offset:0,length:2,custom_emoji_id:'5220046725493828505'});
    if (!this.console.draftsUnsupported) {
      try {
        await this.console.api.call('sendMessageDraft', { ...this.console.params(mapping), draft_id: delivery.draftId, ...formatted, can_stop: true });
        // Sending the draft can clear chat actions; renew typing afterward.
        if(this.console.api.typing)void this.console.api.typing(this.console.params(mapping)).catch(()=>{});
        return;
      } catch (e) { if (!unsupportedDraft(e)) throw e; this.console.draftsUnsupported = true; }
    }
    await this.console.api.call('sendChatAction', { ...this.console.params(mapping), action: 'typing' });
    if (delivery.logMessageIds?.includes(delivery.messageId)) {
      // This fallback is answer-only and must not steal/clear log Stop controls.
      const sent = await this.console.api.call('sendMessage', { ...this.console.params(mapping), text: 'Deep diving', disable_notification: true });
      delivery.messageId = sent.message_id;
      delivery.answerPreview = true;
    }
    const current = await this.console.mapping(delivery.id);
    const text = chunks(draftText(view) || 'Deep diving')[0];
    const controls = current?.latestControlMessageId === delivery.messageId;
    const key = this.pageKey(mapping, delivery.messageId);
    const signature = this.frame(text, [controls, controls && this.console.draftsUnsupported]);
    if (this.pageFrames.get(key) === signature && !(controls && this.console.clearedMarkup?.has(key))) return;
    await this.console.edit(mapping, delivery.messageId, text, controls ? this.console.controls(delivery.id, mapping, true) : { inline_keyboard: [] });
    this.pageFrames.set(key, signature);
  }
  // Telegram accepted sends must be recorded before moving/clearing controls.
  async cosmetic(task) { try { await task(); } catch { /* Never gate output on cosmetics. */ } }
  async sendRecorded(mapping, delivery, key, text, extra, ids) {
    const sent = await this.console.api.call('sendMessage', { ...this.console.params(mapping), text, disable_notification: true, ...extra });
    ids.push(sent.message_id);
    await this.console.store.set(key, delivery);
    return sent;
  }
  async output(mapping, delivery, key, output, final) {
    delivery.outputs ||= [];
    let record = delivery.outputs.find(item => item.id === output.id);
    if (record?.pending) throw new Error(`Telegram output delivery ${output.id} is ambiguous; automatic resend suppressed`);
    if (record?.complete) return;
    if (!record) {
      record = { id: output.id, hash: textHash(output.text), messageIds: [] };
      delivery.outputs.push(record);
    }
    const parts = answerParts(output.text);
    for (let i = record.messageIds.length; i < parts.length; i++) {
      // An interrupted/ambiguous request must not be replayed by a heartbeat.
      record.pending = true;
      await this.console.store.set(key, delivery);
      await this.sendRecorded(mapping, delivery, key, parts[i].text, {
        entities: parts[i].entities, disable_notification: i > 0,
        ...(i === parts.length - 1 ? { reply_markup: this.console.controls(delivery.id, mapping, !final) } : {})
      }, record.messageIds);
      record.pending = false;
      await this.console.store.set(key, delivery);
    }
    record.complete = true;
    delivery.lastOutputHash = record.hash;
    await this.console.store.set(key, delivery);
    await this.cosmetic(() => this.console.latest(mapping, record.messageIds.at(-1)));
  }
  async completedOutput(mapping,delivery,key,output,view) {
    const known=delivery.outputs?.find(item=>item.id===output.id);
    if(known?.complete)return;
    const boundary=Number.isInteger(output.toolCount)?output.toolCount:(view.toolLog||[]).length;
    // Seal this segment before publishing the text. Subsequent calls get new IDs.
    await this.cosmetic(()=>this.log(mapping,delivery,{...view,logEnd:boundary,final:true},key));
    await this.output(mapping,delivery,key,output,Boolean(view.final));
    delivery.sealedLogMessageIds=[...new Set([...(delivery.sealedLogMessageIds||[]),...(delivery.logMessageIds||[])])];
    delivery.logStart=boundary;
    delivery.logMessageIds=[];
    await this.console.store.set(key,delivery);
  }
  async finishPreview(mapping, delivery, view) {
    // Retire only transient controls, never the durable answer toolbar.
    const lastOutput=delivery.outputs?.filter(output=>output.complete).at(-1)?.messageIds?.at(-1);
    if(lastOutput){
      await this.cosmetic(()=>this.console.api.call('editMessageReplyMarkup',{chat_id:mapping.chatId,message_id:lastOutput,reply_markup:this.console.finalControls(delivery.id,mapping,view)}));
      await this.cosmetic(()=>this.console.latest(mapping,lastOutput));
      this.console.clearedMarkup?.delete(this.pageKey(mapping,lastOutput));
    }
    if(delivery.messageId&&delivery.messageId!==lastOutput)await this.cosmetic(()=>this.console.clearMarkup(mapping,delivery.messageId));
    if (delivery.messageId && !delivery.logMessageIds?.includes(delivery.messageId) && !delivery.sealedLogMessageIds?.includes(delivery.messageId)) {
      await this.cosmetic(() => this.console.api.call('deleteMessage', { chat_id: mapping.chatId, message_id: delivery.messageId }));
    }
  }
  async onRun(id, view) {
    if (this.console.closed) return;
    if (view.turn == null) throw new TypeError('onRun requires a stable view.turn');
    // Snapshot at admission, not after awaiting storage: a subsequent turn must
    // capture and retire its actual predecessor in queue order.
    view = structuredClone(view);
    return this.console.serial(id, async () => {
      let mapping = await this.console.mapping(id);
      if (!mapping || mapping.deleted || this.console.closed) return;
      const key = `console:run:${id}:${view.turn}`;
      let delivery = await this.console.store.get(key);
      if (delivery?.final || delivery?.superseded) return;
      const previous = this.console.active.get(id);
      if (mapping.activeTurn != null && String(mapping.activeTurn) !== String(view.turn) && !previous) {
        const prior = await this.console.store.get(`console:run:${id}:${mapping.activeTurn}`);
        if (prior && !prior.final) await this.console.store.set(`console:run:${id}:${mapping.activeTurn}`, { ...prior, superseded: true });
      }
      const retired = [];
      if (!delivery) {
        // One migration sweep per topic activation; later turns only retire the
        // current owner. Never rescan all historical runs on every new turn.
        const activation = `${mapping.chatId}:${mapping.threadId || 0}`;
        if (this.activations.get(id) !== activation) {
          for (const [oldKey, old] of await this.console.store.entries()) {
            if (!oldKey.startsWith(`console:run:${id}:`)) continue;
            retired.push(old.messageId, ...(old.logMessageIds || []), ...(old.finalMessageIds || []), ...(old.outputs || []).flatMap(output => output.messageIds));
            if (!old.final && !old.superseded) await this.console.store.set(oldKey, { ...old, superseded: true });
          }
          this.activations.set(id, activation);
        } else if (previous && previous.view.turn !== view.turn) {
          const priorKey = `console:run:${id}:${previous.view.turn}`;
          const prior = await this.console.store.get(priorKey);
          if (prior && !prior.final && !prior.superseded) await this.console.store.set(priorKey, { ...prior, superseded: true });
        }
        if (previous && previous.view.turn !== view.turn) this.console.active.delete(id);
        retired.push(mapping.latestControlMessageId || mapping.cardId);
        delivery = { id, draftId: randomBytes(4).readUInt32BE(0) || 1, chatId: mapping.chatId, threadId: mapping.threadId };

        mapping = { ...await this.console.mapping(id), activeTurn: view.turn };
        await this.console.save(id, mapping);
        await this.console.store.set(key, delivery);
      }
      try {
        if (!view.toolLog?.length && previous?.view.turn === view.turn) view.toolLog = previous.view.toolLog;
        for (const output of view.outputs || []) {
          if (typeof output.id === 'string' && hasText(output.text)) await this.completedOutput(mapping, delivery, key, output, view);
        }
        if (!view.final) {
          this.console.active.set(id, { view, draftId: delivery.draftId });
          if (!delivery.messageId) {
            const sent = await this.console.api.call('sendMessage', { ...this.console.params(mapping), text: 'Deep diving', disable_notification: true, reply_markup: this.console.controls(id, mapping, true) });
            delivery.messageId = sent.message_id;
            await this.console.store.set(key, delivery);
            await this.cosmetic(() => this.console.latest(mapping, sent.message_id));
          }
          await this.cosmetic(() => this.log(mapping, delivery, view, key));
          for (const messageId of new Set(retired)) await this.cosmetic(() => this.console.clearMarkup(mapping, messageId));
          const unsupported = this.console.draftsUnsupported;
          await this.cosmetic(() => this.console.preview(mapping, delivery, view));
          if (!unsupported && this.console.draftsUnsupported) await this.cosmetic(() => this.log(mapping, delivery, view, key));
          await this.console.store.set(key, delivery);
          return;
        }
        // Committed messages are already durable. A stopped current attempt is
        // separate output, even when an earlier assistant message was delivered.
        const stopped = /stop|cancel|abort/i.test(view.status || '');
        const partial = stopped && hasText(view.partialAnswer) ? view.partialAnswer : '';
        if (partial && textHash(partial) !== delivery.lastOutputHash) {
          await this.output(mapping, delivery, key, { id: `partial:${view.partialId || view.turn}`, text: partial }, true);
        }
        const hasOutputs = (view.outputs || []).some(output => hasText(output.text));
        if (hasOutputs || partial) {
          this.console.active.delete(id);
          delivery.final = true;
          await this.console.store.set(key, delivery);
          for (const messageId of new Set(retired)) await this.cosmetic(() => this.console.clearMarkup(mapping, messageId));
          await this.cosmetic(() => this.log(mapping, delivery, view, key));
          await this.finishPreview(mapping, delivery, view);
          return;
        }
        // Persist each sent chunk before proceeding: retries never resend an
        // already delivered answer prefix, and failure never deletes the preview.
        const parts = answerParts(view.answer || (/fail|error/i.test(view.status || '') ? 'Unable to complete the request.' : /stop|cancel/i.test(view.status || '') ? 'Stopped.' : 'No answer returned.'));
        delivery.finalMessageIds ||= [];
        this.console.active.delete(id);

        if (this.console.draftsUnsupported && delivery.messageId && parts.length === 1 && !delivery.finalMessageIds.length) {
          await this.console.api.call('editMessageText', {chat_id:mapping.chatId,message_id:delivery.messageId,...parts[0],reply_markup:this.console.finalControls(id,mapping,view)});
          await this.console.store.set(key, { ...delivery, final: true, finalMessageIds: [delivery.messageId] });
          await this.cosmetic(() => this.console.latest(mapping, delivery.messageId));
          for (const messageId of new Set(retired)) await this.cosmetic(() => this.console.clearMarkup(mapping, messageId));
          await this.cosmetic(() => this.log(mapping, delivery, view, key));
          return;
        }
        for (let i = delivery.finalMessageIds.length; i < parts.length; i++) {
          await this.sendRecorded(mapping, delivery, key, parts[i].text, { entities:parts[i].entities, disable_notification: i > 0,
            ...(i === parts.length - 1 ? { reply_markup: this.console.finalControls(id, mapping, view) } : {}) }, delivery.finalMessageIds);
        }
        await this.console.store.set(key, { ...delivery, final: true });
        await this.cosmetic(() => this.console.latest(mapping, delivery.finalMessageIds.at(-1)));
        for (const messageId of new Set(retired)) await this.cosmetic(() => this.console.clearMarkup(mapping, messageId));
        await this.cosmetic(() => this.log(mapping, delivery, view, key));
        if (delivery.messageId && !delivery.logMessageIds?.includes(delivery.messageId) && !delivery.sealedLogMessageIds?.includes(delivery.messageId)) {
          try { await this.console.api.call('deleteMessage', { chat_id: mapping.chatId, message_id: delivery.messageId }); }
          catch { /* Final is safely delivered. Retain an inert preview if deletion fails. */ }
        }
      } catch (e) {
        if (!missingTopic(e)) throw e;
        await this.console.save(id, { ...mapping, deleted: true });
        this.console.active.delete(id);
      }
    });
  }

}
