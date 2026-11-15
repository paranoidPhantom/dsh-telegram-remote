import test from 'node:test';
import assert from 'node:assert/strict';
import {TelegramConsole} from '../console.js';
test('assistant text seals previous log and subsequent tools start below it',async t=>{
 const data=new Map([['console:topic:s',{chatId:1,threadId:2}]]),calls=[];let id=100;
 const c=new TelegramConsole({api:{call:async(method,params)=>{const result=method==='sendMessage'?{message_id:++id}:true;calls.push({method,params,result});return result;}},bridge:{},store:{get:async k=>structuredClone(data.get(k)),set:async(k,v)=>data.set(k,structuredClone(v)),entries:async()=>[...data]}});t.after(()=>c.close());
 const a={callId:'a',name:'ReadA',status:'completed'},b={callId:'b',name:'ReadB',status:'completed'},latest={callId:'latest',name:'Latest sentinel',status:'running'};
 await c.onRun('s',{turn:1,toolLog:[a],outputs:[],partialAnswer:''});
 assert.deepEqual(data.get('console:run:s:1').logMessageIds||[],[]);
 await c.onRun('s',{turn:1,toolLog:[a],outputs:[{id:'text1',text:'Progress report',toolCount:1}],partialAnswer:''});
 const oldLog=data.get('console:run:s:1').sealedLogMessageIds[0];
 const text=calls.find(x=>x.method==='sendMessage'&&x.params.text==='Progress report');const boundary=calls.length;
 await c.onRun('s',{turn:1,toolLog:[a,b,latest],outputs:[{id:'text1',text:'Progress report',toolCount:1}],partialAnswer:''});
 const newLog=calls.slice(boundary).find(x=>x.method==='sendMessage'&&x.params.parse_mode==='HTML');
 assert.ok(newLog);assert.ok(newLog.result.message_id>text.result.message_id);assert.ok(newLog.params.text.includes('ReadB'));assert.ok(!newLog.params.text.includes('ReadA'));
 assert.ok(!calls.slice(boundary).some(x=>x.method==='editMessageText'&&x.params.message_id===oldLog));
 await c.onRun('s',{turn:1,toolLog:[a,b,latest],outputs:[{id:'text1',text:'Progress report',toolCount:1},{id:'text2',text:'Final',toolCount:3}],final:true});
 assert.ok(!calls.some(x=>x.method==='deleteMessage'&&x.params.message_id===oldLog));
});
