window.__ModuleLoader__.load({id:'dsh-telegram-remote',factory(require){
  const React=require('react'),h=React.createElement;
  return {inject:['slots'],apply(ctx){
    // DSH owns the language choice. Do not infer it from Telegram or the browser.
    const messages={
      en:{
        title:'Telegram Remote',intro:'Connect a private Telegram bot and choose the only user allowed to control it.',
        admin:'Admin user ID',adminHelp:'Numeric Telegram user ID. Changing it revokes the previous admin’s access.',
        token:'Bot token',tokenSaved:'Token saved — leave blank to keep it',tokenPlaceholder:'Paste the token from BotFather',
        tokenHelp:'Stored in DSH credentials, never in plugin configuration. The saved token is not returned to this page.',
        loading:'Loading…',saving:'Saving…',save:'Save',saved:'Saved. The admin ID applies immediately; token changes are read on the next API request.',
        loadError:'Unable to load settings.',saveError:'Unable to save settings.',
        adminError:'Admin user ID must be a positive integer.',tokenError:'Enter a valid Telegram bot token.',
        credentialError:'The credentials store did not confirm the token write.',rejected:'Harness rejected this settings request.',
        ownerError:'Owner access required.',methodError:'Method not allowed.',jsonError:'JSON required.',sizeError:'Request too large.'
      },
      zh:{
        title:'Telegram 远程控制',intro:'连接私人 Telegram 机器人，并指定唯一有权控制它的用户。',
        admin:'管理员用户 ID',adminHelp:'Telegram 数字用户 ID。更改后，原管理员将失去访问权限。',
        token:'机器人令牌',tokenSaved:'令牌已保存 — 留空以保留',tokenPlaceholder:'粘贴 BotFather 提供的令牌',
        tokenHelp:'仅存储在 DSH 凭据中，不写入插件配置。此页面不会读取已保存的令牌。',
        loading:'加载中…',saving:'保存中…',save:'保存',saved:'已保存。管理员 ID 立即生效；令牌更改将在下一次 API 请求时使用。',
        loadError:'无法加载设置。',saveError:'无法保存设置。',
        adminError:'管理员用户 ID 必须为正整数。',tokenError:'请输入有效的 Telegram 机器人令牌。',
        credentialError:'凭据存储未确认令牌写入成功。',rejected:'Harness 拒绝了此设置请求。',
        ownerError:'需要所有者权限。',methodError:'不支持此请求方法。',jsonError:'需要 JSON 格式。',sizeError:'请求过大。'
      },
      ru:{
        title:'Удалённый доступ через Telegram',intro:'Подключите личного Telegram-бота и укажите единственного пользователя, которому разрешено им управлять.',
        admin:'ID администратора',adminHelp:'Числовой ID пользователя Telegram. После изменения прежний администратор потеряет доступ.',
        token:'Токен бота',tokenSaved:'Токен сохранён — оставьте поле пустым, чтобы сохранить его',tokenPlaceholder:'Вставьте токен от BotFather',
        tokenHelp:'Хранится в учётных данных DSH, а не в конфигурации плагина. Сохранённый токен не возвращается на эту страницу.',
        loading:'Загрузка…',saving:'Сохранение…',save:'Сохранить',saved:'Сохранено. ID администратора применяется сразу; новый токен используется при следующем запросе API.',
        loadError:'Не удалось загрузить настройки.',saveError:'Не удалось сохранить настройки.',
        adminError:'ID администратора должен быть положительным целым числом.',tokenError:'Введите действительный токен Telegram-бота.',
        credentialError:'Хранилище учётных данных не подтвердило запись токена.',rejected:'Harness отклонил этот запрос настроек.',
        ownerError:'Требуется доступ владельца.',methodError:'Метод не разрешён.',jsonError:'Требуется формат JSON.',sizeError:'Слишком большой запрос.'
      }
    };
    let locale='en';
    const normalizeLocale=value=>{const base=typeof value==='string'?value.toLowerCase().split(/[-_]/)[0]:'';return Object.hasOwn(messages,base)?base:'en';};
    const errorKeys={
      'Admin user ID must be a positive integer.':'adminError',
      'Enter a valid Telegram bot token.':'tokenError',
      'The credentials store did not confirm the token write.':'credentialError',
      'Harness rejected this settings request.':'rejected',
      'Owner access required':'ownerError','Method not allowed':'methodError','JSON required':'jsonError','Request too large':'sizeError',
      'Unable to load settings':'loadError'
    };
    function Settings(){
      const [language,setLanguage]=React.useState(locale),[admin,setAdmin]=React.useState(''),[token,setToken]=React.useState(''),[configured,setConfigured]=React.useState(false),[busy,setBusy]=React.useState(true),[saving,setSaving]=React.useState(false),[note,setNote]=React.useState(null);
      const text=messages[language];
      function acceptLocale(value){locale=normalizeLocale(value.locale);setLanguage(locale);}
      async function call(body){
        const response=await fetch('/telegram-console/settings',{credentials:'same-origin',cache:'no-store',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
        // Some rejected requests have no JSON body. Keep their UI error localized.
        let value;try{value=await response.json();}catch{throw Error('');}
        if(!response.ok)throw Error(typeof value?.error==='string'?value.error:'');
        return value;
      }
      function failure(error,kind){return {key:errorKeys[error.message]||kind,details:errorKeys[error.message]?'':error.message};}
      React.useEffect(()=>{
        let live=true;
        call().then(value=>{if(live){acceptLocale(value);setAdmin(String(value.adminUserId));setConfigured(value.tokenConfigured);}})
          .catch(error=>{if(live)setNote(failure(error,'loadError'));})
          .finally(()=>{if(live)setBusy(false);});
        return()=>{live=false;};
      },[]);
      async function save(event){
        event.preventDefault();setBusy(true);setSaving(true);setNote(null);
        try{
          const value=await call({adminUserId:admin,...token?{botToken:token}:{}});
          acceptLocale(value);setToken('');setConfigured(value.tokenConfigured);setNote({key:'saved'});
        }catch(error){setNote(failure(error,'saveError'));}finally{setBusy(false);setSaving(false);}
      }
      const input={width:'100%',boxSizing:'border-box',padding:'10px 12px',borderRadius:8,border:'1px solid var(--dsw-alias-border-l2)',background:'var(--dsw-alias-bg-layer-1)',color:'var(--dsw-alias-label-primary)',font:'inherit'};
      return h('section',{style:{maxWidth:600,padding:24,color:'var(--dsw-alias-label-primary)'}},
        h('h2',null,text.title),h('p',{style:{color:'var(--dsw-alias-label-secondary)'}},text.intro),
        h('form',{onSubmit:save},
          h('label',{htmlFor:'telegram-admin'},text.admin),h('input',{id:'telegram-admin',inputMode:'numeric',value:admin,disabled:busy,onChange:e=>setAdmin(e.target.value),style:input}),
          h('p',{style:{fontSize:13,color:'var(--dsw-alias-label-secondary)'}},text.adminHelp),
          h('label',{htmlFor:'telegram-token'},text.token),h('input',{id:'telegram-token',type:'password',autoComplete:'new-password',value:token,disabled:busy,placeholder:configured?text.tokenSaved:text.tokenPlaceholder,onChange:e=>setToken(e.target.value),style:input}),
          h('p',{style:{fontSize:13,color:'var(--dsw-alias-label-secondary)'}},text.tokenHelp),
          h('button',{type:'submit',disabled:busy,style:{padding:'9px 18px',borderRadius:8,border:0,background:'var(--dsw-alias-button-primary-fill)',color:'var(--dsw-alias-label-primary-inverted)'}},busy?(saving?text.saving:text.loading):text.save),
          h('p',{role:'status','aria-live':'polite'},note?text[note.key]+(note.details?' '+note.details:''):'')));
    }
    ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'telegram-console',order:35,label:()=>messages[locale].title},Settings));
  }};
}});
