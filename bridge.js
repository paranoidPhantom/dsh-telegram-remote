import { readTouchedFile, workspaceTouched } from './touched-files.js';
import { textOf, runProjection, initialRun, foldRun } from './run-projection.js';
import { newSessionSelection } from './session-selection.js';
export { textOf, initialRun, foldRun } from './run-projection.js';
export async function createBridge(ctx, signal) {
  const run = await ctx.sessionProjections.register(runProjection);
  const controller = ctx.sessionController;
  const address = id => ({kind:'session',sessionId:id});
  const bridge = {
    async list() {
      const {items} = await controller.list({},signal);
      return items.filter(x=>!x.parentSessionId).map(x=>({id:x.sessionId,title:x.projections?.values?.title || `Session ${x.sessionId.slice(-8)}`,running:x.running,cwd:x.cwd,lastActivity:x.updatedAt,model:x.projections?.values?.modelSelection?.next?.model ?? 'Not selected'}));
    },
    async metadata(id) {
      const observation = await ctx.sessionQuery.observeSession(id,{signal,projectionMode:'all'});
      try {
        const p=observation.projections?.values ?? {};
        const state=await controller.state({sessionId:id},signal);
        const selection=p.modelSelection?.next??p.modelSelection?.pending??p.modelSelection?.lastUsed??null;
        return {id,selection,title:p.title || `Session ${id.slice(-8)}`,model:(p.modelSelection?.next??p.modelSelection?.pending??p.modelSelection?.lastUsed)?.model ?? 'Not selected',activeModel:p.modelSelection?.lastUsed?.model ?? 'Not used yet',turns:p.sessionStats?.turns ?? p.turnBoundary?.lastTurn ?? null,context:p.contextPressure ?? null,cwd:p.workingDirectory ?? observation.header.cwd ?? ctx.workingDirectory.defaultDirectory,lastActivity:observation.events.at(-1)?.time ?? observation.header.createdAt,running:state.running,queue:state.queue,pendingInput:state.pendingInput};
      } finally {observation[Symbol.dispose]();}
    },
    async models() { const catalog=await controller.modelCatalog(); return catalog.groups.flatMap(g=>g.models.map(m=>({provider:g.id,providerName:g.name,id:m.id,name:m.name,description:m.description}))); },
    async selectModel(id,selection) {const ack=await controller.selectModel({sessionId:id,...selection});const state=await controller.state({sessionId:id},signal);return {...ack.selected,appliesAtNextStep:state.running};},
    async newSessionSelection(sourceId) {return newSessionSelection({controller,metadata:id=>bridge.metadata(id),signal},sourceId);},
    async create() {return (await controller.create({})).sessionId;},
    async prompt(id,text,requestId) {return controller.prompt({sessionId:id,requestId,mode:'queue',content:[{type:'text',text}]},signal);},
    async steerQueued(id,requestId) {
      const state=await controller.state({sessionId:id},signal);
      const item=state.queue?.find(item=>item.rpcId===requestId);
      if(!item)return {accepted:false,reason:'This message has already left the queue.'};
      if(item.placement==='steering')return {accepted:true};
      return controller.updateQueue({sessionId:id,itemId:item.id,action:{kind:'steer'}});
    },
    async stop(id) {return controller.cancel({sessionId:id});},
    async details(id) {
      const page=await controller.events({address:address(id),maxMessages:30},signal);
      const events=page.records.map(x=>x.event);const start=events.findLastIndex(e=>e.type==='turn/start');const recent=start>=0?events.slice(start):events;
      const tools=recent.filter(e=>e.type==='tool/call').map(e=>e.data.name);const failed=recent.filter(e=>e.type==='tool/result'&&e.data.error).length;
      const first=recent[0]?.time,last=recent.at(-1)?.time;
      return [tools.length?`${tools.length} tool ${tools.length===1?'call':'calls'} · ${[...new Set(tools)].join(', ')}`:'No tool calls',failed?`${failed} tool ${failed===1?'failure':'failures'}`:'',first&&last?`Elapsed: ${Math.max(0,(last-first)/1000).toFixed(1)} s`:'',page.hasMore?'Recent activity only':''].filter(Boolean).join('\n');
    },
    async files(id) {
      const observation=await ctx.sessionQuery.observeSession(id,{signal,projectionMode:'none'});
      try {
        const refs=new Map();
        for (const e of observation.events) if(e.type==='tool/result') for(const b of e.data.message.content??[]) if(b.type==='file') refs.set(b.attachment.attachmentId,b.attachment);
        const results=[];
        for(const ref of [...refs.values()].slice(-10)) {if(ref.bytes>10*1024*1024)continue; const chunks=[];let size=0;for await(const bytes of ctx.attachments.readFileStream(ref,signal)){size+=bytes.length;if(size>10*1024*1024)throw Error('Artifact exceeds upload limit');chunks.push(bytes);}results.push({name:ref.name,content:Buffer.concat(chunks)});}
        return results;
      }finally{observation[Symbol.dispose]();}
    },
    touchedFiles(session) {
      const state=run.stateOf(session);
      return workspaceTouched(state,session.id,ctx.get?.('workspaceChanges'));
    },
    async fileForTurn(id,turn,filePath) {
      if(!Number.isSafeInteger(turn)||turn<1||typeof filePath!=='string')throw Error('Invalid turn file request');
      const observation=await ctx.sessionQuery.observeSession(id,{signal,projectionMode:'all'});
      try {
        let state=initialRun(), selected=null;
        for(const event of observation.events) {
          if(event.type==='turn/start' && state.turn===turn){selected=state;break;}
          state=foldRun(state,event);
        }
        selected??=state.turn===turn?state:null;
        const file=selected && workspaceTouched(selected,id,ctx.get?.('workspaceChanges')).find(item=>item.path===filePath);
        if(!file)throw Error('File was not successfully touched in this turn');
        const cwd=observation.header.cwd ?? ctx.workingDirectory.defaultDirectory;
        return await readTouchedFile(ctx,{cwd,file,events:observation.events,signal});
      }finally{observation[Symbol.dispose]();}
    },
    runView(session) {const s=run.stateOf(session);return {...s,cwd:ctx.workingDirectory.get(session),touchedFiles:bridge.touchedFiles(session),elapsed:Math.max(0,((s.ended||Date.now())-s.started)/1000)};},
    async dispose(){await run.dispose();}
  };
  return bridge;
}
