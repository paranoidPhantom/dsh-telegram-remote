import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramAdapter, pollUpdates } from '../adapter.js';

test('adapter fails closed without configured credential', async()=>{
 const api=new TelegramAdapter({credentials:{readRecord:async()=>undefined},credentialKey:'bot'});
 await assert.rejects(api.call('getMe'),/not configured/);
});
test('adapter rejects unknown methods before network',async()=>{
 const api=new TelegramAdapter({credentials:{readRecord:async()=>({kind:'api-key',key:'123:fake'})},credentialKey:'bot'});
 await assert.rejects(api.call('notARealMethod'),/Unsupported/);
});
test('parameterless API methods receive AbortSignal as first argument',async()=>{
 const signal=new AbortController().signal;const calls=[];
 const api=new TelegramAdapter({credentials:{readRecord:async()=>({kind:'api-key',key:'123:fake'})},credentialKey:'bot',signal,createApi:()=>({getMe:async(...args)=>{calls.push(args);return {id:1};},getWebhookInfo:async(...args)=>{calls.push(args);return {};},sendMessage:async(...args)=>{calls.push(args);return {};}})});
 await api.call('getMe');await api.call('getWebhookInfo');await api.call('sendMessage',{chat_id:1,text:'test'});
 assert.deepEqual(calls[0],[signal]);assert.deepEqual(calls[1],[signal]);assert.deepEqual(calls[2],[{chat_id:1,text:'test'},signal]);
});
function fixture(handler,options={}) {
 let time=0;const waits=[],calls=[];
 const api=new TelegramAdapter({credentials:{readRecord:async()=>({kind:'api-key',key:'123:fake'})},credentialKey:'bot',now:()=>time,sleep:async ms=>{waits.push(ms);time+=ms;},createApi:(_token,config)=>{
   assert.equal(config.maxRetries,0);
   return new Proxy({}, {get:(_target,method)=>async(params,signal)=>{calls.push({method,params,time});return handler?.(method,params,signal) ?? true;}});
 },...options});
 return {api,waits,calls,now:()=>time};
}
test('429 records a shared cooldown in milliseconds without retrying the send',async()=>{
 let failed=false;
 const f=fixture(method=>{if(method==='sendMessage'&&!failed){failed=true;throw Object.assign(new Error('Too Many Requests: 123:fake'),{errorCode:429,retryAfter:65});}});
 await assert.rejects(f.api.call('sendMessage',{chat_id:1,text:'once'}),error=>error.code===429&&error.retryAfterMs===65000&&!error.message.includes('123:fake'));
 assert.equal(f.calls.length,1);
 await f.api.call('getUpdates');await f.api.call('answerCallbackQuery',{callback_query_id:'q'});
 assert.deepEqual(f.waits,[]);
 await f.api.call('editMessageReplyMarkup',{chat_id:2,message_id:1});
 assert.deepEqual(f.waits,[65000]);assert.equal(f.calls.at(-1).time,65000);
 assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,1);
});
test('429 supports parameter retry_after, message fallback and a safe missing-value default',async()=>{
 for(const [fields,ms] of [[{parameters:{retry_after:2}},2000],[{message:'Too Many Requests: retry after 65'},65000],[{},1000]]) {
   const f=fixture(()=>{throw Object.assign(new Error('rate limited'),{errorCode:429},fields);});
   await assert.rejects(f.api.call('sendMessage',{chat_id:1}),e=>e.retryAfterMs===ms);
   assert.equal(f.api.cooldownUntil,ms);assert.equal(f.calls.length,1);
 }
});
test('persistent sends keep a chat-wide 1100ms pace across topics',async()=>{
  const f=fixture();
  await f.api.call('sendMessage',{chat_id:1,message_thread_id:10});
  await f.api.call('sendDocument',{chat_id:1,message_thread_id:20});
  await f.api.call('sendMessage',{chat_id:2});
  assert.deepEqual(f.calls.map(c=>c.time),[0,1100,1100]);
  assert.deepEqual(f.waits,[1100]);
});
test('edits pace per message at 300ms separately from persistent sends',async()=>{
  const f=fixture();
  await f.api.call('sendMessage',{chat_id:1});
  await f.api.call('editMessageReplyMarkup',{chat_id:1,message_id:10});
  await f.api.call('editMessageText',{chat_id:1,message_id:20});
  await f.api.call('editMessageText',{chat_id:1,message_id:10});
  assert.deepEqual(f.calls.map(c=>c.time),[0,0,0,300]);
  assert.deepEqual(f.waits,[300]);
});
test('drafts pace per topic at 300ms and typing suppression is topic scoped',async()=>{
  const f=fixture();
  await f.api.call('sendMessageDraft',{chat_id:1,message_thread_id:10,draft_id:1});
  await f.api.call('sendChatAction',{chat_id:1,message_thread_id:10,action:'typing'});
  await f.api.call('sendChatAction',{chat_id:1,message_thread_id:20,action:'typing'});
  await f.api.call('sendMessageDraft',{chat_id:1,message_thread_id:30,draft_id:2});
  await f.api.call('sendMessageDraft',{chat_id:1,message_thread_id:10,draft_id:3});
  await f.api.call('editMessageReplyMarkup',{chat_id:1,message_id:5});
  assert.deepEqual(f.calls.map(c=>c.method),['sendMessageDraft','sendChatAction','sendMessageDraft','sendMessageDraft','editMessageReplyMarkup']);
  assert.deepEqual(f.calls.map(c=>c.time),[0,0,0,300,300]);
});
test('different topic drafts and message edits run while a persistent send is in flight',async()=>{
  let started,finish;
  const entered=new Promise(resolve=>{started=resolve;});
  const f=fixture(method=>{if(method==='sendMessage'){started();return new Promise(resolve=>{finish=resolve;});}});
  const send=f.api.call('sendMessage',{chat_id:1});await entered;
  await Promise.all([
    f.api.call('sendMessageDraft',{chat_id:1,message_thread_id:10}),
    f.api.call('sendMessageDraft',{chat_id:1,message_thread_id:20}),
    f.api.call('editMessageText',{chat_id:1,message_id:1}),
    f.api.call('editMessageText',{chat_id:1,message_id:2}),
  ]);
  assert.equal(f.calls.length,5);assert.deepEqual(f.waits,[]);
  finish(true);await send;
});
test('aborting a cooldown wait prevents the queued request',async()=>{
 const controller=new AbortController();let waiting;
 const entered=new Promise(resolve=>{waiting=resolve;});
 const f=fixture(()=>{throw Object.assign(new Error('retry after 65'),{errorCode:429});},{signal:controller.signal,sleep:()=>{waiting();return new Promise(()=>{});}});
 await assert.rejects(f.api.call('sendMessage',{chat_id:1}));
 const pending=f.api.call('sendMessage',{chat_id:2});await entered;controller.abort();
 await assert.rejects(pending,{name:'AbortError'});assert.equal(f.calls.length,1);
});
test('aborting a serialized queue does not start another network request',async()=>{
 const controller=new AbortController();let started;
 const entered=new Promise(resolve=>{started=resolve;});
 let finish;
 const f=fixture(()=>{started();return new Promise(resolve=>{finish=resolve;});},{signal:controller.signal});
 const first=f.api.call('sendMessage',{chat_id:1});await entered;
 const second=f.api.call('sendMessage',{chat_id:1});controller.abort();
 await assert.rejects(second,{name:'AbortError'});finish(true);await first;
 assert.equal(f.calls.length,1);
});
test('global concurrency is bounded at four while polls and callbacks bypass it',async()=>{
  let active=0,peak=0,ready;const finishes=[];
  const entered=new Promise(resolve=>{ready=resolve;});
  const f=fixture(method=>{
    if(method==='getUpdates'||method==='answerCallbackQuery')return true;
    active++;peak=Math.max(peak,active);
    if(active===4)ready();
    return new Promise(resolve=>finishes.push(()=>{active--;resolve(true);}));
  });
  const pending=Array.from({length:7},(_,i)=>f.api.call('sendMessage',{chat_id:i}));
  await entered;
  assert.equal(f.calls.length,4);assert.equal(f.api.outboundWaiters.length,3);
  await f.api.call('getUpdates');await f.api.call('answerCallbackQuery');
  assert.equal(f.calls.length,6);
  while(finishes.length||f.api.outboundWaiters.length){finishes.shift()?.();await new Promise(resolve=>setImmediate(resolve));}
  await Promise.all(pending);assert.equal(peak,4);
});
test('aborting a global semaphore wait removes queued work without sending',async()=>{
  const controller=new AbortController();let ready;const finishes=[];
  const entered=new Promise(resolve=>{ready=resolve;});
  const f=fixture(()=>new Promise(resolve=>{finishes.push(resolve);if(finishes.length===4)ready();}),{signal:controller.signal});
  const running=Array.from({length:4},(_,i)=>f.api.call('sendMessage',{chat_id:i}));
  await entered;
  const queued=f.api.call('sendMessage',{chat_id:10});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.api.outboundWaiters.length,1);controller.abort();
  await assert.rejects(queued,{name:'AbortError'});
  assert.equal(f.api.outboundWaiters.length,0);assert.equal(f.calls.length,4);
  finishes.forEach(resolve=>resolve(true));await Promise.all(running);
});
test('a queued outbound slot rechecks global 429 cooldown before sending',async()=>{
  let ready;const finishes=[];
  const entered=new Promise(resolve=>{ready=resolve;});
  const f=fixture(()=>new Promise((resolve,reject)=>{finishes.push({resolve,reject});if(finishes.length===4)ready();}));
  const running=Array.from({length:4},(_,i)=>f.api.call('sendMessage',{chat_id:i}));
  const failures=Promise.allSettled(running);
  await entered;
  const queued=f.api.call('sendMessageDraft',{chat_id:20,message_thread_id:1});
  await new Promise(resolve=>setImmediate(resolve));
  finishes[0].reject(Object.assign(new Error('rate limited'),{errorCode:429,retryAfter:2}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.at(-1).time,2000);assert.deepEqual(f.waits,[2000]);
  finishes.slice(1).forEach(({resolve})=>resolve(true));
  await failures;await queued;
});
test('poller uses durable offset and advances ignored updates',async()=>{
 const abort=new AbortController();const values=new Map();let calls=0,handled=0;
 await pollUpdates({api:{call:async(method,params)=>{assert.equal(method,'getUpdates');assert.equal(params.offset,0);calls++;return [{update_id:42,message:{}}];}},store:{get:async k=>values.get(k),set:async(k,v)=>{values.set(k,v);abort.abort();}},console:{handleUpdate:async()=>{handled++;}},signal:abort.signal,onError:e=>{throw e;}});
 assert.equal(calls,1);assert.equal(handled,1);assert.equal(values.get('poll-offset'),43);
});
