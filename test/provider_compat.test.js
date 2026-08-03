// Regression tests for provider compatibility fixes.
//
// Covers:
//   - buildAuthHeaders routes the correct API key based on target URL (Bug 7)
//   - applyThinkingBudget does NOT inject unknown fields to Ollama (Bug 2/5)
//   - applyThinkingBudget only sends reasoning_effort to OpenAI cloud (Bug 2)
//   - max_completion_tokens rename for OpenAI reasoning models (Bug 3)

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ─── Bug 7: provider-aware auth routing ─────────────────────────────────────

const { buildAuthHeaders, getModelTarget, withModelTarget } = require('../bin/config');

test('buildAuthHeaders picks DEEPSEEK_API_KEY for api.deepseek.com', () => {
  const prev = { ...process.env };
  process.env.OPENAI_API_KEY = 'sk-openai';
  process.env.DEEPSEEK_API_KEY = 'sk-deep';
  try {
    const h = buildAuthHeaders({ model: { baseUrl: 'https://api.deepseek.com/v1' } });
    assert.equal(h['Authorization'], 'Bearer sk-deep');
  } finally {
    process.env = prev;
  }
});

test('buildAuthHeaders picks OPENAI_API_KEY for api.openai.com', () => {
  const prev = { ...process.env };
  process.env.OPENAI_API_KEY = 'sk-openai';
  process.env.DEEPSEEK_API_KEY = 'sk-deep';
  try {
    const h = buildAuthHeaders({ model: { baseUrl: 'https://api.openai.com/v1' } });
    assert.equal(h['Authorization'], 'Bearer sk-openai');
  } finally {
    process.env = prev;
  }
});

test('buildAuthHeaders picks OPENROUTER_API_KEY for openrouter.ai', () => {
  const prev = { ...process.env };
  process.env.OPENAI_API_KEY = 'sk-openai';
  process.env.OPENROUTER_API_KEY = 'sk-router';
  try {
    const h = buildAuthHeaders({ model: { baseUrl: 'https://openrouter.ai/api/v1' } });
    assert.equal(h['Authorization'], 'Bearer sk-router');
    assert.ok(h['HTTP-Referer']);
    assert.ok(h['X-Title']);
  } finally {
    process.env = prev;
  }
});

test('buildAuthHeaders picks ANTHROPIC_API_KEY for anthropic.com', () => {
  const prev = { ...process.env };
  process.env.OPENAI_API_KEY = 'sk-openai';
  process.env.ANTHROPIC_API_KEY = 'sk-ant';
  try {
    const h = buildAuthHeaders({ model: { baseUrl: 'https://api.anthropic.com/v1' } });
    assert.equal(h['Authorization'], 'Bearer sk-ant');
  } finally {
    process.env = prev;
  }
});

test('buildAuthHeaders falls back to any key for local endpoints', () => {
  const prev = { ...process.env };
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.SMALLCODE_API_KEY;
  try {
    const h = buildAuthHeaders({ model: { baseUrl: 'http://localhost:1234/v1' } });
    // No key set → no auth header
    assert.equal(h['Authorization'], undefined);
  } finally {
    process.env = prev;
  }
});

test('buildAuthHeaders uses SMALLCODE_API_KEY for local endpoints when set', () => {
  const prev = { ...process.env };
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.SMALLCODE_API_KEY = 'sk-local';
  try {
    const h = buildAuthHeaders({ model: { baseUrl: 'http://10.0.0.20:1234/v1' } });
    assert.equal(h['Authorization'], 'Bearer sk-local');
  } finally {
    process.env = prev;
  }
});

test('per-tier OpenRouter target gets OpenRouter auth without changing local target', () => {
  const prev = { ...process.env };
  delete process.env.OPENAI_API_KEY;
  delete process.env.SMALLCODE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-router';
  try {
    const config = {
      model: { name: 'local', baseUrl: 'http://localhost:11434/v1', provider: 'openai' },
      models: {
        strong: { name: 'openrouter/large', baseUrl: 'https://openrouter.ai/api/v1', provider: 'openai' },
      },
    };

    const localHeaders = buildAuthHeaders(config);
    assert.equal(localHeaders.Authorization, undefined);

    const strongTarget = getModelTarget(config, 'strong');
    const strongHeaders = buildAuthHeaders(withModelTarget(config, strongTarget));
    assert.equal(strongHeaders.Authorization, 'Bearer sk-router');
    assert.ok(strongHeaders['HTTP-Referer']);
    assert.ok(strongHeaders['X-Title']);
  } finally {
    process.env = prev;
  }
});

