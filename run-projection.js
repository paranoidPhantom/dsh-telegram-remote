import { z } from 'zod';
import { formatToolCall, formatToolResult } from './tool-format.js';
import { mutationIntents, successfulMutations, aggregateTouched } from './touched-files.js';

export const textOf = content => (content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
const preview = (text, max=320) => {
  const value=String(text??'').replace(/\s+/g,' ').trim();
  return value.length>max?`${value.slice(0,max-1)}…`:value;
};
export function toolSummary(raw) {
  let args=raw;
  if(typeof raw==='string'){try{args=JSON.parse(raw);}catch{return preview(raw);}}
  if(!args||typeof args!=='object')return '';
  const detail=args.description??args.command??args.file_path??args.path??args.query??args.url??args.pattern??args.objective??args.question;
  return typeof detail==='string'?preview(detail):'';
}
export function initialRun(){return {turn:0,status:'idle',step:'',tools:0,toolLog:[],touchedFiles:[],workspaceSeqs:[],outputs:[],partialAnswer:'',answer:'',started:0,ended:0,model:'',final:false};}
export function foldRun(state,event){
  const d=event.data;
  switch(event.type){
    case 'turn/start':return {...initialRun(),turn:d.turn,status:'thinking',started:event.time};
    case 'request/header':return {...state,model:d.header.config.model};
    case 'step/start':return {...state,status:'thinking',step:`Step ${d.step}`};
    case 'tool/call':{
      if(state.toolLog.some(x=>x.callId===d.callId))return state;
      return {...state,status:'running',step:d.name,tools:state.tools+1,toolLog:[...state.toolLog,{callId:d.callId,name:d.name,status:'running',summary:toolSummary(d.arguments),mutations:mutationIntents(d.name,d.arguments),callHtml:formatToolCall(d.name, mutationIntents(d.name,d.arguments).length ? {paths:mutationIntents(d.name,d.arguments).map(x=>x.path)} : d.arguments),startedAt:event.time}]};
    }
    case 'tool/result':{
      const callId=d.message.toolCallId??d.message.source?.callId;
      const index=state.toolLog.findIndex(x=>x.callId===callId);if(index<0)return state;
      const toolLog=state.toolLog.slice();
      const failed=Boolean(d.error||d.message.isError);
      toolLog[index]={...toolLog[index],status:failed?'failed':'completed',endedAt:event.time,result:preview(textOf(d.message.content),640),resultHtml:formatToolResult(toolLog[index].name,textOf(d.message.content))};
      return {...state,toolLog,touchedFiles:aggregateTouched(state.touchedFiles,successfulMutations(toolLog[index],event))};
    }
    case 'workspace/changes':return d.turn===state.turn?{...state,workspaceSeqs:[...state.workspaceSeqs,event.seq]}:state;
    case 'assistant/message':{
      const text=textOf(d.message.content),id=String(event.seq??d.message.id??`${d.turn}:${d.step}`);
      return {...state,answer:text,partialAnswer:'',outputs:text&&!state.outputs.some(x=>x.id===id)?[...state.outputs,{id,text,toolCount:state.toolLog.length}]:state.outputs};
    }
    case 'assistant/attempt':{
      const text=(d.stream??[]).map(record=>record.type==='text-chunks'?(record.texts??[]).join(''):record.type==='chunk'&&record.chunk?.type==='text-delta'?record.chunk.text:'').join('');
      return text?{...state,partialAnswer:text}:state;
    }
    case 'turn/end':return {...state,final:true,ended:event.time,status:d.reason.kind==='completed'?'done':d.reason.kind==='aborted'?'stopped':'failed',toolLog:state.toolLog.map(x=>x.status==='running'?{...x,status:'cancelled',endedAt:event.time}:x)};
    default:return state;
  }
}
const touchedEntry=z.object({path:z.string(),kind:z.enum(['added','removed','edited']),sourceSeq:z.number().optional(),sourceIndex:z.number().optional(),cwd:z.string().optional()});
const toolEntry=z.object({callId:z.string(),name:z.string(),status:z.enum(['running','completed','failed','cancelled']),summary:z.string(),mutations:z.array(touchedEntry).optional(),startedAt:z.number(),endedAt:z.number().optional(),result:z.string().optional(),callHtml:z.string().optional(),resultHtml:z.string().optional()});
export const runProjection={key:'telegramConsoleRun',stateVersion:6,stateSchema:z.object({turn:z.number(),status:z.string(),step:z.string(),tools:z.number(),toolLog:z.array(toolEntry),touchedFiles:z.array(touchedEntry),workspaceSeqs:z.array(z.number()),outputs:z.array(z.object({id:z.string(),text:z.string(),toolCount:z.number().int().nonnegative()})),partialAnswer:z.string(),answer:z.string(),started:z.number(),ended:z.number(),model:z.string(),final:z.boolean()}),init:initialRun,apply:foldRun};
