import test from 'node:test';
import assert from 'node:assert/strict';
import {formatAnswer,answerParts} from '../answer-format.js';
test('bold and backticks become entities not raw markers',()=>{const v=formatAnswer('**Bold** and `code`');assert.equal(v.text,'Bold and code');assert.deepEqual(v.entities.map(x=>x.type),['bold','code']);});
test('local file references are code labels not links',()=>{const v=formatAnswer('The [runtime diagnostics](<dsh-telegram-console/.runtime-status.json#L2-L8>) show:');assert.equal(v.text,'The runtime diagnostics show:');assert.equal(v.entities[0].type,'code');assert.ok(!v.text.includes('status.json'));});
test('external URLs remain links while HTML remains literal',()=>{const v=formatAnswer('[Docs](https://example.com) <b>literal</b>');assert.equal(v.entities[0].type,'text_link');assert.ok(v.text.includes('<b>literal</b>'));});
test('fenced code preserves literal markdown and language',()=>{const v=formatAnswer('```js\nconst x = "**";\n```');assert.equal(v.text,'const x = "**";');assert.equal(v.entities[0].language,'js');});
test('UTF16 entities split correctly across long messages',()=>{const source='**'+ '😀'.repeat(3000)+'**';const parts=answerParts(source);assert.equal(parts.map(x=>x.text).join(''),'😀'.repeat(3000));assert.ok(parts.every(x=>x.text.length<=4096&&x.entities[0].length===x.text.length));});
