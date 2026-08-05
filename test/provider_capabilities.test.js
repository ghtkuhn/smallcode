'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CapabilityStore, probeCapabilities } = require('../src/model/provider_capabilities');

function response(ok, body = '{}', type = 'application/json') {
  return { ok, text: async () => body, headers: { get: name => name === 'content-type' ? type : 'test-server' }, body: { cancel: async () => {} } };
}

test('capability probe performs deep probes once per fingerprint and keeps startup streaming probe', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smallcode-caps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CapabilityStore(path.join(dir, 'caps.json'));
  let calls = 0;
  const fetch = async (url, options = {}) => {
    calls++;
    if (url.endsWith('/models')) return response(true, '{"data":[{"id":"model"}]}');
    const body = JSON.parse(options.body);
    return response(true, '{}', body.stream ? 'text/event-stream' : 'application/json');
  };
  const target = { provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'model' };
  const first = await probeCapabilities(target, { fetch, store });
  assert.equal(first.streaming.value, true);
  assert.equal(first.toolCalls.source, 'probed');
  assert.equal(calls, 6);
  calls = 0;
  const second = await probeCapabilities(target, { fetch, store });
  assert.equal(calls, 2);
  assert.equal(second.jsonSchema.value, true);
});

test('probe failure is non-throwing and retains fallback capabilities', async () => {
  const caps = await probeCapabilities({ baseUrl: 'http://offline', model: 'qwen3' }, { fetch: async () => { throw new Error('offline'); } });
  assert.equal(caps.reachable.value, false);
  assert.equal(caps.toolCalls.value, true);
});
