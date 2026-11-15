import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramConsole } from '../console.js';

function fixture(t) {
  const data = new Map([['console:topic:s', { chatId: 1, threadId: 2, cardId: 99 }]]);
  const calls = []; let seq = 100;
  const api = { async call(method, params) {
    calls.push({ method, params });
    return method === 'sendMessage' ? { message_id: ++seq } : true;
  } };
  const surface = new TelegramConsole({ api, bridge: {}, store: {
    async get(k) { return structuredClone(data.get(k)); },
    async set(k, v) { data.set(k, structuredClone(v)); },
    async entries() { return [...data]; }
  } });
  t.after(() => surface.close());
  const run = view => surface.onRun('s', { turn: 1, answer: '', partialAnswer: '', outputs: [], ...view });
  const texts = () => calls.filter(x => x.method === 'sendMessage' && x.params.text !== 'Deep diving').map(x => x.params.text);
  return { surface, calls, data, api, run, texts };
}

test('interstitial committed messages publish immediately, format, and dedupe frames/final', async t => {
  const f = fixture(t); const first = { id: 'a', text: '**First** `step`' };
  await f.run({ outputs: [first], answer: first.text });
  assert.deepEqual(f.texts(), ['First step']);
  assert.deepEqual(f.calls.find(x => x.params.text === 'First step').params.entities.map(x => x.type), ['bold', 'code']);
  await f.run({ outputs: [first], answer: first.text, toolLog: [{ callId: 'c', name: 'tool', status: 'running' }] });
  const second = { id: 'b', text: 'Second answer' };
  await f.run({ outputs: [first, second], answer: second.text });
  await f.run({ outputs: [first, second], answer: second.text, final: true, status: 'done' });
  await f.run({ outputs: [first, second], final: true });
  assert.equal(f.texts().filter(x => x === 'First step').length, 1);
  assert.equal(f.texts().filter(x => x === second.text).length, 1);
  const delivered=f.data.get('console:run:s:1').outputs.at(-1).messageIds.at(-1);
  const toolbar=f.calls.filter(x=>x.method==='editMessageReplyMarkup'&&x.params.message_id===delivered).at(-1);
  assert.ok(toolbar.params.reply_markup.inline_keyboard.flat().some(button=>button.text==='Model'));
  assert.ok(toolbar.params.reply_markup.inline_keyboard.flat().some(button=>button.text==='End topic'));
  const stored = JSON.stringify(f.data.get('console:run:s:1'));
  assert.ok(!stored.includes('First') && !stored.includes('Second answer'));
  assert.deepEqual(f.data.get('console:run:s:1').outputs.map(x => x.id), ['a', 'b']);
  const drafts = f.calls.filter(x => x.method === 'sendMessageDraft');
  assert.ok(drafts.some(x => x.params.text === 'Deep diving'));
  const toolDraft = drafts.find(x => x.params.text === '🔧 tool');
  assert.ok(toolDraft);
  assert.deepEqual(toolDraft.params.entities, [{ type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: '5220046725493828505' }]);
  assert.ok(drafts.every(x => x.params.text === 'Deep diving' || x.params.text === '🔧 tool'));
});

test('stop preserves previous outputs and publishes distinct current partial attempt', async t => {
  const f = fixture(t); const outputs = [{ id: 'a', text: 'Earlier message' }];
  await f.run({ outputs, answer: 'Earlier message', partialAnswer: 'New partial', partialId: 'attempt-2' });
  await f.run({ outputs, answer: 'Earlier message', partialAnswer: 'New partial', partialId: 'attempt-2', final: true, status: 'stopped' });
  assert.deepEqual(f.texts(), ['Earlier message', 'New partial']);
  assert.equal(f.data.get('console:run:s:1').outputs.length, 2);
});

test('stop matching last output or empty partial does not duplicate or add status noise', async t => {
  for (const partialAnswer of ['', 'Same']) {
    const f = fixture(t); const outputs = [{ id: 'a', text: 'Same' }, { id: 'empty', text: '' }];
    await f.run({ outputs });
    await f.run({ outputs, partialAnswer, final: true, status: 'stopped' });
    assert.deepEqual(f.texts(), ['Same']);
  }
});

test('cleanup and log failures never swallow durable output or final answer', async t => {
  const f = fixture(t); const original = f.api.call;
  f.api.call = async (method, params) => {
    if (method === 'editMessageReplyMarkup' || method === 'deleteMessage' || params.parse_mode === 'HTML') throw Error('cosmetic failure');
    return original(method, params);
  };
  await f.run({ outputs: [{ id: 'a', text: 'Committed' }], toolLog: [{ callId: 'c', name: 'tool', status: 'running' }] });
  await f.run({ outputs: [{ id: 'a', text: 'Committed' }], partialAnswer: 'Preserved partial', final: true, status: 'stopped' });
  assert.deepEqual(f.texts(), ['Committed', 'Preserved partial']);
  await f.surface.onRun('s', { turn: 2, answer: 'Legacy final', final: true });
  assert.equal(f.texts().at(-1), 'Legacy final');
  assert.equal(f.data.get('console:run:s:2').finalMessageIds.length, 1);
});

test('partial send failure preserves accepted chunk IDs and never ambiguously resends', async t => {
  const f = fixture(t); const original = f.api.call; let attempts = 0;
  f.api.call = async (method, params) => {
    if (method === 'sendMessage' && params.text !== 'Deep diving' && ++attempts === 2) throw Error('ambiguous network failure');
    return original(method, params);
  };
  const outputs = [{ id: 'long', text: 'A'.repeat(5000) }];
  await assert.rejects(f.run({ outputs }), /ambiguous/);
  const ids = [...f.data.get('console:run:s:1').outputs[0].messageIds];
  assert.equal(ids.length, 1);
  await assert.rejects(f.run({ outputs, final: true }), /automatic resend suppressed/);
  assert.equal(attempts, 2);
  assert.deepEqual(f.data.get('console:run:s:1').outputs[0].messageIds, ids);
});
