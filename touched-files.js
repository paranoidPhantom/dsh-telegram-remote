import path from 'node:path';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validPath = value => typeof value === 'string' && value.length > 0 && !value.includes('\0');
export const toolName = name => String(name ?? '').split(/[.:/]/).pop().replace(/^.*__/, '').toLowerCase();
export function parseArguments(raw) {
  if (object(raw)) return raw;
  try { const value = JSON.parse(raw); return object(value) ? value : {}; } catch { return {}; }
}
// Only paths and operation intent enter the projection; never retain write/patch text.
export function mutationIntents(name, raw) {
  const args = parseArguments(raw), tool = toolName(name), p = args.file_path ?? args.path;
  if (['write','edit','delete','delete_file','remove','move','move_file'].includes(tool)) {
    if (tool === 'move' || tool === 'move_file') {
      const source = args.source ?? args.source_path ?? args.from ?? p;
      const destination = args.destination ?? args.destination_path ?? args.to ?? args.target;
      return [{path:source,kind:'removed'},{path:destination,kind:'added'}].filter(x=>validPath(x.path));
    }
    return validPath(p) ? [{path:p,kind:tool === 'write' ? 'edited' : tool === 'edit' ? 'edited' : 'removed'}] : [];
  }
  if (tool !== 'apply_patch') return [];
  const result=[];
  for(const line of String(args.input ?? args.patch ?? '').split('\n')) {
    const match=/^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (!match) continue;
    const [,kind,p]=match;
    if(kind==='Move to') {if(result.length)result[result.length-1].kind='removed';result.push({path:p,kind:'added'});}
    else result.push({path:p,kind:kind==='Add File'?'added':kind==='Delete File'?'removed':'edited'});
  }
  return result.filter(x=>validPath(x.path));
}
const textOf = data => (data.message?.content ?? []).filter(x=>x.type==='text').map(x=>x.text).join('\n');
export function successfulMutations(call, event) {
  const d=event.data;
  if(d.error || d.message?.isError)return [];
  const meta=object(d.meta)?d.meta:{}, intents=call.mutations ?? mutationIntents(call.name,call.arguments);
  const diffs=Array.isArray(meta.diffs)?meta.diffs.filter(x=>object(x)&&validPath(x.path)):[];
  let result=intents.map(x=>({...x}));
  if(meta.stopped === true) {
    // Stopped patches are not all-or-nothing; only applied diff metadata is proof.
    return [...new Set(diffs.map(x=>x.path))].map(p=>({path:p,kind:'edited',sourceSeq:event.seq}));
  }
  if(result.length===1 && validPath(meta.path))result[0].path=meta.path;
  for(const item of result) {
    const canonical=diffs.find(diff=>diff.path===item.path || (!path.isAbsolute(item.path) && diff.path.endsWith('/'+item.path)));
    if(canonical)item.path=canonical.path;
    if(meta.operation==='create' && result.length===1)item.kind='added';
    else if(meta.operation==='update' && result.length===1)item.kind='edited';
    else if(toolName(call.name)==='write' && /<content>\s*Created file\s*<\/content>/.test(textOf(d)))item.kind='added';
    item.sourceSeq=event.seq;
  }
  // Applied diffs are authoritative even for tools whose names are not known here.
  for(const diff of diffs)if(!result.some(x=>x.path===diff.path))result.push({path:diff.path,kind:'edited',sourceSeq:event.seq});
  return result;
}
export function aggregateTouched(files, changes) {
  const result=files.map(x=>({...x}));
  for(const change of changes) {
    const index=result.findIndex(x=>x.path===change.path);
    if(index<0){result.push({...change});continue;}
    const previous=result[index];
    const kind=change.kind==='removed'?'removed':previous.kind==='added'?'added':previous.kind==='removed'?'edited':change.kind;
    result[index]={...previous,...change,kind};
  }
  return result;
}
// Full removal diffs in presentation metadata contain the entire LF-normalized basis.
// Do not reconstruct arbitrary edit hunks, read windows, or model prose as a file.
export function removedContent(events, file) {
  const event=events.find(e=>e.seq===file.sourceSeq && e.type==='tool/result');
  if(!event || event.data.error || event.data.message?.isError)return undefined;
  const meta=event.data.meta;
  if(object(meta) && meta.path===file.path && typeof meta.before==='string' && meta.after===null)return meta.before;
  const diffs=Array.isArray(meta?.diffs)?meta.diffs.filter(x=>x.path===file.path):[];
  if(file.kind==='removed' && diffs.length===1 && typeof diffs[0].oldText==='string' && diffs[0].newText==='')return diffs[0].oldText;
  return undefined;
}
export function workspaceTouched(state, sessionId, service) {
  const seq=state.workspaceSeqs?.at(-1);
  const summary=seq===undefined?undefined:service?.summary(sessionId,seq);
  if(!summary || summary.turn!==state.turn)return state.touchedFiles;
  const files=state.touchedFiles.map(file=>({...file,cwd:summary.cwd}));
  for(const [sourceIndex,item] of summary.files.entries()) {
    if(!validPath(item.path))continue;
    const existing=files.find(file=>path.resolve(summary.cwd,file.path)===path.resolve(summary.cwd,item.path));
    if(existing)continue;
    files.push({path:item.path,kind:'edited',cwd:summary.cwd,sourceSeq:seq,sourceIndex});
  }
  return files;
}
export async function readTouchedFile(ctx, {cwd, file, events, signal}) {
  if(!validPath(file.path) || typeof cwd!=='string')throw Error('Invalid touched file path');
  const root=await ctx.fs.resolve(cwd,{signal});
  const target=await ctx.fs.resolve(file.path,{cwd:file.cwd ?? cwd,signal});
  if(!ctx.fs.contains(root,target))throw Error('File is outside the session workspace');
  let content;
  if(file.kind==='removed') {
    const before=removedContent(events,file);
    if(before===undefined)throw Error('Removed file content is not available in the trusted session log');
    content=Buffer.from(before);
  } else {
    const info=await ctx.fs.stat(target,signal);
    if(!info || info.type!=='file')throw Error('Touched file is no longer a regular file');
    if(info.size>MAX_FILE_BYTES)throw Error('File exceeds the 10 MiB upload limit');
    content=Buffer.from(await ctx.fs.readBytes(target,signal,MAX_FILE_BYTES));
  }
  if(content.length>MAX_FILE_BYTES)throw Error('File exceeds the 10 MiB upload limit');
  return {name:path.basename(file.path),content};
}
