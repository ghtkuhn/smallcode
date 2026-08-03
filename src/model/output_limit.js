'use strict';

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const modelLimitCache = new Map();

function positiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function extractNumPredict(value) {
  if (!value || typeof value !== 'object') return 0;
  for (const candidate of [value.num_predict, value.numPredict, value.options?.num_predict]) {
    const parsed = positiveInteger(candidate);
    if (parsed) return parsed;
  }
  if (value.parameters && typeof value.parameters === 'object') {
    const parsed = positiveInteger(value.parameters.num_predict);
    if (parsed) return parsed;
  }
  if (typeof value.parameters === 'string') {
    const match = value.parameters.match(/(?:^|\n)\s*num_predict\s+(-?\d+)\s*(?:$|\n)/i);
    if (match) return positiveInteger(match[1]);
  }
  return 0;
}

function explicitOutputLimit(env = process.env) {
  return positiveInteger(env.SMALLCODE_MAX_OUTPUT_TOKENS);
}

function resolveKnownOutputLimit(model, env = process.env) {
  return explicitOutputLimit(env) || extractNumPredict(model) || DEFAULT_MAX_OUTPUT_TOKENS;
}

function isOllamaTarget(target = {}) {
  const url = String(target.baseUrl || '').toLowerCase();
  return target.provider === 'ollama' || url.includes(':11434') || url.includes('ollama');
}

async function discoverOllamaNumPredict(target, options = {}) {
  if (!isOllamaTarget(target) || !target.model) return 0;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return 0;
  const host = String(target.baseUrl || 'http://localhost:11434')
    .replace(/\/v1\/?$/, '')
    .replace(/\/+$/, '');
  const key = `${host}\n${target.model}`;
  if (modelLimitCache.has(key)) return modelLimitCache.get(key);

  let result = 0;
  try {
    const response = await fetchImpl(`${host}/api/show`, {
      method: 'POST',
      headers: options.headers || { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: target.model }),
    });
    if (response.ok) result = extractNumPredict(await response.json());
  } catch {}
  modelLimitCache.set(key, result);
  return result;
}

async function resolveOutputLimit(target, options = {}) {
  const envLimit = explicitOutputLimit(options.env || process.env);
  if (envLimit) return envLimit;
  const known = extractNumPredict(target);
  if (known) return known;
  return (await discoverOllamaNumPredict(target, options)) || DEFAULT_MAX_OUTPUT_TOKENS;
}

function clearOutputLimitCache() {
  modelLimitCache.clear();
}

module.exports = {
  DEFAULT_MAX_OUTPUT_TOKENS,
  extractNumPredict,
  resolveKnownOutputLimit,
  resolveOutputLimit,
  clearOutputLimitCache,
};
