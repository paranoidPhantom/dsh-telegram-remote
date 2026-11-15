import { z } from 'zod';
import { readFile, unlink, writeFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, resolve } from 'node:path';
import { TelegramAdapter, pollUpdates } from './adapter.js';
import { createBridge } from './bridge.js';
import { TelegramConsole } from './console.js';
import { createWidgetPipeline } from './widget-pipeline.js';
import { createStreamScheduler } from './stream-scheduler.js';
import { RuntimeLifecycle } from './runtime-lifecycle.js';
import { createSettingsController, registerSettingsRoute } from './settings-host.js';
import { registerSendFile } from './send-file.js';

export const inject=['tools','webServer','connection','credentials','sessionController','sessionQuery','sessionProjections','storageDomain','workingDirectory','agents','fs','attachments','systemPrompt'];
const packageDir=fileURLToPath(new URL('.',import.meta.url));
export async function apply(ctx, config) {
  const bootstrap=config.bootstrapPath;
  const statusPath=config.statusPath??resolve(packageDir,'.runtime-status.json');
  const {version}=JSON.parse(await readFile(new URL('./package.json',import.meta.url),'utf8'));
  const startedAt=new Date().toISOString();
  const lifecycle=new RuntimeLifecycle(error=>report(error));const signal=lifecycle.signal;
  const timers=new Map();let lastError=null;let adminUserId=config.ownerId;
  const status=async extra=>{await writeFile(statusPath,JSON.stringify({version,startedAt,pid:process.pid,ownerId:adminUserId,credentialConfigured:(await ctx.credentials.describeRecord(config.credentialKey)).configured,lastError,...extra},null,2),{mode:0o600});};
  const report=error=>{lastError=String(error?.message??error).slice(0,700);void status({state:signal.aborted?'stopped':'degraded'}).catch(()=>{});};
  const launch=promise=>lifecycle.launch(promise);
  lifecycle.own(()=>{for(const timer of timers.values())clearTimeout(timer);timers.clear();});
  ctx.effect(()=>async()=>{await lifecycle.close();await status({state:'stopped',stoppedAt:new Date().toISOString()});});
  if(!Number.isSafeInteger(config.ownerId)||config.ownerId<0)throw Error('Telegram ownerId must be a non-negative integer; zero disables access until configured.');
  // One-time secret handoff, outside distributable package. No token in bundle config.
  if(bootstrap)try {
    const token=(await readFile(bootstrap,'utf8')).trim();
    if(!/^\d+:[A-Za-z0-9_-]+$/.test(token))throw Error('Malformed bootstrap token');
    await chmod(bootstrap,0o600);
    await ctx.credentials.modifyRecord(config.credentialKey,async()=>({kind:'api-key',key:token}));
    // Delete only the exact predeclared bootstrap path after durable credential acknowledgement.
    if(!bootstrap.endsWith('/.telegram-console-bootstrap')||!bootstrap.startsWith('/'))throw Error('Unexpected bootstrap path');
    await unlink(bootstrap);
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const domain=await ctx.storageDomain.open({name:'telegram_console_delivery',version:1,tables:{delivery:{valueSchema:z.json()}}});
  ctx.effect(()=>()=>domain.close());const table=domain.table('delivery');
  const store={get:async key=>table.get(key),set:(key,value)=>table.put(key,value),entries:async()=>[...table.entries()]};
  adminUserId=(await store.get('settings:adminUserId'))??config.ownerId;
  const api=new TelegramAdapter({credentials:ctx.credentials,credentialKey:config.credentialKey,signal});
  const bridge=await createBridge(ctx,signal);ctx.effect(()=>()=>bridge.dispose());
  const surface=new TelegramConsole({api,bridge,store,ownerId:adminUserId,signal});
  const settings=createSettingsController({credentials:ctx.credentials,credentialKey:config.credentialKey,store,getAdmin:()=>adminUserId,setAdmin:value=>{adminUserId=value;surface.ownerId=value;surface.actions.clear();surface.active.clear();}});
  registerSettingsRoute(ctx,settings);
  surface.runtimeVersion=version;surface.runtimePid=process.pid;
  registerSendFile(ctx,{api,surface});
  ctx.systemPrompt.section({name:'telegram-result-files',order:901,interpolate:false,text:'For a finished result file in a connected Telegram session, call send_file to deliver it as a document. Merely mentioning its path does not upload it.'});
  const widget=createWidgetPipeline({ctx,api,store,surface,signal});
  const streamScheduler=createStreamScheduler({deliver:(id,view)=>surface.onRun(id,view),onError:report});
  const heartbeat=setInterval(()=>{if(!signal.aborted)launch(surface.refreshDrafts());},4000);
  ctx.effect(()=>()=>{clearInterval(heartbeat);streamScheduler.close();surface.close();});
  const debounce=(key,fn,ms=600)=>{clearTimeout(timers.get(key));timers.set(key,setTimeout(()=>{timers.delete(key);if(!signal.aborted)launch(fn());},ms));};
  ctx.on('tools/result',(exec,result)=>{
    if(result.isError||!exec.agent)return;
    if(!['write','edit','apply_patch','write_file','edit_file'].includes(exec.name))return;
    const args=exec.arguments;
    const path=args?.file_path??args?.path;
    if(typeof path==='string'&&/^telegram_widget_.*\.html$/i.test(basename(path)))debounce(`widget:${exec.agent.id}:${path}`,()=>widget(exec.agent,path),200);
  });
  const streams=new Map();
  ctx.on('session/event',(session,event)=>{
    if(['turn/start','step/start','tool/call','tool/result','assistant/message','assistant/attempt','turn/end'].includes(event.type)){
      const view=bridge.runView(session);
      if(event.type==='tool/call')launch((async()=>{const topic=await surface.getTopic(session.id);if(topic)await api.typing({chat_id:topic.chatId,message_thread_id:topic.threadId});})());
      const stream=streams.get(session.id);
      if(event.type==='turn/end'&&stream?.turn===view.turn&&stream.text){view.partialAnswer=stream.text;view.partialId=stream.attempt;}
      streamScheduler.push(session.id,view,{immediate:event.type==='turn/start'||event.type==='turn/end'});
    }
    if(['session/title','model/selection','working-directory/change','turn/end'].includes(event.type))debounce(`card:${session.id}`,()=>surface.refresh(session.id));
  });
  ctx.on('agent/assistant-stream',({agent,frame})=>{
    if(frame.type==='start')streams.set(agent.id,{attempt:frame.attemptId,turn:frame.turn,text:''});
    if(frame.type==='chunk'&&frame.chunk.type==='text-delta'){
      const current=streams.get(agent.id);if(!current||current.attempt!==frame.attemptId)return;
      current.text+=frame.chunk.text;
      streamScheduler.push(agent.id,{...bridge.runView(agent.session),turn:current.turn,partialAnswer:current.text,partialId:current.attempt});
    }
    if(frame.type==='end')streams.delete(agent.id);
  });
  ctx.on('approval/request',async(req,next)=>{
    if(!await surface.getTopic(req.agent.id))return next();
    const call=req.agent.session.snapshotEvents().findLast(event=>event.type==='tool/call'&&event.data.callId===req.callId);
    return surface.approval(req.agent.id,{...req,title:req.toolName,callArgs:call?.data.arguments,description:req.displayReason?.en??req.reason??'DSH requests permission for this action.',signal:req.signal?AbortSignal.any([req.signal,signal]):signal});
  },{prepend:true});
  ctx.systemPrompt.section({name:'telegram-widget-authoring',order:900,interpolate:false,text:'Telegram output: to publish an interactive widget in a connected Telegram session, write telegram_widget_<name>.html inside the session workspace. Rewriting the same filename replaces its widget. Use self-contained HTML, inline CSS/classic JS, SVG/CSS charts, no network calls, no navigation or external fonts. Maximum 32 KiB UTF-8 and 4 KiB zlib-9. Widget queries are disabled. Controls and approvals remain owner-only Telegram buttons. See WIDGETS.md in the telegram console plugin for details.'});
  await status({state:'connecting'});
  launch((async()=>{
    while(!signal.aborted){
      try {
        if(!adminUserId||!(await ctx.credentials.describeRecord(config.credentialKey)).configured){
          await status({state:'unconfigured'});
          await new Promise(resolve=>{const timer=setTimeout(done,1000);function done(){clearTimeout(timer);signal.removeEventListener('abort',done);resolve();}signal.addEventListener('abort',done,{once:true});});
          continue;
        }
        const me=await api.call('getMe');surface.username=me.username;
        const webhook=await api.call('getWebhookInfo');if(webhook.url){await status({state:'offline',lastError:'Bot has an active webhook; remove it explicitly before starting console polling'});return;}
        lastError=null;
        await status({state:'running',botUsername:me.username,topicsEnabled:me.has_topics_enabled??me.is_forum??null});
        await pollUpdates({api,store,console:surface,signal,onError:report});return;
      }catch(error){if(signal.aborted)return;report(error);}
      await new Promise(resolve=>{const timer=setTimeout(done,60000);function done(){clearTimeout(timer);signal.removeEventListener('abort',done);resolve();}signal.addEventListener('abort',done,{once:true});});
    }
  })());
}
