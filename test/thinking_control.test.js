'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ThinkingState,
  THINKING_LEVELS,
  budgetForLevel,
} = require('../src/model/thinking_state');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyThinkingBudget } = require('../src/model/thinking_budget');
const { FullScreenTUI } = require('../src/tui/fullscreen');
const createCommandHandler = require('../bin/commands');

test('thinking presets scale dynamically from max output tokens', () => {
  assert.deepEqual(THINKING_LEVELS, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(budgetForLevel('off', 10000), 0);
  assert.equal(budgetForLevel('minimal', 10000), 1000);
  assert.equal(budgetForLevel('low', 10000), 2000);
  assert.equal(budgetForLevel('medium', 10000), 4000);
  assert.equal(budgetForLevel('high', 10000), 6000);
  assert.equal(budgetForLevel('xhigh', 10000), 8000);
  assert.equal(budgetForLevel('max', 10000), 10000);
  assert.equal(budgetForLevel('unlimited', 8192), 8192);
});

test('thinking state defaults to low and preserves environment overrides', () => {
  const defaults = new ThinkingState({});
  assert.equal(defaults.snapshot(8192).label, 'low');
  assert.equal(defaults.snapshot(8192).tokens, 1638);
  assert.equal(defaults.resolve(1000).tokens, 200);

  const custom = new ThinkingState({ SMALLCODE_THINKING_BUDGET: '1234' });
  assert.equal(custom.resolve(8192).tokens, 1234);

  const disabled = new ThinkingState({ SMALLCODE_THINKING_DISABLE: 'true', SMALLCODE_THINKING_BUDGET: '1234' });
  assert.equal(disabled.snapshot().level, 'off');
  assert.equal(disabled.resolve().tokens, 0);
});

test('thinking state accepts presets and unlimited alias without persisting', () => {
  const state = new ThinkingState({});
  assert.equal(state.setLevel('medium').ok, true);
  assert.equal(state.resolve(5000).tokens, 2000);
  assert.equal(state.setLevel('unlimited').level, 'max');
  assert.equal(state.resolve(5000).tokens, 5000);
  const before = state.snapshot();
  assert.equal(state.setLevel('invalid').ok, false);
  assert.deepEqual(state.snapshot(), before);
});

test('thinking preset is remembered across sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smallcode-thinking-'));
  const preferenceFile = path.join(dir, 'thinking.json');
  try {
    const first = new ThinkingState({}, { preferenceFile });
    assert.equal(first.setLevel('xhigh').ok, true);

    const next = new ThinkingState({}, { preferenceFile });
    assert.equal(next.snapshot().level, 'xhigh');
    assert.equal(next.snapshot().label, 'xhigh');

    const overridden = new ThinkingState({ SMALLCODE_THINKING_BUDGET: '1234' }, { preferenceFile });
    assert.equal(overridden.snapshot().level, 'custom');
    assert.equal(overridden.snapshot().tokens, 1234);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('provider request mapping handles Ollama levels and GPT-OSS clamping', () => {
  const qwen = { model: 'qwen3:8b', max_tokens: 8192, chat_template_kwargs: { thinking_budget: 99 } };
  applyThinkingBudget(qwen, { baseUrl: 'http://localhost:11434/v1', level: 'off', tokens: 0 });
  assert.equal(qwen.reasoning_effort, 'none');
  assert.equal(qwen.chat_template_kwargs, undefined);
  assert.equal(qwen.enable_thinking, undefined);

  const gptOss = { model: 'gpt-oss:20b', max_tokens: 8192 };
  applyThinkingBudget(gptOss, { baseUrl: 'http://localhost:11434/v1', level: 'off', tokens: 0 });
  assert.equal(gptOss.reasoning_effort, 'low');

  const medium = { model: 'qwen3:8b', max_tokens: 8192 };
  applyThinkingBudget(medium, { baseUrl: 'http://localhost:11434/v1', level: 'medium', tokens: 3277 });
  assert.equal(medium.reasoning_effort, 'medium');
});

test('provider request mapping handles llama.cpp, Anthropic, and OpenAI', () => {
  const local = { model: 'gemma-4-e4b', max_tokens: 10000 };
  applyThinkingBudget(local, { baseUrl: 'http://localhost:1234/v1', level: 'medium', tokens: 4000 });
  assert.deepEqual(local.chat_template_kwargs, { enable_thinking: true, thinking_budget: 4000 });
  assert.equal(local.enable_thinking, true);

  applyThinkingBudget(local, { baseUrl: 'http://localhost:1234/v1', level: 'off', tokens: 0 });
  assert.deepEqual(local.chat_template_kwargs, { enable_thinking: false });
  assert.equal(local.enable_thinking, false);

  const anthropic = { model: 'claude-4-sonnet', max_tokens: 8192 };
  applyThinkingBudget(anthropic, { baseUrl: 'https://api.anthropic.com/v1', level: 'max', tokens: 8192 });
  assert.deepEqual(anthropic.thinking, { type: 'enabled', budget_tokens: 7168 });

  const gpt5 = { model: 'gpt-5', max_tokens: 8192 };
  applyThinkingBudget(gpt5, { baseUrl: 'https://api.openai.com/v1', level: 'off', tokens: 0 });
  assert.equal(gpt5.reasoning_effort, 'none');

  const o3 = { model: 'o3-mini', max_tokens: 8192 };
  applyThinkingBudget(o3, { baseUrl: 'https://api.openai.com/v1', level: 'max', tokens: 8192 });
  assert.equal(o3.reasoning_effort, 'high');
});

test('generic picker preselects, navigates, selects, and cancels', async () => {
  const selected = [];
  const tui = new FullScreenTUI();
  tui.openPicker({
    title: 'Preset',
    selected: 'low',
    items: [
      { value: 'off', label: 'off', detail: '0%' },
      { value: 'low', label: 'low', detail: '20%' },
      { value: 'high', label: 'high', detail: '60%' },
    ],
    onSelect: value => selected.push(value),
  });
  assert.equal(tui.picker.selection, 1);
  await tui._onKeypress(Buffer.from('\x1b[B'));
  await tui._onKeypress(Buffer.from('\r'));
  assert.deepEqual(selected, ['high']);
  assert.equal(tui.picker, null);

  tui.openPicker({ items: [{ value: 'off', label: 'off' }] });
  await tui._onKeypress(Buffer.from('\x1b'));
  assert.equal(tui.picker, null);
});

test('/think direct arguments update state and invalid input does not', async () => {
  const state = new ThinkingState({});
  const changes = [];
  const handler = createCommandHandler(
    { model: { name: 'qwen3:8b', baseUrl: 'http://localhost:11434/v1' } },
    [], {}, null, null, 0, null, null, null,
    { thinkingState: state, onThinkingChange: snapshot => changes.push(snapshot.level) },
  );
  const rl = { prompt() {}, close() {} };
  await handler('/think high', rl);
  assert.equal(state.snapshot().level, 'high');
  await handler('/think unlimited', rl);
  assert.equal(state.snapshot().level, 'max');
  await handler('/think invalid', rl);
  assert.equal(state.snapshot().level, 'max');
  assert.deepEqual(changes, ['high', 'max']);
});

test('/think without an argument opens the preset picker when available', async () => {
  const state = new ThinkingState({});
  let picker;
  const handler = createCommandHandler(
    { model: { name: 'qwen3:8b', baseUrl: 'http://localhost:11434/v1' } },
    [], {}, null, null, 0, null, null, null,
    { thinkingState: state, openPicker: options => { picker = options; } },
  );
  await handler('/think', { prompt() {}, close() {} });
  assert.equal(picker.title, 'Thinking preset');
  assert.deepEqual(picker.items.map(item => item.value), THINKING_LEVELS);
  picker.onSelect('minimal');
  assert.equal(state.snapshot().level, 'minimal');
});
