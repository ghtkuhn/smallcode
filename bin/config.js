// SmallCode — Configuration
// Loads config from .env, smallcode.toml, and CLI flags

const path = require('path');
const fs = require('fs');
const os = require('os');

function loadConfig(flags = {}) {
  const env = process.env;

  const config = {
    model: {
      provider: env.SMALLCODE_PROVIDER || 'openai',
      name: env.SMALLCODE_MODEL || '',
      baseUrl: env.SMALLCODE_BASE_URL || (env.OLLAMA_HOST ? (env.OLLAMA_HOST + '/v1') : 'http://localhost:1234/v1'),
      timeout: parseInt(env.SMALLCODE_MODEL_TIMEOUT) || 300, // seconds; 5 min default for slow hardware
    },
    context: {
      max_budget_pct: parseInt(env.SMALLCODE_CONTEXT_BUDGET) || 70,
      detected_window: parseInt(env.SMALLCODE_CONTEXT_WINDOW) || 128000,
      working_memory_tokens: 500,
      summary_threshold: 200,
    },
    tools: {
      bash_timeout: parseInt(env.SMALLCODE_BASH_TIMEOUT) || 30,
    },
    tui: {
      show_token_usage: true,
      auto_approve: env.SMALLCODE_AUTO_APPROVE === 'true',
      theme: env.SMALLCODE_THEME || 'dark',
    },
    escalation: {
      enabled: true,
      max_per_session: parseInt(env.SMALLCODE_ESCALATION_MAX) || 5,
      confirm: env.SMALLCODE_ESCALATION_CONFIRM !== 'false',
      provider: null,
      api_key: null,
      model: env.SMALLCODE_ESCALATION_MODEL || null,
    },
    git: {
      auto_commit: env.SMALLCODE_AUTO_COMMIT === 'true',
    },
  };

  // smallcode.toml / config.toml for backwards compatibility and tier routing.
  const tomlPaths = [
    path.join(process.cwd(), 'smallcode.toml'),
    path.join(process.cwd(), '.smallcode', 'config.toml'),
    path.join(os.homedir(), '.config', 'smallcode', 'config.toml'),
  ];
  for (const tomlPath of tomlPaths) {
    if (fs.existsSync(tomlPath)) {
      try {
        const toml = parseTomlConfig(fs.readFileSync(tomlPath, 'utf-8'));
        // Primary [model] from TOML only when env did not set SMALLCODE_MODEL.
        if (!config.model.name) applyTomlPrimaryConfig(config, toml);
        // Tier sections are always merged — env tier vars override below.
        applyTomlModelTiers(config, toml);
        break;
      } catch {}
    }
  }

  applyEnvModelTier(config, 'fast', 'SMALLCODE_MODEL_FAST', 'SMALLCODE_BASE_URL_FAST');
  applyEnvModelTier(config, 'default', 'SMALLCODE_MODEL_DEFAULT', 'SMALLCODE_BASE_URL_DEFAULT');
  applyEnvModelTier(config, 'medium', 'SMALLCODE_MODEL_MEDIUM', 'SMALLCODE_BASE_URL_MEDIUM');
  applyEnvModelTier(config, 'strong', 'SMALLCODE_MODEL_STRONG', 'SMALLCODE_BASE_URL_STRONG');

  // CLI flags override everything
  if (flags.model) config.model.name = flags.model;
  if (flags.provider) config.model.provider = flags.provider;
  if (flags.endpoint || flags.baseUrl) config.model.baseUrl = flags.endpoint || flags.baseUrl;
  if (flags.classic) config.tui.classic = true;

  // Normalize the base URL so common Ollama / LM Studio mistakes resolve
  // automatically. Closes #44 — "ollama Cannot reach endpoint at
  // http://localhost:11434" — Ollama's OpenAI-compatible endpoint lives at
  // /v1; the /api/* paths are the legacy Ollama-native API. Setting
  // SMALLCODE_BASE_URL=http://localhost:11434 used to fail because the
  // OpenAI-compat path tried .../models instead of .../v1/models.
  config.model.baseUrl = normalizeBaseUrl(config.model.baseUrl);
  normalizeModelTiers(config);

  return config;
}

function stripInlineComment(value) {
  let quote = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if ((ch === '"' || ch === "'") && value[i - 1] !== '\\') {
      quote = quote === ch ? null : (quote || ch);
    }
    if (ch === '#' && !quote) return value.slice(0, i).trim();
  }
  return value.trim();
}

function parseTomlValue(raw) {
  const value = stripInlineComment(raw);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  return value;
}

