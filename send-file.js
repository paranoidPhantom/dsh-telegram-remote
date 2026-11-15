import path from 'node:path';
export function registerSendFile(ctx,{api,surface}){
 return ctx.tools.register({
  name:'send_file',description:'Send a finished result file to the user in this session’s Telegram topic. Returns its path and Telegram message ID.',
  parameters:{type:'object',properties:{path:{type:'string',description:'File path inside the session workspace; relative paths use its working directory.'},caption:{type:'string',description:'Optional short explanation of the result.'}},required:['path'],additionalProperties:false},
  output:{schema:{type:'object',properties:{path:{type:'string'},messageId:{type:'number'}},required:['path','messageId'],additionalProperties:false},render:(_args,value)=>[{type:'text',text:`Sent ${value.path} to Telegram (message ${value.messageId}).`}]},
  async execute(args,exec){
   if(!exec.agent)throw Error('A session is required.');
   const topic=await surface.getTopic(exec.agent.id);if(!topic)throw Error('This session has no connected Telegram topic.');
   if(typeof args.path!=='string'||!args.path||args.path.includes('\0'))throw Error('A valid file path is required.');
   const fs=exec.agent.ctx.get('fs')??ctx.fs,cwd=ctx.workingDirectory.get(exec.agent.session);
   const root=await fs.resolve(cwd,{signal:exec.signal});
   const target=await fs.resolve(args.path,{cwd,signal:exec.signal});
   if(!fs.contains(root,target))throw Error('File must be inside the session workspace.');
   const info=await fs.stat(target,exec.signal);
   if(!info||info.type!=='file')throw Error('Result must be a regular file.');
   const bytes=await fs.readBytes(target,exec.signal,10*1024*1024);
   const relative=path.relative(fs.processPath(root),fs.processPath(target));
   const result=await (api.file?api.file.bind(api):api.document.bind(api))({chatId:topic.chatId,threadId:topic.threadId,name:path.basename(relative),content:Buffer.from(bytes),caption:[args.caption,relative].filter(Boolean).join('\n').slice(0,1024)});
   return {path:relative,messageId:result.message_id};
  }
 });
}
