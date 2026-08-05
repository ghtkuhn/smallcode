'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentRunController } = require('../src/session/agent_run_controller');
const { FullScreenTUI } = require('../src/tui/fullscreen');
const { runProcess } = require('../src/tools/process_runner');

test('run controller exposes phases and aborts registered work', () => {
  const states = [];
  let aborted = false;
  const controller = new AgentRunController(state => states.push(state.phase));
  controller.begin({ input: 'task' });
  controller.registerAbortable(() => { aborted = true; });
  controller.setPhase('tool');
  assert.equal(controller.cancel(), true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(aborted, true);
  controller.finish();
  assert.deepEqual(states, ['thinking', 'tool', 'cancelling', 'idle']);
});

test('queue can inspect, drop and clear pending messages', async () => {
  let release;
  const tui = new FullScreenTUI({ onSubmit: () => new Promise(resolve => { release = resolve; }) });
  tui.render = () => {};
  const first = tui._enqueueSubmit('active');
  await new Promise(resolve => setImmediate(resolve));
  const second = tui._enqueueSubmit('second');
  const third = tui._enqueueSubmit('third');
  assert.deepEqual(tui.getQueue().items.map(x => x.input), ['second', 'third']);
  assert.equal(tui.dropQueued(1), true);
  assert.equal(tui.clearQueue(), 1);
  release();
  await Promise.all([first, second, third]);
  assert.equal(tui.isStreaming, false);
});

test('TUI run status exposes explicit phase and queue count', () => {
  const tui = new FullScreenTUI();
  tui.render = () => {};
  tui.setRunState({ active: true, phase: 'retry', elapsedMs: 2200 });
  tui.isStreaming = true;
  const rendered = tui._renderStatus();
  assert.match(rendered, /retry/);
  tui.setRunState({ active: false, phase: 'idle' });
  assert.equal(tui.runPhase, 'idle');
});

test('abort signal terminates an asynchronous shell process', async () => {
  const controller = new AbortController();
  const running = runProcess(process.platform === 'win32' ? 'ping -n 30 127.0.0.1' : 'sleep 30', { signal: controller.signal, timeout: 60000 });
  setTimeout(() => controller.abort(), 20);
  const result = await running;
  assert.equal(result.cancelled, true);
});
