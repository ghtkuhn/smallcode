// SmallCode — Thinking Budget Control
//
// Modern reasoning models (Qwen3, DeepSeek R1, GPT-5 reasoning, Claude with
// thinking) emit "thinking" tokens before their final answer. These tokens
// are wrapped in `<think>...</think>`, `<reasoning>...</reasoning>`, or
// embedded in a separate field depending on the provider.
//
// Without a budget, a small reasoning model can spend 8000 tokens "thinking"
// about a trivial rename, blowing through context and adding minutes of
// latency. This module provides:
//
//   - `applyThinkingBudget(body, budget)` — mutates the request body to
//     advise the provider on a thinking-token cap. Different providers use
//     different field names; we set them all defensively.
//
//   - `extractThinking(content)` — splits a response into { thinking, answer }
//     so we can show the answer to the model's next turn while logging the
//     thinking separately.
//
//   - `truncateThinking(content, maxThinkingChars)` — emergency cap: if the
//     model emitted way more thinking than budgeted, replace the middle of
//     the thinking block with [...truncated...] before adding to history.
//
// Configuration:
//   SMALLCODE_THINKING_BUDGET=2000    Soft cap (tokens) advised to the model
//   SMALLCODE_THINKING_DISABLE=true   Disable thinking entirely (for repair)
//   SMALLCODE_THINKING_HARD_CAP=8000  Hard cap (chars) — emergency truncation

'use strict';

const DEFAULT_BUDGET_TOKENS = parseInt(process.env.SMALLCODE_THINKING_BUDGET) || 2000;
const HARD_CAP_CHARS = parseInt(process.env.SMALLCODE_THINKING_HARD_CAP) || 32000;

// Patterns for detecting and stripping thinking blocks from model output.
// Models use various conventions — we handle the common ones.
const THINK_PATTERNS = [
  /<think>([\s\S]*?)<\/think>/g,
  /<thinking>([\s\S]*?)<\/thinking>/g,
  /<reasoning>([\s\S]*?)<\/reasoning>/g,
  /<reflection>([\s\S]*?)<\/reflection>/g,
];

/**
 * Apply thinking budget to a chat completion request body.
 * Only injects fields that are appropriate for the target provider.
 * OpenAI's API rejects unknown top-level fields with 400 errors.
 *
 * @param {object} body    - The request body about to be sent
 * @param {object} options
 * @param {number}  options.tokens  - Token budget for thinking (0 = disabled)
 * @param {boolean} options.disable - Disable thinking entirely
 * @param {string}  options.baseUrl - Endpoint URL (used to detect provider)
 */
