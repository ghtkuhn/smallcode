'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { buildAuthHeaders } = require('../../bin/config');
const { resolveKnownOutputLimit, resolveOutputLimit } = require('./output_limit');

const CACHE_FILE = path.join(os.homedir(), '.cache', 'smallcode', 'provider-capabilities.json');

function sourced(value, source) { return { value, source }; }

function fallbackCapabilities(target = {}, declared = {}) {
  const local = !/api\.openai\.com|openrouter\.ai|anthropic\.com/i.test(target.baseUrl || '');
  const value = (key, fallback) => sourced(declared[key] ?? fallback, declared[key] !== undefined ? 'declared' : 'fallback');
  return {
    reachable: sourced(null, 'fallback'),
    streaming: value('streaming', true),
    reasoning: value('reasoning', /reason|qwen|deepseek|gemma-4|gpt-oss/i.test(target.model || '')),
    reasoningLevels: value('reasoningLevels', ['none', 'low', 'medium', 'high']),
    toolCalls: value('tools', true),
    streamingToolCalls: value('streamingToolCalls', true),
    parallelToolCalls: value('parallelToolCalls', !local),
    jsonSchema: value('jsonSchema', !local),
    maxOutputTokens: sourced(resolveKnownOutputLimit(target), 'profile'),
    fingerprint: null,
    checkedAt: null,
  };
}

class CapabilityStore {
  constructor(filePath = CACHE_FILE) { this.filePath = filePath; }
  read() {
    try { return JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch { return { version: 1, entries: {} }; }
  }
  key(target) {
    return crypto.createHash('sha256').update(`${target.provider || ''}\n${target.baseUrl || ''}\n${target.model || ''}`).digest('hex');
  }
  get(target) { return this.read().entries[this.key(target)] || null; }
  set(target, entry) {
    const data = this.read();
    data.entries[this.key(target)] = entry;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }
}

async function request(url, options, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try { return await fetchImpl(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function probeCapabilities(target, options = {}) {
  const fetchImpl = options.fetch || global.fetch;
  const store = options.store || new CapabilityStore();
  const declared = options.declared || {};
  const caps = fallbackCapabilities(target, declared);
  const baseUrl = String(target.baseUrl || '').replace(/\/$/, '');
  const headers = buildAuthHeaders({ model: target });
  const timeoutMs = options.timeoutMs || 5000;
  let fingerprint = `${target.provider || ''}:${target.model || ''}`;
  try {
    const models = await request(`${baseUrl}/models`, { headers }, timeoutMs, fetchImpl);
    const text = models.ok ? await models.text() : '';
    fingerprint = crypto.createHash('sha256').update(`${models.headers?.get?.('server') || ''}\n${text}`).digest('hex');
    caps.reachable = sourced(models.ok, 'probed');
    const outputLimit = await resolveOutputLimit(target, { headers, fetchImpl });
    caps.maxOutputTokens = sourced(outputLimit, outputLimit !== 8192 ? 'probed' : 'profile');
  } catch (error) {
    caps.reachable = sourced(false, 'probed');
    caps.error = error.message;
    return caps;
  }

  const cached = store.get(target);
  const useCached = !options.force && cached && cached.fingerprint === fingerprint;
  if (useCached) Object.assign(caps, cached.capabilities);

  const baseBody = { model: target.model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 1 };
  try {
    const streamResponse = await request(`${baseUrl}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify({ ...baseBody, stream: true }),
    }, timeoutMs, fetchImpl);
    caps.streaming = sourced(streamResponse.ok && /text\/event-stream/i.test(streamResponse.headers?.get?.('content-type') || ''), 'probed');
    try { await streamResponse.body?.cancel?.(); } catch {}
  } catch { caps.streaming = sourced(false, 'probed'); }

  if (!useCached || options.force) {
    const probes = [
      ['toolCalls', { tools: [{ type: 'function', function: { name: 'noop', description: 'noop', parameters: { type: 'object', properties: {} } } }] }],
      ['jsonSchema', { response_format: { type: 'json_schema', json_schema: { name: 'probe', schema: { type: 'object', properties: {} } } } }],
      ['reasoning', { reasoning_effort: 'low' }],
      ['parallelToolCalls', { parallel_tool_calls: true, tools: [{ type: 'function', function: { name: 'noop', description: 'noop', parameters: { type: 'object', properties: {} } } }] }],
    ];
    for (const [name, extra] of probes) {
      try {
        const response = await request(`${baseUrl}/chat/completions`, {
          method: 'POST', headers, body: JSON.stringify({ ...baseBody, ...extra, stream: false }),
        }, timeoutMs, fetchImpl);
        caps[name] = sourced(response.ok, 'probed');
      } catch { caps[name] = sourced(false, 'probed'); }
    }
    caps.streamingToolCalls = sourced(caps.streaming.value && caps.toolCalls.value, 'probed');
  }
  caps.fingerprint = fingerprint;
  caps.target = { provider: target.provider || '', baseUrl: target.baseUrl || '', model: target.model || '' };
  caps.checkedAt = new Date().toISOString();
  try { store.set(target, { fingerprint, capabilities: caps, checkedAt: caps.checkedAt }); } catch {}
  return caps;
}

function formatCapabilities(caps) {
  if (!caps) return 'Capabilities: not probed';
  const keys = ['reachable', 'streaming', 'reasoning', 'toolCalls', 'streamingToolCalls', 'parallelToolCalls', 'jsonSchema', 'maxOutputTokens'];
  return keys.map(key => `${key}: ${JSON.stringify(caps[key]?.value)} (${caps[key]?.source || 'unknown'})`).join('\n');
}

module.exports = { CapabilityStore, fallbackCapabilities, probeCapabilities, formatCapabilities, CACHE_FILE };