// ─── Bug 2/5: thinking budget provider detection ────────────────────────────

const { applyThinkingBudget } = require('../src/model/thinking_budget');

test('applyThinkingBudget does NOT add body.thinking for Ollama', () => {
  const body = { model: 'qwen3-coder:latest' };
  applyThinkingBudget(body, { baseUrl: 'http://localhost:11434/v1' });
  assert.equal(body.thinking, undefined, 'body.thinking must not be set for Ollama');
  assert.equal(body.chat_template_kwargs, undefined, 'chat_template_kwargs must not be set for Ollama');
});

test('applyThinkingBudget does NOT add body.thinking for OpenAI cloud', () => {
  const body = { model: 'o3-mini' };
  applyThinkingBudget(body, { baseUrl: 'https://api.openai.com/v1' });
  assert.equal(body.thinking, undefined, 'body.thinking must not be set for OpenAI');
});

test('applyThinkingBudget DOES add body.thinking for Anthropic', () => {
  const body = { model: 'claude-4-sonnet' };
  applyThinkingBudget(body, { baseUrl: 'https://api.anthropic.com/v1' });
  assert.ok(body.thinking, 'body.thinking should be set for Anthropic');
  assert.equal(body.thinking.type, 'enabled');
});

test('applyThinkingBudget adds reasoning_effort ONLY for OpenAI cloud reasoning models', () => {
  // OpenAI cloud + o3 → should have reasoning_effort
  const body1 = { model: 'o3-mini' };
  applyThinkingBudget(body1, { baseUrl: 'https://api.openai.com/v1' });
  assert.ok(body1.reasoning_effort, 'reasoning_effort should be set for OpenAI o3');

  // Local server + o3 → should NOT have reasoning_effort
  const body2 = { model: 'o3-mini' };
  applyThinkingBudget(body2, { baseUrl: 'http://localhost:1234/v1' });
  assert.equal(body2.reasoning_effort, undefined, 'reasoning_effort must not be set for local o3');

  // OpenAI cloud + gpt-4o → should NOT (not a reasoning model)
  const body3 = { model: 'gpt-4o' };
  applyThinkingBudget(body3, { baseUrl: 'https://api.openai.com/v1' });
  assert.equal(body3.reasoning_effort, undefined, 'reasoning_effort must not be set for gpt-4o');
});

test('applyThinkingBudget adds chat_template_kwargs only for llama.cpp (not Ollama)', () => {
  // LM Studio (port 1234) + qwen3 → should get chat_template_kwargs
  const body1 = { model: 'qwen3-coder-32b' };
  applyThinkingBudget(body1, { baseUrl: 'http://localhost:1234/v1' });
  assert.ok(body1.chat_template_kwargs, 'chat_template_kwargs for LM Studio qwen3');
  assert.ok(body1.enable_thinking !== undefined, 'enable_thinking for LM Studio qwen3');

  // Ollama (port 11434) + qwen3 → should NOT get chat_template_kwargs
  const body2 = { model: 'qwen3-coder:latest' };
  applyThinkingBudget(body2, { baseUrl: 'http://localhost:11434/v1' });
  assert.equal(body2.chat_template_kwargs, undefined, 'no chat_template_kwargs for Ollama');
  assert.equal(body2.enable_thinking, undefined, 'no enable_thinking for Ollama');
});

test('applyThinkingBudget recognizes Gemma 4 as a local reasoning model', () => {
  const body = { model: 'gemma-4-e4b-it' };
  applyThinkingBudget(body, { baseUrl: 'http://localhost:1234/v1' });
  assert.equal(body.thinking, undefined);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.chat_template_kwargs.enable_thinking, true);
  assert.equal(body.enable_thinking, true);
});

