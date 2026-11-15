import { Api, InputFile } from 'node-telegram-bot-api';
import { mediaKind } from './media-kind.js';
import https from 'node:https';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

// Also abort queue waits, not just the HTTP request or cooldown timer.
function abortable(promise,signal) {
  if(!signal)return promise;
  if(signal.aborted)return Promise.reject(signal.reason ?? new DOMException('Aborted','AbortError'));
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason ?? new DOMException('Aborted','AbortError'));
    signal.addEventListener('abort',abort,{once:true});
    promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}

// Node fetch stalls on this host's Telegram route; preserve the library's
// serialization and cancellation using a native IPv4 HTTPS carrier.
export async function telegramFetch(url, init) {
  const target=new URL(url);
  if(target.origin!=='https://api.telegram.org')throw Error('Unexpected Telegram API origin');
  const request=new Request(url,init);
  return new Promise((resolve,reject)=>{
    const req=https.request(target,{method:request.method,headers:Object.fromEntries(request.headers),family:4,signal:request.signal},res=>{
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>8*1024*1024)res.destroy(Error('Telegram response exceeds limit'));else chunks.push(chunk);});
      res.on('error',reject);res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
    });
    req.on('error',reject);
    if(request.body)Readable.fromWeb(request.body).on('error',e=>req.destroy(e)).pipe(req);else req.end();
  });
}

