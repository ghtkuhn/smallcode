'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { PluginLoader } = require('../src/plugins/loader');
const hook = require('../.smallcode/plugins/gemma4-history-filter/hook');

test('recognizes Gemma 4 model names without matching other Gemma versions', () => {
  assert.equal(hook.isGemma4Model('gemma-4-e4b'), true);
  assert.equal(hook.isGemma4Model('org/gemma_4.27b'), true);
  assert.equal(hook.isGemma4Model('gemma3:27b'), false);
  assert.equal(hook.isGemma4Model('mygemma-4'), false);
});

test('project plugin removes replayed reasoning fields only for Gemma 4', async () => {
  const loader = new PluginLoader(path.resolve(__dirname, '..')).loadAll();
  const gemmaPlugins = loader.plugins.filter(plugin => plugin.name === 'gemma4-history-filter');
  assert.ok(gemmaPlugins.length >= 1, 'Gemma 4 plugin should be registered from the project');

  const messages = [
    { role: 'assistant', content: 'answer', reasoning_content: 'private', reasoning: 'private', reasoning_text: 'private' },
    { role: 'user', content: 'next question', reasoning_content: 'keep non-assistant fields' },
  ];
  await loader.runHooks('pre_request', { model: 'gemma-4-e4b', messages });

  assert.deepEqual(messages, [
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'next question', reasoning_content: 'keep non-assistant fields' },
  ]);

  const otherModelMessages = [
    { role: 'assistant', content: 'answer', reasoning_content: 'keep' },
  ];
  await loader.runHooks('pre_request', { model: 'qwen3:8b', messages: otherModelMessages });
  assert.equal(otherModelMessages[0].reasoning_content, 'keep');
});
