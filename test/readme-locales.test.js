import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const root=new URL('../',import.meta.url);
const source=await readFile(new URL('client.js',root),'utf8');
function harness(locale='en'){
  const state=[],effects=[],requests=[];let cursor=0,component,registration,plugin;
  let response={ok:true,value:{locale,adminUserId:123,tokenConfigured:true}};
  const React={
    createElement:(type,props,...children)=>({type,props:props||{},children}),
    useState:initial=>{const index=cursor++;if(!(index in state))state[index]=initial;return [state[index],value=>{state[index]=value;}];},
    useEffect:effect=>{if(!effects.length)effects.push(effect);}
  };
  vm.runInNewContext(source,{
    window:{__ModuleLoader__:{load:module=>{assert.equal(module.id,'dsh-telegram-remote');plugin=module.factory(name=>{assert.equal(name,'react');return React;});}}},
    fetch:async(url,options)=>{requests.push({url,options});return {ok:response.ok,json:async()=>{if(response.invalid)throw Error('invalid JSON');return response.value;}};}
  });
  assert.equal(requests.length,0,'factory must not request settings');
  plugin.apply({slots:{inject:(_name,register)=>register(),register:(options,render)=>{registration=options;component=render;}}});
  assert.equal(requests.length,0,'apply must not request settings');
  return {
    requests,registration,
    render(){cursor=0;return component();},
    async mount(){this.render();this.cleanup=effects[0]();await new Promise(resolve=>setImmediate(resolve));return this.render();},
    respond(value,ok=true,invalid=false){response={value,ok,invalid};}
  };
}
function elements(tree,type){return [tree,...tree.children.flat(Infinity).filter(value=>value&&typeof value==='object').flatMap(value=>elements(value,type))].filter(node=>node.type===type);}
function text(tree){return tree.children.flat(Infinity).map(value=>value&&typeof value==='object'?text(value):value??'').join(' ');}

test('READMEs cross-link all languages and retain the same minimal installation outline',async()=>{
  for(const name of ['README.md','README.zh-CN.md','README.ru.md']){
    const value=await readFile(new URL(name,root),'utf8');
    for(const link of ['README.md','README.zh-CN.md','README.ru.md'])assert.ok(value.includes(`](${link})`));
    assert.equal((value.match(/^- /gm)||[]).length,4);
    assert.equal((value.match(/^\d\. /gm)||[]).length,5);
    for(const token of ['dsh-telegram-remote','/start','/sessions','@BotFather'])assert.ok(value.includes(token));
  }
});
test('metadata locales have identical keys and localized names',async()=>{
  for(const lang of ['en','zh','ru']){
    const value=JSON.parse(await readFile(new URL(`locale/${lang}.json`,root),'utf8'));
    assert.deepEqual(Object.keys(value.meta).sort(),['description','title']);
    assert.ok(value.meta.title&&value.meta.description);
  }
});
test('settings language comes from Host locale with regional normalization and English fallback',async()=>{
  for(const [locale,title] of [['zh-CN','Telegram 远程控制'],['RU_ru','Удалённый доступ через Telegram'],['fr','Telegram Remote'],[undefined,'Telegram Remote']]){
    const app=harness(locale);const tree=await app.mount();
    assert.equal(elements(tree,'h2')[0].children[0],title);
    assert.equal(app.registration.label(),title);
    assert.equal(app.requests.length,1);
    assert.equal(elements(tree,'input')[1].props.value,'','saved credentials must never populate the password');
    app.cleanup();
  }
  assert.ok(!source.includes('navigator'));
});
test('localized errors preserve unsaved token; successful save clears it',async()=>{
  const app=harness('zh');let tree=await app.mount();
  elements(tree,'input')[1].props.onChange({target:{value:'unsaved-token'}});
  tree=app.render();
  app.respond({error:'Enter a valid Telegram bot token.'},false);
  await elements(tree,'form')[0].props.onSubmit({preventDefault(){}});
  tree=app.render();
  assert.ok(text(tree).includes('请输入有效的 Telegram 机器人令牌。'));
  assert.equal(elements(tree,'input')[1].props.value,'unsaved-token');
  assert.equal(JSON.parse(app.requests[1].options.body).botToken,'unsaved-token');
  app.respond({locale:'ru',adminUserId:123,tokenConfigured:true});
  await elements(tree,'form')[0].props.onSubmit({preventDefault(){}});
  tree=app.render();
  assert.equal(elements(tree,'input')[1].props.value,'');
  assert.ok(text(tree).includes('Сохранено.'));
});
test('empty rejection and unexpected backend errors get localized generic messages',async()=>{
  const app=harness('ru');let tree=await app.mount();
  app.respond(null,false,true);
  await elements(tree,'form')[0].props.onSubmit({preventDefault(){}});
  tree=app.render();assert.ok(text(tree).includes('Не удалось сохранить настройки.'));
  app.respond({error:'Backend detail'},false);
  await elements(tree,'form')[0].props.onSubmit({preventDefault(){}});
  tree=app.render();assert.ok(text(tree).includes('Не удалось сохранить настройки. Backend detail'));
});
