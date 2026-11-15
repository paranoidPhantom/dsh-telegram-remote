import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramConsole } from '../console.js';
import { toolLogPages } from '../console-render.js';

function fixture(t) {
  const calls = [], data = new Map([['console:topic:s', { chatId: 1, threadId: 2 }]]);
  let next = 100, scans = 0;
  const api = { async call(method, params) { calls.push({ method, params }); return method === 'sendMessage' ? { message_id: ++next } : true; } };
  const store = { async get(key) { return structuredClone(data.get(key)); }, async set(key, value) { data.set(key, structuredClone(value)); }, async entries() { scans++; return [...data]; } };
  const console = new TelegramConsole({ api, store, bridge: {}, ownerId: 1 });
  t.after(() => console.close());
  return { console, calls, data, get scans() { return scans; } };
}

test('unchanged frames do not edit pages or regenerate callback tokens; native draft needs no typing', async t => {
  const f = fixture(t), view = { turn: 1, partialAnswer: 'answer', toolLog: [{ name: 'read', summary: 'source', status: 'running' }] };
  await f.console.onRun('s', view);
  const before = f.calls.length, tokens = f.console.actions.size;
  for (let i = 0; i < 5; i++) await f.console.onRun('s', view);
  assert.equal(f.calls.slice(before).filter(c => c.method === 'editMessageText').length, 0);
  assert.equal(f.console.actions.size, tokens);
  assert.equal(f.calls.filter(c => c.method === 'sendChatAction').length, 0);
  assert.ok(f.calls.filter(c => c.method === 'sendMessageDraft').every(c => c.params.can_stop));
});

test('long log last-row update edits only its last page', async t => {
  const f = fixture(t);
  const tools = Array.from({ length: 80 }, (_, i) => ({ name: `tool-${i}`, summary: 'x'.repeat(150), status: 'completed' }));
  tools.at(-1).status = 'running';
  assert.ok(toolLogPages(tools).length > 1);
  const lastLoggedTool = tools.at(-1);
  tools.push({ name: 'Latest sentinel', status: 'running' });
  await f.console.onRun('s', { turn: 1, toolLog: tools });
  const ids = f.data.get('console:run:s:1').logMessageIds, before = f.calls.length;
  lastLoggedTool.status = 'completed';
  await f.console.onRun('s', { turn: 1, toolLog: tools });
  assert.deepEqual(f.calls.slice(before).filter(c => c.method === 'editMessageText').map(c => c.params.message_id), [ids.at(-1)]);
});

test('slow heartbeat has one pending slot per session and never replays stale view', async t => {
  const f = fixture(t);
  await f.console.onRun('s', { turn: 1, partialAnswer: 'initial' });
  const original = f.console.api.call.bind(f.console.api);
  let release, started;
  const gate = new Promise(r => { release = r; }), began = new Promise(r => { started = r; });
  f.console.api.call = async (method, params) => {
    if (method === 'sendMessageDraft') { started(); await gate; }
    return original(method, params);
  };
  const before = f.calls.length, first = f.console.refreshDrafts();
  await began;
  const pulses = Array.from({ length: 25 }, () => f.console.refreshDrafts());
  assert.equal(f.console.delivery.heartbeats.size, 1);
  release();
  await Promise.all([first, ...pulses]);
  assert.equal(f.calls.slice(before).filter(c => c.method === 'sendMessageDraft').length, 1);
  assert.equal(f.console.delivery.heartbeats.size, 0);
});

test('legacy cleanup scans history once, later turns clear only current controls', async t => {
  const f = fixture(t);
  for (let i = 0; i < 100; i++) f.data.set(`console:run:s:old${i}`, { final: true, messageId: i + 1000 });
  await f.console.onRun('s', { turn: 1 });
  const scans = f.scans, before = f.calls.length;
  await f.console.onRun('s', { turn: 2 });
  assert.equal(f.scans - scans, 1); // latest()'s topic lookup, not another history migration.
  assert.ok(f.calls.slice(before).filter(c => c.method === 'editMessageReplyMarkup').every(c => c.params.message_id < 1000));
  assert.equal(f.data.get('console:run:s:1').superseded, true);
});

test('ownership changes invalidate controls without rewriting unrelated pages', async t => {
  const f = fixture(t), view = { turn: 1, toolLog: [{ name: 'read', status: 'running' }, { name: 'Latest sentinel', status: 'running' }] };
  await f.console.onRun('s', view);
  const id = f.data.get('console:run:s:1').logMessageIds[0];
  await f.console.latest({ chatId: 1, threadId: 2 }, 999);
  const before = f.calls.length;
  await f.console.onRun('s', view);
  const edits = f.calls.slice(before).filter(c => c.method === 'editMessageText');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].params.message_id, id);
  assert.deepEqual(edits[0].params.reply_markup.inline_keyboard, []);
  assert.equal(f.data.get('console:topic:s').latestControlMessageId, 999);
});