function applyThinkingBudget(body, options = {}) {
  const opts = { ...options };
  const requestedLevel = typeof opts.level === 'string' ? opts.level.toLowerCase() : null;
  const tokens = opts.disable || requestedLevel === 'off'
    ? 0
    : (typeof opts.tokens === 'number' ? opts.tokens : DEFAULT_BUDGET_TOKENS);

  if (process.env.SMALLCODE_THINKING_DISABLE === 'true') {
    opts.disable = true;
  }
  if (requestedLevel === 'off') opts.disable = true;

  // A retry body may inherit fields from an earlier request. Runtime level
  // changes must replace, rather than accumulate, provider-specific controls.
  if (requestedLevel) {
    delete body.reasoning_effort;
    delete body.reasoning;
    delete body.thinking;
    delete body.enable_thinking;
    if (body.chat_template_kwargs) {
      delete body.chat_template_kwargs.enable_thinking;
      delete body.chat_template_kwargs.thinking_budget;
      if (Object.keys(body.chat_template_kwargs).length === 0) delete body.chat_template_kwargs;
    }
  }

  const baseUrl = String(opts.baseUrl || '').toLowerCase();

  // Detect provider from URL so we only send fields that provider accepts.
  // OpenAI's production API rejects unknown top-level parameters with HTTP 400.
  // Ollama's /v1 shim also rejects unknown fields like `thinking`, `chat_template_kwargs`.
  // LM Studio accepts unknown fields silently but logs warnings.
  const isOpenAICloud = baseUrl.includes('api.openai.com') || baseUrl.includes('openrouter.ai');
  const isAnthropic = baseUrl.includes('anthropic.com') || baseUrl.includes('claude');
  const isDeepSeek = baseUrl.includes('api.deepseek.com');
  // Ollama runs on port 11434 by default. Its /v1 endpoint is an OpenAI shim
  // that rejects unknown top-level fields (thinking, chat_template_kwargs, etc).
  const isOllama = baseUrl.includes(':11434') || baseUrl.includes('ollama');
  // llama.cpp / LM Studio — only these accept chat_template_kwargs and
  // enable_thinking. We detect them by exclusion: not a cloud provider,
  // not Ollama, not DeepSeek.
  const isLocalLlamaCpp = !isOpenAICloud && !isAnthropic && !isDeepSeek && !isOllama;
  const maxOutputTokens = Number(body.max_tokens || body.max_completion_tokens || 8192);

  // Anthropic-style: { thinking: { type: "enabled", budget_tokens: N } }
  // ONLY send to actual Anthropic API. Local servers and Ollama reject this.
  // LM Studio technically ignores it silently, but there's no benefit in
  // sending it to anything other than Anthropic.
  if (isAnthropic) {
    const safeBudget = Math.max(0, Math.min(tokens, Math.max(0, maxOutputTokens - 1024)));
    body.thinking = opts.disable
      ? { type: 'disabled' }
      : { type: 'enabled', budget_tokens: safeBudget };
  }

  // OpenAI o1/o3/o4-style reasoning_effort — only send to OpenAI cloud or
  // OpenRouter (which proxies to OpenAI). Other providers reject it with 400.
  // GPT-5.5, gpt-4o, and most local models do NOT support it.
  const modelName = String(body.model || '').toLowerCase();
  // lfm2 (Liquid AI) emits a `reasoning_content` field, but injecting
  // `chat_template_kwargs.enable_thinking` into the request *suppresses*
  // its tool-call output entirely on LM Studio (observed on
  // lfm2.5-8b-a1b-apex). Treat it as a non-budget-controllable reasoning
  // model: the reasoning fallback in tool_call_extractor handles its
  // empty-content edge case, no need to override the template.
  const isReasoningModel = /(^|[\/\-_])(o1|o3|o4|gpt-?5|gpt-?oss|gemma-?4|qwen3|qwq|deepseek-r|deepseek-v3-reason|claude-3-7|claude-4)/.test(modelName);
  const effortForLevel = (() => {
    if (opts.disable) return 'none';
    if (requestedLevel === 'minimal') return 'minimal';
    if (requestedLevel === 'low') return 'low';
    if (requestedLevel === 'medium') return 'medium';
    if (requestedLevel === 'high' || requestedLevel === 'xhigh' || requestedLevel === 'max') return 'high';
    if (tokens <= maxOutputTokens * 0.2) return 'low';
    if (tokens <= maxOutputTokens * 0.5) return 'medium';
    return 'high';
  })();

  // Ollama's OpenAI-compatible endpoint supports reasoning_effort. GPT-OSS
  // cannot turn reasoning fully off, so clamp that one model family to low.
  if (isOllama && (requestedLevel || opts.disable) && isReasoningModel) {
    const isGptOss = /gpt[-_.]?oss/.test(modelName);
    const ollamaEffort = effortForLevel === 'minimal' ? 'low' : effortForLevel;
    body.reasoning_effort = isGptOss && ollamaEffort === 'none' ? 'low' : ollamaEffort;
  }

  if (isReasoningModel && isOpenAICloud) {
    const supportsNoneAndMinimal = /gpt-?5/.test(modelName);
    if (opts.disable) {
      body.reasoning_effort = supportsNoneAndMinimal ? 'none' : 'low';
    } else if (requestedLevel) {
      body.reasoning_effort = effortForLevel === 'minimal' && !supportsNoneAndMinimal ? 'low' : effortForLevel;
    } else {
      if (tokens <= 500) body.reasoning_effort = 'low';
      else if (tokens <= 3000) body.reasoning_effort = 'medium';
      else body.reasoning_effort = 'high';
    }
  }

  // Qwen/llama.cpp-style fields — ONLY for llama.cpp and LM Studio.
  // Never send to OpenAI, Anthropic, DeepSeek cloud, or Ollama.
  // Ollama has its own /api/chat params; its /v1 shim rejects these.
  if (isLocalLlamaCpp && isReasoningModel) {
    body.chat_template_kwargs = body.chat_template_kwargs || {};
    body.chat_template_kwargs.enable_thinking = !opts.disable;
    if (!opts.disable) {
      body.chat_template_kwargs.thinking_budget = tokens;
    }
    body.enable_thinking = !opts.disable;
  }

  return body;
}

