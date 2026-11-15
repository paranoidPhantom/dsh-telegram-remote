import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialRun,foldRun,runProjection} from '../run-projection.js';
import {mutationIntents,readTouchedFile,MAX_FILE_BYTES,workspaceTouched} from '../touched-files.js';
import {createBridge} from '../bridge.js';
const start=(turn=1)=>({type:'turn/start',time:1,seq:0,data:{turn}});
const call=(name,args,id='a')=>({type:'tool/call',time:2,seq:1,data:{name,arguments:JSON.stringify(args),callId:id}});
const result=(meta={},id='a',error=false)=>({type:'tool/result',time:3,seq:2,data:{meta,message:{toolCallId:id,isError:error,content:[]}}});
function run(events){return events.reduce(foldRun,initialRun());}
test('successful mutations only; pending calls retain paths not contents',()=>{
 const s=run([start(),call('write',{file_path:'x',content:'TOP SECRET'})]);
 assert.deepEqual(s.touchedFiles,[]);assert(!JSON.stringify(s).includes('TOP SECRET'));
 assert.deepEqual(foldRun(s,result({},'a',true)).touchedFiles,[]);
 const success=foldRun(s,result({operation:'create',path:'x'}));
 assert.equal(success.touchedFiles[0].kind,'added');assert(runProjection.stateSchema.safeParse(success).success);
 assert.deepEqual(foldRun(success,start(2)).touchedFiles,[]);
});
test('added then edit stays added, delete then recreate is edited',()=>{
 const s=run([start(),call('write',{path:'x'}),result({path:'x',operation:'create'}),call('edit',{path:'x'},'b'),result({},'b')]);
 assert.equal(s.touchedFiles[0].kind,'added');
 const t=run([start(),call('delete',{path:'x'}),result(),call('write',{path:'x'},'b'),result({operation:'create'},'b')]);
 assert.equal(t.touchedFiles[0].kind,'edited');
});
test('default patch and move intentions; applied canonical diffs deduplicate',()=>{
 assert.deepEqual(mutationIntents('functions.apply_patch',{input:'*** Begin Patch\n*** Add File: a\n+x\n*** Update File: b\n*** Move to: c\n*** Delete File: d\n*** End Patch'}),[{path:'a',kind:'added'},{path:'b',kind:'removed'},{path:'c',kind:'added'},{path:'d',kind:'removed'}]);
 assert.deepEqual(mutationIntents('move',{source:'a',destination:'b'}),[{path:'a',kind:'removed'},{path:'b',kind:'added'}]);
 const s=run([start(),call('edit',{path:'x'}),result({path:'/w/x',diffs:[{path:'/w/x',oldText:'a',newText:'b'}]})]);
 assert.equal(s.touchedFiles.length,1);assert.equal(s.touchedFiles[0].path,'/w/x');
});
const fs={resolve:async(p,{cwd}={})=>({path:p.startsWith('/')?p:`${cwd}/${p}`}),contains:(a,b)=>b.path===a.path||b.path.startsWith(a.path+'/'),stat:async()=>({type:'file',size:3}),readBytes:async()=>Buffer.from('new')};
test('safe bounded current file, removed trusted fallback, explicit missing fallback',async()=>{
 assert.equal((await readTouchedFile({fs},{cwd:'/w',file:{path:'x',kind:'edited'},events:[]})).content.toString(),'new');
 const event=result({path:'x',diffs:[{path:'x',oldText:'old\n',newText:''}]});
 assert.equal((await readTouchedFile({fs},{cwd:'/w',file:{path:'x',kind:'removed',sourceSeq:2},events:[event]})).content.toString(),'old\n');
 await assert.rejects(readTouchedFile({fs},{cwd:'/w',file:{path:'x',kind:'removed'},events:[]}),/not available/);
 await assert.rejects(readTouchedFile({fs},{cwd:'/w',file:{path:'/outside/x',kind:'edited'},events:[]}),/outside/);
 await assert.rejects(readTouchedFile({fs:{...fs,stat:async()=>({type:'file',size:MAX_FILE_BYTES+1})}},{cwd:'/w',file:{path:'x',kind:'edited'},events:[]}),/10 MiB/);
 await assert.rejects(readTouchedFile({fs:{...fs,resolve:async(p)=>({path:p==='/w'?'/w':'/outside/symlink'})}},{cwd:'/w',file:{path:'x',kind:'edited'},events:[]}),/outside|regular/).catch(error=>{throw error;});
});
test('workspace summary adds authoritative otherwise-unrecognized paths',()=>{
 const state={...initialRun(),turn:1,workspaceSeqs:[8],touchedFiles:[{path:'/w/a',kind:'added'}]};
 const files=workspaceTouched(state,'id',{summary:()=>({turn:1,cwd:'/w',files:[{path:'a'},{path:'b'}]})});
 assert.equal(files.length,2);assert.equal(files[0].kind,'added');assert.equal(files[1].sourceIndex,1);
});
test('bridge rejects forged path and keeps selected turn stable',async()=>{
 const events=[start(),call('write',{path:'x'}),result({operation:'create'}),start(2)];
 let disposed=0;
 const ctx={sessionController:{},sessionProjections:{register:async()=>({stateOf:()=>run(events),dispose:async()=>{}})},sessionQuery:{observeSession:async()=>({header:{cwd:'/w'},events,[Symbol.dispose]:()=>disposed++})},workingDirectory:{defaultDirectory:'/w',get:()=>'/w'},fs};
 const bridge=await createBridge(ctx);
 assert.equal((await bridge.fileForTurn('id',1,'x')).content.toString(),'new');
 await assert.rejects(bridge.fileForTurn('id',1,'other'),/not successfully touched/);
 await assert.rejects(bridge.fileForTurn('id',2,'x'),/not successfully touched/);
 assert.equal(disposed,3);assert.equal(bridge.runView({id:'id'}).cwd,'/w');
});