function parseTomlConfig(content) {
  const out = {};
  let section = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].split('.').map(s => s.trim()).filter(Boolean);
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    let cursor = out;
    for (const part of section) {
      if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {};
      cursor = cursor[part];
    }
    cursor[kv[1]] = parseTomlValue(kv[2]);
  }
  return out;
}

function coerceModelEntry(value) {
  if (!value) return {};
  if (typeof value === 'string') return { name: value };
  return {
    name: value.name || value.model || '',
    baseUrl: value.baseUrl || value.base_url || '',
    provider: value.provider || '',
    numPredict: parseInt(value.numPredict || value.num_predict, 10) || 0,
  };
}

function ensureModels(config) {
  if (!config.models) config.models = {};
  return config.models;
}

function mergeModelTier(config, tier, value) {
  const entry = coerceModelEntry(value);
  if (!entry.name && !entry.baseUrl && !entry.provider && !entry.numPredict) return;
  const models = ensureModels(config);
  const prev = coerceModelEntry(models[tier]);
  models[tier] = {
    ...prev,
    ...(entry.name ? { name: entry.name } : {}),
    ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
    ...(entry.provider ? { provider: entry.provider } : {}),
    ...(entry.numPredict ? { numPredict: entry.numPredict } : {}),
  };
}

function applyTomlPrimaryConfig(config, toml) {
  if (toml.provider) config.model.provider = toml.provider;
  if (toml.name) config.model.name = toml.name;
  if (toml.baseUrl || toml.base_url) config.model.baseUrl = toml.baseUrl || toml.base_url;
  if (toml.timeout) config.model.timeout = parseInt(toml.timeout, 10) || config.model.timeout;
  if (toml.model) {
    if (toml.model.provider) config.model.provider = toml.model.provider;
    if (toml.model.name) config.model.name = toml.model.name;
    if (toml.model.baseUrl || toml.model.base_url) config.model.baseUrl = toml.model.baseUrl || toml.model.base_url;
    if (toml.model.timeout) config.model.timeout = parseInt(toml.model.timeout, 10) || config.model.timeout;
    if (toml.model.num_predict || toml.model.numPredict) config.model.numPredict = parseInt(toml.model.num_predict || toml.model.numPredict, 10) || 0;
  }
}

function applyTomlModelTiers(config, toml) {
  if (!toml.models) return;
  for (const tier of ['fast', 'default', 'medium', 'strong']) {
    if (toml.models[tier]) mergeModelTier(config, tier, toml.models[tier]);
  }
}

function applyEnvModelTier(config, tier, modelEnv, urlEnv) {
  const entry = {};
  if (process.env[modelEnv]) entry.name = process.env[modelEnv];
  if (process.env[urlEnv]) entry.baseUrl = process.env[urlEnv];
  mergeModelTier(config, tier, entry);
}

function normalizeModelTiers(config) {
  if (!config.models) return;
  for (const tier of Object.keys(config.models)) {
    const entry = coerceModelEntry(config.models[tier]);
    config.models[tier] = {
      name: entry.name || config.model.name,
      baseUrl: normalizeBaseUrl(entry.baseUrl || config.model.baseUrl),
      provider: entry.provider || config.model.provider,
      numPredict: entry.numPredict || 0,
    };
  }
}

function getModelTarget(config, tier = 'default') {
  const entry = config?.models?.[tier] ? coerceModelEntry(config.models[tier]) : {};
  return {
    tier,
    model: entry.name || config?.model?.name || '',
    name: entry.name || config?.model?.name || '',
    baseUrl: normalizeBaseUrl(entry.baseUrl || config?.model?.baseUrl || ''),
    provider: entry.provider || config?.model?.provider || 'openai',
    numPredict: entry.numPredict || (
      (entry.name || config?.model?.name) === config?.model?.name
        ? parseInt(config?.model?.numPredict || config?.model?.num_predict, 10) || 0
        : 0
    ),
  };
}

function getModelTargetForModel(config, modelName, preferredTier = 'default') {
  if (config?.models) {
    for (const tier of ['fast', 'default', 'medium', 'strong']) {
      const entry = coerceModelEntry(config.models[tier]);
      if (entry.name && entry.name === modelName) return getModelTarget(config, tier);
    }
  }
  const fallback = getModelTarget(config, preferredTier);
  return { ...fallback, model: modelName || fallback.model, name: modelName || fallback.name };
}

function withModelTarget(config, target) {
  return {
    ...config,
    model: {
      ...config.model,
      name: target.model || target.name || config.model.name,
      baseUrl: target.baseUrl || config.model.baseUrl,
      provider: target.provider || config.model.provider,
    },
    activeModelTarget: target,
  };
}

