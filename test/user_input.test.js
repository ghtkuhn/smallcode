'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UserInputBroker, QuestionStore, normalizeRequest } = require('../src/session/user_input');
const { FullScreenTUI } = require('../src/tui/fullscreen');
const { SmallCode } = require('../src/api');

function fixture(interact = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smallcode-questions-'));
  const store = new QuestionStore({ workspaceRoot: root, dir: path.join(root, 'cache') });
  return { root, store, broker: new UserInputBroker({ workspaceRoot: root, store, interact }) };
}

function input() {
  return { questions: [
    { id: 'scope', header: 'Scope', question: 'Where?', options: [{ label: 'TUI', description: 'Terminal only' }, { label: 'All', description: 'Every surface' }] },
    { id: 'style', header: 'Style', question: 'Which style?', options: [{ label: 'Simple', description: 'Minimal' }, { label: 'Rich', description: 'Detailed' }] },
  ] };
}

test('question schema accepts 1-3 complete questions and rejects invalid requests', () => {
  assert.equal(normalizeRequest(input()).ok, true);
  assert.equal(normalizeRequest({ questions: [] }).ok, false);
  assert.equal(normalizeRequest({ questions: [input().questions[0], input().questions[0]] }).ok, false);
  assert.equal(normalizeRequest({ questions: [{ ...input().questions[0], options: [input().questions[0].options[0]] }] }).ok, false);
});

test('broker persists pending, answered, paused, and validates complete answers', async () => {
  const { broker, store } = fixture();
  const pending = await broker.request(input(), { planId: 'plan-x', planRevision: 1 });
  assert.equal(pending.pending, true); assert.equal(store.listPending().length, 1);
  assert.equal(broker.answer(pending.request.id, { scope: 'All' }).ok, false);
  const answered = broker.answer(pending.request.id, { scope: 'All', style: 'My own style' });
  assert.equal(answered.ok, true); assert.equal(answered.answers.style.custom, true);
  const next = await broker.request(input(), { planId: 'plan-x', planRevision: 2 });
  assert.equal(broker.pause(next.request.id), true); assert.equal(store.load(next.request.id).status, 'paused');
});

test('broker limits clarification rounds per plan revision', async () => {
  const { broker } = fixture();
  for (let i = 0; i < 3; i++) assert.equal((await broker.request(input(), { planId: 'p', planRevision: 1 })).ok, true);
  assert.equal((await broker.request(input(), { planId: 'p', planRevision: 1 })).ok, false);
});

test('fullscreen question flow selects options sequentially', async () => {
  const tui = new FullScreenTUI({ model: 'test' }); tui.render = () => {};
  const pending = tui.openQuestionFlow({ id: 'q', questions: input().questions });
  await tui._onKeypress('\x1b[B'); await tui._onKeypress('\r');
  await tui._onKeypress('\r');
  const answers = await pending;
  assert.deepEqual(answers, { scope: { value: 'All', custom: false }, style: { value: 'Simple', custom: false } });
});

test('fullscreen supports custom answer and escape pause', async () => {
  const tui = new FullScreenTUI({ model: 'test' }); tui.render = () => {};
  const one = { id: 'q', questions: [input().questions[0]] };
  const customPending = tui.openQuestionFlow(one);
  await tui._onKeypress('\x1b[B'); await tui._onKeypress('\x1b[B'); await tui._onKeypress('\r');
  await tui._onKeypress('Custom scope'); await tui._onKeypress('\r');
  assert.equal((await customPending).scope.custom, true);
  const paused = tui.openQuestionFlow(one); await tui._onKeypress('\x1b'); assert.equal(await paused, null);
});

test('API exposes pending questions only in plan mode', async () => {
  const { root } = fixture();
  const api = new SmallCode({ cwd: root, questionStoreDir: path.join(root, 'api-questions'), planStoreDir: path.join(root, 'api-plans') });
  const pending = await api._executeTool('request_user_input', input());
  assert.equal(pending.pending, true); assert.equal(api.getPendingQuestions().length, 1);
  assert.equal(api._getTools().some(tool => tool.function.name === 'request_user_input'), true);
  const answered = api.questionBroker.answer(pending.questionRequest.id, { scope: 'TUI', style: 'Simple' });
  assert.equal(answered.ok, true);
  const direct = new SmallCode({ cwd: root, planning: { enabled: false } });
  assert.equal(direct._getTools().some(tool => tool.function.name === 'request_user_input'), false);
  assert.equal((await direct._executeTool('request_user_input', input())).kind, 'mode_policy');
});

test('API run returns a typed pending result and emits input_required', async () => {
  const { root } = fixture();
  const previousFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'request_user_input', arguments: JSON.stringify(input()) } }] } }] }) });
  try {
    const api = new SmallCode({ cwd: root, model: 'test', baseUrl: 'http://localhost:1/v1', questionStoreDir: path.join(root, 'run-questions'), planStoreDir: path.join(root, 'run-plans') });
    let event = null; api.on('input_required', request => { event = request; });
    const result = await api.run('Plan a configurable feature');
    assert.equal(result.success, true); assert.equal(result.requiresInput, true);
    assert.equal(result.questionRequestId, event.id);
  } finally { global.fetch = previousFetch; }
});
