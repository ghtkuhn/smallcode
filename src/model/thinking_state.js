// Session-scoped thinking preset state.

'use strict';

const DEFAULT_BUDGET_TOKENS = 2000;
const { DEFAULT_MAX_OUTPUT_TOKENS } = require('./output_limit');

const THINKING_PRESETS = Object.freeze({
  off: Object.freeze({ percent: 0, description: 'No reasoning' }),
  minimal: Object.freeze({ percent: 10, description: 'Very brief reasoning' }),
  low: Object.freeze({ percent: 20, description: 'Light reasoning' }),
  medium: Object.freeze({ percent: 40, description: 'Moderate reasoning' }),
  high: Object.freeze({ percent: 60, description: 'Deep reasoning' }),
  xhigh: Object.freeze({ percent: 80, description: 'Extra-high reasoning' }),
  max: Object.freeze({ percent: 100, description: 'Maximum reasoning' }),
});

const THINKING_LEVELS = Object.freeze(Object.keys(THINKING_PRESETS));
const THINKING_ALIASES = Object.freeze({ unlimited: 'max' });

function normalizeThinkingLevel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return THINKING_ALIASES[normalized] || (THINKING_PRESETS[normalized] ? normalized : null);
}

function budgetForLevel(level, maxOutputTokens) {
  const normalized = normalizeThinkingLevel(level);
  if (!normalized) return null;
  const maxTokens = Number.isFinite(Number(maxOutputTokens)) && Number(maxOutputTokens) > 0
    ? Math.floor(Number(maxOutputTokens))
    : DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.round(maxTokens * THINKING_PRESETS[normalized].percent / 100);
}

class ThinkingState {
  constructor(env = process.env) {
    const disabled = env.SMALLCODE_THINKING_DISABLE === 'true';
    const explicitBudget = Object.prototype.hasOwnProperty.call(env, 'SMALLCODE_THINKING_BUDGET')
      ? Number.parseInt(env.SMALLCODE_THINKING_BUDGET, 10)
      : null;

    this.level = disabled ? 'off' : 'custom';
    this.customTokens = disabled
      ? 0
      : (Number.isFinite(explicitBudget) && explicitBudget >= 0 ? explicitBudget : DEFAULT_BUDGET_TOKENS);
    this.startup = { level: this.level, customTokens: this.customTokens };
  }

  setLevel(value) {
    const level = normalizeThinkingLevel(value);
    if (!level) return { ok: false, error: `Invalid thinking preset: ${value}` };
    this.level = level;
    this.customTokens = null;
    return { ok: true, ...this.snapshot() };
  }

  resolve(maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS) {
    const maxTokens = Number.isFinite(Number(maxOutputTokens)) && Number(maxOutputTokens) > 0
      ? Math.floor(Number(maxOutputTokens))
      : DEFAULT_MAX_OUTPUT_TOKENS;
    const tokens = this.level === 'custom'
      ? Math.max(0, Math.min(maxTokens, this.customTokens))
      : budgetForLevel(this.level, maxTokens);
    return { level: this.level, tokens, maxOutputTokens: maxTokens };
  }

  snapshot(maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS) {
    const resolved = this.resolve(maxOutputTokens);
    return {
      ...resolved,
      percent: this.level === 'custom'
        ? Math.round((resolved.tokens / resolved.maxOutputTokens) * 100)
        : THINKING_PRESETS[this.level].percent,
      label: this.level === 'custom' ? `custom (${resolved.tokens} tokens)` : this.level,
    };
  }
}

function getThinkingCapabilityNotice({ level, model = '', baseUrl = '' } = {}) {
  const normalized = normalizeThinkingLevel(level) || level;
  const modelName = String(model).toLowerCase();
  const url = String(baseUrl).toLowerCase();
  if (normalized === 'off' && /gpt[-_.]?oss/.test(modelName) && (url.includes('ollama') || url.includes(':11434'))) {
    return 'GPT-OSS cannot fully disable thinking in Ollama; requests use the lowest supported level (low).';
  }
  return '';
}

module.exports = {
  ThinkingState,
  THINKING_PRESETS,
  THINKING_LEVELS,
  THINKING_ALIASES,
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  normalizeThinkingLevel,
  budgetForLevel,
  getThinkingCapabilityNotice,
};
