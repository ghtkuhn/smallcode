'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractNumPredict,
  resolveKnownOutputLimit,
  resolveOutputLimit,
  clearOutputLimitCache,
} = require('../src/model/output_limit');

test('extractNumPredict handles Ollama show payloads and direct model metadata', () => {
  assert.equal(extractNumPredict({ num_predict: 4096 }), 4096);
  assert.equal(extractNumPredict({ numPredict: 6144 }), 6144);
  assert.equal(extractNumPredict({ parameters: 'num_ctx 32768\nnum_predict 12288\nstop "<eos>"' }), 12288);
  assert.equal(extractNumPredict({ parameters: { num_predict: 2048 } }), 2048);
  assert.equal(extractNumPredict({ parameters: 'num_predict -1' }), 0);
});

test('known output limit prefers environment, then num_predict, then fallback', () => {
  assert.equal(resolveKnownOutputLimit({ numPredict: 4096 }, { SMALLCODE_MAX_OUTPUT_TOKENS: '12000' }), 12000);
  assert.equal(resolveKnownOutputLimit({ numPredict: 4096 }, {}), 4096);
  assert.equal(resolveKnownOutputLimit({}, {}), 8192);
});

test('Ollama output limit is discovered once per model through api/show', async () => {
  clearOutputLimitCache();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ parameters: 'num_ctx 32768\nnum_predict 16384' }) };
  };
  const target = { provider: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'gemma-4:latest' };
  assert.equal(await resolveOutputLimit(target, { env: {}, fetchImpl }), 16384);
  assert.equal(await resolveOutputLimit(target, { env: {}, fetchImpl }), 16384);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://localhost:11434/api/show');
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: 'gemma-4:latest' });
});

test('non-Ollama and unavailable num_predict use the static fallback', async () => {
  assert.equal(await resolveOutputLimit({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' }, { env: {} }), 8192);
});