/**
 * Auto-append `/v1` to known OpenAI-compatible endpoints when the user
 * didn't include it. Strips trailing slashes. No-op for URLs that already
 * end in `/v1`, contain `/v1/`, or aren't on a recognised port.
 *
 * Examples:
 *   http://localhost:11434           → http://localhost:11434/v1   (Ollama)
 *   http://localhost:1234            → http://localhost:1234/v1    (LM Studio)
 *   http://localhost:8080            → http://localhost:8080       (llama.cpp — left alone)
 *   http://localhost:11434/v1        → http://localhost:11434/v1   (no-op)
 *   http://localhost:11434/api/      → http://localhost:11434/api  (trailing slash stripped)
 */
function normalizeBaseUrl(url) {
  if (!url || typeof url !== 'string') return url;
  let out = url.trim().replace(/\/+$/, '');
  if (!out) return url;
  // If it already routes through /v1, leave it alone.
  if (/\/v1(\/|$)/.test(out)) return out;
  // Don't touch native-Ollama paths (/api/...) — the caller is intentionally
  // hitting the legacy API.
  if (/\/api(\/|$)/.test(out)) return out;
  // Recognised OpenAI-compatible local server ports that REQUIRE /v1.
  // (llama.cpp's server defaults to 8080 but its /v1 route is also OpenAI-
  // compatible, so we append there too — but only when the path is empty.)
  const known = /:(11434|1234|8080|11435)(\/|$)/;
  let hasPath = false;
  try {
    const u = new URL(out);
    hasPath = u.pathname && u.pathname !== '/' && u.pathname !== '';
  } catch {
    return out;
  }
  if (hasPath) return out;
  if (known.test(out)) return out + '/v1';
  return out;
}

/**
 * Check if the model endpoint is reachable.
 * Returns true if connected, false otherwise.
 */
async function checkEndpoint(config) {
  const baseUrl = config.model.baseUrl || process.env.OLLAMA_HOST || 'http://localhost:11434';

  // Plugin-registered providers handle their own connectivity
  const { providerRegistry } = require('../src/compiled/providers/registry');
  if (providerRegistry.has(config.model.provider)) {
    console.log(`  Using plugin provider: ${config.model.provider}`);
    return true;
  }

  // OpenAI-compatible endpoint (LM Studio, vLLM, OpenRouter, etc.)
  if (config.model.provider === 'openai' || baseUrl.includes('/v1')) {
    try {
      const headers = buildAuthHeaders(config);
      const response = await fetch(`${baseUrl}/models`, { headers });
      if (!response.ok) {
        console.log(`  ⚠ Cannot reach endpoint at ${baseUrl}`);
        console.log(`  Got HTTP ${response.status} from ${baseUrl}/models`);
        if (response.status === 404 && !/\/v1(\/|$)/.test(baseUrl)) {
          // The most common cause: user gave a base URL without /v1.
          console.log(`  Tip: this URL has no /v1 path. Try SMALLCODE_BASE_URL=${baseUrl}/v1 in your .env.`);
        } else {
          console.log(`  Check that your model server is running and accessible.`);
        }
        if (response.status === 401 || response.status === 403) {
          console.log(`  Got ${response.status} — set OPENAI_API_KEY in .env if your server requires auth.`);
        }
        return false;
      }
      const data = await response.json();
      const models = data.data || [];
      if (models.length > 0) {
        console.log(`  Connected: ${baseUrl}`);
        console.log(`  Model: ${config.model.name}`);
        const activeModel = models.find(m => (m.id || m.name || '').includes(config.model.name)) || models[0];
        if (activeModel && activeModel.context_length) {
          config.context.detected_window = activeModel.context_length;
          console.log(`  Context: ${activeModel.context_length} tokens`);
        }
      }
      return true;
    } catch (e) {
      console.log(`  ⚠ Cannot reach endpoint at ${baseUrl}`);
      console.log(`  Check that your model server is running and the URL is correct.`);
      return false;
    }
  }

  // Ollama endpoint.
  // Prefer the user-supplied base URL (SMALLCODE_BASE_URL) over OLLAMA_HOST /
  // localhost so a remote Ollama server is actually probed. Previously this
  // branch always hit localhost and reported "Ollama not running" even when
  // the user pointed SMALLCODE_BASE_URL at a remote host (issue #59).
  // Ollama's native API lives at the host root (/api/tags), so strip any
  // trailing OpenAI-style /v1 and normalise the trailing slash.
  let host = config.model.baseUrl || process.env.OLLAMA_HOST || 'http://localhost:11434';
  host = host.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  const tagsUrl = `${host}/api/tags`;
  try {
    // Carry auth (e.g. credentials embedded in the URL, or a bearer token /
    // basic-auth header from buildAuthHeaders) so reverse-proxied Ollama
    // servers behind auth are reachable.
    const headers = buildAuthHeaders(config);
    const response = await fetch(tagsUrl, { headers });
    if (!response.ok) {
      console.log(`  ⚠ Ollama returned HTTP ${response.status} from ${tagsUrl}`);
      if (response.status === 401 || response.status === 403) {
        console.log(`  Auth required — include credentials in SMALLCODE_BASE_URL or set OPENAI_API_KEY.`);
      } else if (response.status === 404) {
        console.log(`  Tip: ${host} has no /api/tags route. Is this actually an Ollama server? For OpenAI-compatible servers set SMALLCODE_PROVIDER=openai.`);
      } else {
        console.log(`  Check that Ollama is running and reachable at ${host}.`);
      }
      return false;
    }
    const data = await response.json();
    const models = data.models || [];
    const hasModel = models.some(m => m.name.includes(config.model.name.split(':')[0]));
    if (!hasModel) {
      console.log(`  ⚠ Model "${config.model.name}" not found on the Ollama server at ${host}.`);
      console.log(`  Run: ollama pull ${config.model.name}`);
      return false;
    }
    return true;
  } catch (e) {
    // Surface the underlying error instead of assuming Ollama is simply not
    // started — the user may have a wrong URL, DNS failure, or TLS issue.
    const msg = e && e.message ? e.message : String(e);
    console.log(`  ⚠ Cannot reach Ollama at ${tagsUrl}: ${msg}`);
    const hint = /ECONNREFUSED/.test(msg) ? '  If this is a local server, start it with: ollama serve' :
                 /ENOTFOUND|EAI_AGAIN/.test(msg) ? '  Check the hostname in SMALLCODE_BASE_URL.' :
                 /certificate|TLS|SSL/i.test(msg) ? '  TLS error — check the https certificate or use http.' :
                 '  Check that SMALLCODE_BASE_URL points at a running Ollama server.';
    console.log(hint);
    return false;
  }
}

