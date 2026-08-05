'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const createCommandHandler = require('../bin/commands');
const { AgentRunController } = require('../src/session/agent_run_controller');

function handler(runtime) {
  return createCommandHandler({ model: {} }, [], {}, null, null, 0, null, null, null, runtime);
}

test('/cancel aborts active run and clears queued messages', async () => {
  const runController = new AgentRunController();
  runController.begin();
  let cleared = 0;
  const command = handler({ runController, clearQueue: () => { cleared = 2; return cleared; } });
  const original = console.log;
  console.log = () => {};
  try { await command('/cancel', { prompt() {} }); } finally { console.log = original; }
  assert.equal(runController.signal.aborted, true);
  assert.equal(cleared, 2);
});

test('/queue drop and clear delegate to live TUI queue', async () => {
  const calls = [];
  const command = handler({ dropQueued: n => { calls.push(['drop', n]); return true; }, clearQueue: () => { calls.push(['clear']); return 3; } });
  const original = console.log;
  console.log = () => {};
  try {
    await command('/queue drop 2', { prompt() {} });
    await command('/queue clear', { prompt() {} });
  } finally { console.log = original; }
  assert.deepEqual(calls, [['drop', '2'], ['clear']]);
});