/**
 * Extract thinking from a model response. Returns { thinking, answer }.
 * If no thinking tags found, returns { thinking: '', answer: content }.
 */
function extractThinking(content) {
  if (typeof content !== 'string') return { thinking: '', answer: content };
  let thinking = '';
  let answer = content;
  for (const pattern of THINK_PATTERNS) {
    answer = answer.replace(pattern, (_match, inner) => {
      thinking += inner + '\n';
      return ''; // strip the thinking block from the answer
    });
  }
  return { thinking: thinking.trim(), answer: answer.trim() };
}

/**
 * Hard-cap thinking content — if the model ignored the soft budget and emitted
 * way too many thinking tokens, replace the middle of the thinking block with
 * an ellipsis marker. Keeps the start and end so we can debug what it was
 * trying to do without storing 50KB of "let me reconsider" loops.
 *
 * Returns the modified content (with thinking blocks truncated in place).
 */
function truncateThinking(content, maxChars = HARD_CAP_CHARS) {
  if (typeof content !== 'string' || content.length === 0) return content;
  let out = content;
  for (const pattern of THINK_PATTERNS) {
    out = out.replace(pattern, (match, inner) => {
      if (inner.length <= maxChars) return match;
      // Keep first 40% + last 20% of the thinking, ellipsize the middle
      const headLen = Math.floor(maxChars * 0.6);
      const tailLen = Math.floor(maxChars * 0.3);
      const head = inner.slice(0, headLen);
      const tail = inner.slice(inner.length - tailLen);
      const truncatedBytes = inner.length - headLen - tailLen;
      // Re-wrap with the same outer tags as the matched block
      const tagMatch = match.match(/^<(\w+)>/);
      const tag = tagMatch ? tagMatch[1] : 'think';
      return `<${tag}>${head}\n\n[...thinking truncated: ${truncatedBytes} chars omitted...]\n\n${tail}</${tag}>`;
    });
  }
  return out;
}

/**
 * Decide whether thinking should be disabled for a particular call.
 * Used by the improvement loop: after a failed attempt, the repair call
 * benefits from disabling thinking entirely — the model already overthought
 * the first time, we want a fast, deterministic fix.
 *
 * @param {object} ctx - { isRepair: bool, attempt: number, budget: number }
 */
function shouldDisableThinking(ctx = {}) {
  if (process.env.SMALLCODE_THINKING_DISABLE === 'true') return true;
  // On repair attempts (attempt > 1), disable thinking — the model already
  // overthought the original solution. A fast, low-creativity retry is better.
  if (ctx.isRepair && ctx.attempt > 1) return true;
  // Budget of 0 = explicit disable
  if (typeof ctx.budget === 'number' && ctx.budget === 0) return true;
  return false;
}

/**
 * Estimate how many tokens were spent on thinking in a response.
 * Useful for logging and budget tracking. Returns 0 if no thinking found.
 */
function estimateThinkingTokens(content) {
  if (typeof content !== 'string') return 0;
  let totalChars = 0;
  for (const pattern of THINK_PATTERNS) {
    const matches = content.match(pattern);
    if (matches) {
      for (const m of matches) totalChars += m.length;
    }
  }
  // Rough: 4 chars per token
  return Math.ceil(totalChars / 4);
}

module.exports = {
  applyThinkingBudget,
  extractThinking,
  truncateThinking,
  shouldDisableThinking,
  estimateThinkingTokens,
  DEFAULT_BUDGET_TOKENS,
  HARD_CAP_CHARS,
};