/**
 * Build auth headers for API requests.
 *
 * Provider-aware: picks the right API key based on the target URL, so users
 * with multiple keys configured (common when escalation is enabled) don't
 * accidentally send an OpenAI key to DeepSeek or vice versa.
 */
function buildAuthHeaders(config) {
  const headers = { 'Content-Type': 'application/json' };
  const modelConfig = config.model || config;
  const baseUrl = (modelConfig.baseUrl || '').toLowerCase();

  // Route key selection based on the target endpoint URL.
  let apiKey = null;
  if (baseUrl.includes('api.deepseek.com')) {
    apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || modelConfig.apiKey;
  } else if (baseUrl.includes('api.openai.com')) {
    apiKey = process.env.OPENAI_API_KEY || modelConfig.apiKey;
  } else if (baseUrl.includes('openrouter.ai')) {
    apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || modelConfig.apiKey;
  } else if (baseUrl.includes('anthropic.com')) {
    // Anthropic uses x-api-key, not Bearer — but if someone routes through
    // an OpenAI-compat proxy, Bearer still works. We use ANTHROPIC_API_KEY
    // first, then fall back to the generic key.
    apiKey = process.env.ANTHROPIC_API_KEY || modelConfig.apiKey;
  } else {
    // Local server or unknown cloud — fall back to any available key.
    // SMALLCODE_API_KEY is the explicit "my endpoint needs this key" option.
    apiKey = process.env.SMALLCODE_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY || modelConfig.apiKey;
  }

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  // Basic auth embedded in the URL (https://user:pass@host). The fetch() API
  // does NOT apply URL userinfo automatically, so a reverse-proxied server
  // behind basic auth would 401. Convert it to an explicit header. An
  // explicit API key (Bearer, above) takes precedence if both are present.
  if (!apiKey && modelConfig.baseUrl) {
    try {
      const u = new URL(modelConfig.baseUrl);
      if (u.username) {
        const creds = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
        headers['Authorization'] = `Basic ${creds}`;
      }
    } catch { /* not a parseable URL — ignore */ }
  }
  if (baseUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://github.com/Doorman11991/smallcode';
    headers['X-Title'] = 'SmallCode';
  }
  return headers;
}

module.exports = {
  loadConfig,
  checkEndpoint,
  buildAuthHeaders,
  normalizeBaseUrl,
  parseTomlConfig,
  getModelTarget,
  getModelTargetForModel,
  withModelTarget,
};
