export function createSettingsController({credentials,credentialKey,store,getAdmin,setAdmin}) {
  return {
    async read(){return {adminUserId:getAdmin(),tokenConfigured:(await credentials.describeRecord(credentialKey)).configured};},
    async save(input){
      const admin=Number(input.adminUserId);
      if(!Number.isSafeInteger(admin)||admin<=0)throw Error('Admin user ID must be a positive integer.');
      const token=input.botToken;
      if(token!==undefined&&token!==''&&(typeof token!=='string'||!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token.trim())))throw Error('Enter a valid Telegram bot token.');
      if(token?.trim())await credentials.modifyRecord(credentialKey,async()=>({kind:'api-key',key:token.trim()}));
      if(admin!==getAdmin()){
        for(const [key,value] of await store.entries())if(key.startsWith('console:topic:'))await store.set(key,{...value,deleted:true,closed:true});
      }
      await store.set('settings:adminUserId',admin);
      setAdmin(admin);
      return this.read();
    }
  };
}
export function registerSettingsRoute(ctx,controller){
  return ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/telegram-console/settings',handler:async(req,res)=>{
    const admission=ctx.connection.admit({headers:req.headers});
    if('rejection' in admission||admission.peer.principal.kind!=='owner'){res.writeHead(403);res.end();return;}
    const origin=ctx.webServer.getOrigin();
    const content=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>4096){res.writeHead(413);res.end();return;}content.push(chunk);}
    const request=new Request(new URL(req.url,origin),{method:req.method,headers:req.headers,...req.method==='POST'?{body:Buffer.concat(content)}:{}});
    const peer=admission.peer;
    const response=await (async()=>{
    const headers={'Content-Type':'application/json','Cache-Control':'no-store'};
    const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers});
    if(peer?.principal?.kind!=='owner')return reply({error:'Owner access required'},403);
    try{
      if(request.method==='GET')return reply(await controller.read());
      if(request.method!=='POST')return reply({error:'Method not allowed'},405);
      if(request.headers.get('origin')!==new URL(request.url).origin)return reply({error:'Origin rejected'},403);
      if(!request.headers.get('content-type')?.startsWith('application/json'))return reply({error:'JSON required'},415);
      const body=await request.text();if(body.length>4096)return reply({error:'Request too large'},413);
      return reply(await controller.save(JSON.parse(body)));
    }catch(error){return reply({error:error.message},400);}
    })();
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
  }}));
}
