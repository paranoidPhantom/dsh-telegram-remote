import { basename } from 'node:path';
import { compileWidget } from './compiler.js';
import { WidgetDelivery } from './widget-delivery.js';

/** Widget compilation/delivery is independent of chat routing and run streaming. */
export function createWidgetPipeline({ctx,api,store,surface,signal}) {
  const delivery=new WidgetDelivery({api,store});
  return async function publishWidget(agent,path) {
    const topic=await surface.getTopic(agent.id);if(!topic)return;
    const fs=agent.ctx.get('fs')??ctx.fs;
    const rootDir=ctx.workingDirectory.get(agent.session);
    const target=await fs.resolve(path,{cwd:rootDir,signal});
    const root=await fs.resolve(rootDir,{signal});
    if(!fs.contains(root,target))throw Error('Widget must be inside its session workspace');
    const raw=Buffer.from(await fs.readBytes(target,signal,512*1024));
    const filename=basename(path);
    try {
      const compiled=await compileWidget({html:raw.toString('utf8'),filePath:fs.processPath(target),rootDir});
      await delivery.deliver({chatId:topic.chatId,threadId:topic.threadId,filename,compiled});
      if(compiled.warnings.length)await api.call('sendMessage',{chat_id:topic.chatId,message_thread_id:topic.threadId,text:`🖼 ${filename}: ${compiled.warnings.join('; ')}`.slice(0,4096),disable_notification:true});
    }catch(error){
      await api.call('sendMessage',{chat_id:topic.chatId,message_thread_id:topic.threadId,text:`⚠ Widget not delivered: ${String(error.message).slice(0,1000)}`});
      await api.document({chatId:topic.chatId,threadId:topic.threadId,name:filename,content:raw,caption:'Original widget source'});
    }
  };
}
