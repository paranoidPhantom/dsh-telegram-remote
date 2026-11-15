import test from 'node:test';
import assert from 'node:assert/strict';
import {toolLogPages} from '../console-render.js';
test('log is collapsed and read contents never appear',()=>{const text=toolLogPages([{name:'read',summary:'notes.md',status:'completed',callHtml:'RAW ARGUMENTS',result:'PRIVATE FILE CONTENT',resultHtml:'<pre>PRIVATE FILE CONTENT</pre>'}]).join('');assert.ok(text.startsWith('<blockquote expandable>'));assert.ok(text.includes('notes.md'));assert.ok(!text.includes('PRIVATE FILE'));assert.ok(!text.includes('RAW ARGUMENTS'));});
test('write diffs remain within collapsed block',()=>{const text=toolLogPages([{name:'edit',summary:'notes.md',status:'completed',resultHtml:'<b>Changes</b>\n<pre>-old\n+new</pre>'}]).join('');assert.match(text,/<blockquote expandable>.*Changes/s);assert.ok(text.includes('+new'));});