export class TelegramAdapter {
  constructor({credentials,credentialKey,signal,createApi=(token,options)=>new Api(token,options),now=Date.now,sleep=(ms,signal)=>delay(ms,undefined,{signal})}) {
    Object.assign(this,{credentials,credentialKey,signal,createApi,now,sleep});
    this.cooldownUntil=0;this.lanes=new Map();
    this.outboundActive=0;this.outboundWaiters=[];
  }
  async waitUntil(deadline) {
    for(;;) {
      this.signal?.throwIfAborted();
      const ms=deadline()-this.now();
      if(ms<=0)return;
      await abortable(this.sleep(ms,this.signal),this.signal);
    }
  }
  async call(method,params={}) {
    this.signal?.throwIfAborted();
    // Polling (including native stop updates) and callback acknowledgements must
    // stay responsive while outbound sends are cooling down.
    const bypass=method==='getUpdates'||method==='answerCallbackQuery';
    if(bypass)return this.request(method,params);
    // Persistent sends retain the conservative chat-wide pace. Live updates do
    // not sit behind them: edits are per message, drafts/actions per topic.
    const topicKey=JSON.stringify(['topic',String(params.chat_id),String(params.message_thread_id ?? 0)]);
    const draft=method==='sendMessageDraft';
    const action=method==='sendChatAction';
    const edit=method.startsWith('edit');
    const mutation=params.chat_id!=null && /^(send|edit|delete|forward|copy|pin|unpin)/.test(method);
    const key=edit?JSON.stringify(['edit',String(params.chat_id ?? ''),String(params.message_id ?? params.inline_message_id ?? '')]):
      draft||action?topicKey:mutation?JSON.stringify(['chat',String(params.chat_id)]):null;
    if(key===null)return this.request(method,params);
    for(const [id,lane] of this.lanes) {
      if(!lane.pending&&Math.max(lane.next,lane.draftUntil)<=this.now())this.lanes.delete(id);
    }
    let lane=this.lanes.get(key);
    if(!lane){lane={tail:Promise.resolve(),next:0,draftUntil:0,pending:0};this.lanes.set(key,lane);}
    lane.pending++;
    const previous=lane.tail;
    let release;
    lane.tail=new Promise(resolve=>{release=resolve;});
    try {
      await abortable(previous,this.signal);
      if(action&&params.action==='typing'&&lane.draftUntil>this.now())return true;
      await this.waitUntil(()=>Math.max(this.cooldownUntil,lane.next));
      const result=await this.request(method,params,()=>{lane.next=this.now()+(draft||action||edit?300:1100);});
      if(draft)lane.draftUntil=this.now()+5000;
      return result;
    } finally {
      // Keep the predecessor chain intact even if a queued caller aborts.
      previous.then(()=>{lane.pending--;release();},()=>{lane.pending--;release();});
    }
  }
  async acquireOutbound() {
    this.signal?.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const grant=()=>{
        this.signal?.removeEventListener('abort',abort);
        this.outboundActive++;
        let released=false;
        resolve(()=>{
          if(released)return;released=true;
          this.outboundActive--;
          this.outboundWaiters.shift()?.();
        });
      };
      const abort=()=>{
        const index=this.outboundWaiters.indexOf(grant);
        if(index>=0)this.outboundWaiters.splice(index,1);
        reject(this.signal.reason ?? new DOMException('Aborted','AbortError'));
      };
      if(this.outboundActive<4)grant();
      else {this.outboundWaiters.push(grant);this.signal?.addEventListener('abort',abort,{once:true});}
    });
  }
  async request(method,params,onStart) {
    this.signal?.throwIfAborted();
    const record=await this.credentials.readRecord(this.credentialKey);
    this.signal?.throwIfAborted();
    if(record?.kind!=='api-key'||!record.key) throw Error('Telegram bot credential is not configured');
    // Never automatically retry non-idempotent sends after an ambiguous transport failure.
    const api=this.createApi(record.key,{fetch:telegramFetch,maxRetries:0,timeoutMs:40000});
    if(typeof api[method]!=='function')throw Error(`Unsupported Telegram method: ${method}`);
    const bypass=method==='getUpdates'||method==='answerCallbackQuery';
    const release=bypass?()=>{}:await this.acquireOutbound();
    try {
      if(!bypass)await this.waitUntil(()=>this.cooldownUntil);
      this.signal?.throwIfAborted();
      onStart?.();
      return await (['getMe','getWebhookInfo','logOut','close'].includes(method)?api[method](this.signal):api[method](params,this.signal));
    }catch(error){
      this.signal?.throwIfAborted();
      const message=String(error.description ?? error.message ?? 'Telegram request failed').replaceAll(record.key,'[redacted]');
      const safe=new Error(`${method}: ${message}`);safe.code=error.errorCode ?? error.code;
      if(Number(safe.code)===429 || /\b429\b|too many requests|retry[ _-]?after/i.test(message)) {
        const seconds=Number(error.retryAfter ?? error.parameters?.retry_after ?? message.match(/retry[ _-]?after\s*[:=]?\s*(\d+(?:\.\d+)?)/i)?.[1]);
        safe.retryAfterMs=Number.isFinite(seconds)&&seconds>0?Math.ceil(seconds*1000):1000;
        this.cooldownUntil=Math.max(this.cooldownUntil,this.now()+safe.retryAfterMs);
        safe.code=429;
      }
      throw safe;
    } finally {release();}
  }
  async typing(params) {
    const key=`typing:${params.chat_id}:${params.message_thread_id||0}`;
    this.typingTimes??=new Map();
    if((this.typingTimes.get(key)||0)>this.now())return;
    this.typingTimes.set(key,this.now()+4000);
    await this.request('sendChatAction',{...params,action:'typing'});
  }
  async file(options) {
    const {chatId,threadId,name,content,caption}=options;
    const kind=mediaKind(name,content);
    if(kind==='document')return this.document(options);
    const method={photo:'sendPhoto',animation:'sendAnimation',video:'sendVideo',audio:'sendAudio'}[kind];
    try{return await this.call(method,{chat_id:chatId,...threadId?{message_thread_id:threadId}:{},[kind]:new InputFile(content,{filename:name}),caption:caption?.slice(0,1024),protect_content:true,...kind==='video'?{supports_streaming:true}:{}});}
    catch(error){
      // Only a definitive media-format rejection is safe to retry as a document.
      if(!/PHOTO_INVALID|IMAGE_PROCESS_FAILED|VIDEO_CONTENT_TYPE_INVALID|AUDIO_CONTENT_TYPE_INVALID|wrong type of the web page content|failed to process/i.test(error.message))throw error;
      return this.document(options);
    }
  }
  async document({chatId,threadId,name,content,caption}) {
    return this.call('sendDocument',{chat_id:chatId,...threadId?{message_thread_id:threadId}:{},document:new InputFile(content,{filename:name}),caption:caption?.slice(0,1024),protect_content:true});
  }
}
export async function pollUpdates({api,store,console:surface,signal,onError}) {
  let failures=0;
  while(!signal.aborted) {
    try {
      const offset=(await store.get('poll-offset')) ?? 0;
      const updates=await api.call('getUpdates',{offset,timeout:25,allowed_updates:['message','callback_query','stopped_message_generation']});
      for(const update of updates) {
        if(signal.aborted)return;
        try {await surface.handleUpdate(update);}catch(error){onError(error);}
        // Prompts use stable Telegram update ids as DSH idempotency keys.
        await store.set('poll-offset',update.update_id+1);
      }
      failures=0;
    } catch(error) {
      if(signal.aborted)return;
      onError(error);
      await new Promise(resolve=>{const timer=setTimeout(done,Math.min(60000,1000*2**Math.min(failures++,6)));function done(){clearTimeout(timer);signal.removeEventListener('abort',done);resolve();}signal.addEventListener('abort',done,{once:true});});
    }
  }
}