// ─── Bug 3: max_completion_tokens for OpenAI reasoning models ───────────────
// (The actual rename happens in bin/smallcode.js chatCompletion, but we can
// test the logic inline here since it's a simple conditional.)

test('max_tokens → max_completion_tokens for OpenAI cloud o1/o3/o4', () => {
  // Simulating the rename logic from bin/smallcode.js:
  function applyMaxTokensRename(body, baseUrl) {
    const _bUrl = (baseUrl || '').toLowerCase();
    const _isOpenAICloud = _bUrl.includes('api.openai.com') || _bUrl.includes('openrouter.ai');
    const _modelLower = String(body.model || '').toLowerCase();
    const _isReasoning = /(^|[\/\-_])(o1|o3|o4)/.test(_modelLower);
    if (_isOpenAICloud && _isReasoning && body.max_tokens && !body.max_completion_tokens) {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    }
  }

  const body1 = { model: 'o3-mini', max_tokens: 8192 };
  applyMaxTokensRename(body1, 'https://api.openai.com/v1');
  assert.equal(body1.max_completion_tokens, 8192);
  assert.equal(body1.max_tokens, undefined);

  const body2 = { model: 'o4-mini', max_tokens: 4096 };
  applyMaxTokensRename(body2, 'https://openrouter.ai/api/v1');
  assert.equal(body2.max_completion_tokens, 4096);
  assert.equal(body2.max_tokens, undefined);

  // Non-reasoning model on OpenAI → max_tokens stays
  const body3 = { model: 'gpt-4o', max_tokens: 8192 };
  applyMaxTokensRename(body3, 'https://api.openai.com/v1');
  assert.equal(body3.max_tokens, 8192);
  assert.equal(body3.max_completion_tokens, undefined);

  // Reasoning model on local → max_tokens stays (local servers use max_tokens)
  const body4 = { model: 'o3-mini', max_tokens: 8192 };
  applyMaxTokensRename(body4, 'http://localhost:1234/v1');
  assert.equal(body4.max_tokens, 8192);
  assert.equal(body4.max_completion_tokens, undefined);
});

// ─── Issue #59: Ollama on a remote server with URL-embedded basic auth ──────

test('buildAuthHeaders converts URL basic-auth userinfo into a Basic header', () => {
  const prev = { ...process.env };
  delete process.env.OPENAI_API_KEY;
  delete process.env.SMALLCODE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const h = buildAuthHeaders({ model: { baseUrl: 'https://user:password@192.168.0.114/ollama/' } });
    const expected = 'Basic ' + Buffer.from('user:password').toString('base64');
    assert.equal(h['Authorization'], expected);
  } finally {
    process.env = prev;
  }
});

test('buildAuthHeaders prefers an explicit API key over URL userinfo', () => {
  const prev = { ...process.env };
  process.env.SMALLCODE_API_KEY = 'sk-local';
  try {
    const h = buildAuthHeaders({ model: { baseUrl: 'https://user:password@host.local/ollama/' } });
    assert.equal(h['Authorization'], 'Bearer sk-local');
  } finally {
    process.env = prev;
  }
});

test('buildAuthHeaders leaves Authorization unset for a plain URL with no creds/key', () => {
  const prev = { ...process.env };
  delete process.env.OPENAI_API_KEY;
  delete process.env.SMALLCODE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const h = buildAuthHeaders({ model: { baseUrl: 'http://192.168.0.114:11434' } });
    assert.equal(h['Authorization'], undefined);
  } finally {
    process.env = prev;
  }
});

test('buildAuthHeaders decodes percent-encoded credentials in the URL', () => {
  const prev = { ...process.env };
  delete process.env.OPENAI_API_KEY;
  delete process.env.SMALLCODE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    // password is "p@ss:word" percent-encoded as p%40ss%3Aword
    const h = buildAuthHeaders({ model: { baseUrl: 'https://user:p%40ss%3Aword@host/ollama/' } });
    const expected = 'Basic ' + Buffer.from('user:p@ss:word').toString('base64');
    assert.equal(h['Authorization'], expected);
  } finally {
    process.env = prev;
  }
});
