// Regression tests for normalizeBaseUrl — closes issue #44.
//
// The bug: SMALLCODE_BASE_URL=http://localhost:11434 (no /v1) hit Ollama's
// native /api endpoint while config.js still routed through the OpenAI-
// compatible path, calling ${baseUrl}/models — which is a 404 on Ollama.
// Result: "Cannot reach endpoint at http://localhost:11434" even though
// Ollama was running.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, normalizeBaseUrl } = require('../bin/config');

test('Ollama bare host gets /v1 appended', () => {
  assert.equal(normalizeBaseUrl('http://localhost:11434'), 'http://localhost:11434/v1');
});

test('LM Studio bare host gets /v1 appended', () => {
  assert.equal(normalizeBaseUrl('http://localhost:1234'), 'http://localhost:1234/v1');
});

test('llama.cpp bare host gets /v1 appended', () => {
  assert.equal(normalizeBaseUrl('http://localhost:8080'), 'http://localhost:8080/v1');
});

test('URLs that already contain /v1 are left alone', () => {
  assert.equal(normalizeBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1');
  assert.equal(normalizeBaseUrl('http://localhost:1234/v1/'), 'http://localhost:1234/v1');
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1');
});

test('Native Ollama /api paths are NOT rewritten', () => {
  assert.equal(normalizeBaseUrl('http://localhost:11434/api'), 'http://localhost:11434/api');
  assert.equal(normalizeBaseUrl('http://localhost:11434/api/tags'), 'http://localhost:11434/api/tags');
});

test('Trailing slashes are stripped', () => {
  assert.equal(normalizeBaseUrl('http://localhost:11434/'), 'http://localhost:11434/v1');
  assert.equal(normalizeBaseUrl('http://localhost:11434//'), 'http://localhost:11434/v1');
});

test('Unknown ports without /v1 are left alone', () => {
  // We only auto-append /v1 for ports we know speak OpenAI-compat. A custom
  // proxy on port 9000 might be using a non-standard path.
  assert.equal(normalizeBaseUrl('http://localhost:9000'), 'http://localhost:9000');
  assert.equal(normalizeBaseUrl('https://my-proxy.example.com'), 'https://my-proxy.example.com');
});

test('URL with custom path is left alone', () => {
  // User intentionally pointed at a non-/v1 path — respect it.
  assert.equal(normalizeBaseUrl('http://localhost:11434/openai'), 'http://localhost:11434/openai');
  assert.equal(normalizeBaseUrl('http://localhost:1234/custom'), 'http://localhost:1234/custom');
});

test('Empty / falsy input is returned unchanged', () => {
  assert.equal(normalizeBaseUrl(''), '');
  assert.equal(normalizeBaseUrl(null), null);
  assert.equal(normalizeBaseUrl(undefined), undefined);
});

test('Malformed URL is returned unchanged (no throw)', () => {
  assert.equal(normalizeBaseUrl('not-a-url'), 'not-a-url');
});

function withTempConfig(toml, fn) {
  const prevCwd = process.cwd();
  const prevEnv = { ...process.env };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smallcode-config-'));
  fs.writeFileSync(path.join(dir, 'smallcode.toml'), toml);
  process.chdir(dir);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('SMALLCODE_') || key === 'OLLAMA_HOST') delete process.env[key];
  }
  try {
    return fn();
  } finally {
    process.chdir(prevCwd);
    process.env = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('smallcode.toml loads per-tier model targets', () => {
  withTempConfig(`
[model]
name = "local-default"
baseUrl = "http://localhost:11434"

[models.strong]
name = "openrouter/large"
baseUrl = "https://openrouter.ai/api/v1"
`, () => {
    const config = loadConfig();
    assert.equal(config.model.name, 'local-default');
    assert.equal(config.model.baseUrl, 'http://localhost:11434/v1');
    assert.equal(config.models.strong.name, 'openrouter/large');
    assert.equal(config.models.strong.baseUrl, 'https://openrouter.ai/api/v1');
  });
});

test('environment tier vars override smallcode.toml tier values', () => {
  withTempConfig(`
[model]
name = "local-default"
baseUrl = "http://localhost:11434/v1"

[models.strong]
name = "toml-strong"
baseUrl = "http://localhost:1234/v1"
`, () => {
    process.env.SMALLCODE_MODEL_STRONG = 'env-strong';
    process.env.SMALLCODE_BASE_URL_STRONG = 'https://openrouter.ai/api/v1';
    const config = loadConfig();
    assert.equal(config.models.strong.name, 'env-strong');
    assert.equal(config.models.strong.baseUrl, 'https://openrouter.ai/api/v1');
  });
});

test('missing tier URL falls back to primary base URL', () => {
  withTempConfig(`
[model]
name = "local-default"
baseUrl = "http://localhost:1234"

[models.fast]
name = "local-fast"
`, () => {
    const config = loadConfig();
    assert.equal(config.models.fast.name, 'local-fast');
    assert.equal(config.models.fast.baseUrl, 'http://localhost:1234/v1');
  });
});

test('env primary model skips TOML [model] but still loads tier sections', () => {
  withTempConfig(`
[model]
name = "toml-default"
baseUrl = "http://localhost:11434/v1"

[models.strong]
name = "openrouter/large"
baseUrl = "https://openrouter.ai/api/v1"
`, () => {
    process.env.SMALLCODE_MODEL = 'env-default';
    const config = loadConfig();
    assert.equal(config.model.name, 'env-default');
    assert.equal(config.model.baseUrl, 'http://localhost:1234/v1');
    assert.equal(config.models.strong.name, 'openrouter/large');
    assert.equal(config.models.strong.baseUrl, 'https://openrouter.ai/api/v1');
  });
});
