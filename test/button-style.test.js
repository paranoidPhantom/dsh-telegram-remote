import test from 'node:test';
import assert from 'node:assert/strict';
import {TelegramConsole} from '../console.js';
test('toolbar applies requested colors and custom emoji IDs',()=>{const c=new TelegramConsole({api:{},bridge:{},store:{}});const buttons=c.controls('s',{chatId:1,threadId:2},false).inline_keyboard.flat();assert.equal(buttons[0].text,'Model');assert.equal(buttons[0].style,'primary');assert.equal(buttons[0].icon_custom_emoji_id,'5258466217273871977');assert.equal(buttons[1].style,undefined);assert.equal(buttons[1].icon_custom_emoji_id,'5454371323595744068');assert.equal(buttons[2].text,'End topic');assert.equal(buttons[2].style,'danger');assert.equal(buttons[2].icon_custom_emoji_id,'5341570033405412393');c.close();});
