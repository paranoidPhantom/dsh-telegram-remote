import { normalizeLocale } from './bot-i18n.js';
/** Read the explicit DSH language preference each time; never infer from Telegram. */
export function dshLocale(ctx){
 const settings=ctx.get('settings');
 const documents=settings?.describe({redactSecrets:true})??[];
 const locale=documents.find(item=>String(item.ns)==='locale'||String(item.ns).endsWith(':locale'));
 return normalizeLocale(locale?.value?.preference);
}
