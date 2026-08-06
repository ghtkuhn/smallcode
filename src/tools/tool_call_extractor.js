// SmallCode — Tool Call Extractor
//
// Some local models (notably qwen2.5-coder, hermes, llama3-instruct via Ollama,
// and various GGUFs through llama.cpp) do not always emit structured
// `tool_calls` over the OpenAI-compatible endpoint. Instead, they paste the
// tool invocation as JSON text inside `message.content`.
//
// Symptoms reported in the wild (e.g. issue #36 — qwen2.5-coder:14b on Ollama):
//   • User asks "what files are in this directory?"
//   • Model returns a chat message whose content is literally a JSON blob:
//       <tool_call>{"name":"shell","arguments":{"cmd":"ls"}}</tool_call>
//     or sometimes a bare ```json fenced block, or even just `{ "name": ... }`.
//   • The agent loop sees no `tool_calls`, treats the JSON as chat output,
//     and the user sees the raw JSON instead of the tool running.
//
// This module is a defensive recovery layer. Given the model's `message`
// object and the list of available tool schemas, it tries to detect
// embedded tool invocations and rewrite the message in-place to use the
// proper `tool_calls` shape — so the rest of the agent loop can treat
// every model the same way.
//
// Recognised formats (in priority order):
//   1. <tool_call><function=name><parameter=x>...</...>       ← Qwen3 XML dialect
//   2. <tool_call>{...}</tool_call>                           ← Hermes / qwen2.5 native
//   3. <|tool_call_start|>[func(kw=val)]<|tool_call_end|>     ← Liquid AI lfm2.x
//   4. ```json ... ```  (fenced code block)                   ← qwen-coder / generic
//   5. ```tool_call ... ```                                   ← some llama3 fine-tunes
//   6. Bare JSON object at the start of content
//
// All formats expect the JSON to be of shape:
//   { "name": "<tool_name>", "arguments": <object> }
// or the OpenAI variant:
//   { "function": { "name": "<tool_name>", "arguments": "<json string>" } }
// or an array of either.
//
// A syntactically complete tool-call envelope is always lifted into the
// structured channel, even when its name is not in the advertised schemas.
// The executor will then return its normal, safe "Unknown tool" error and the
// model can repair the call. Leaving it in assistant text is worse: it looks
// like a response to the user and bypasses both quality monitoring and tool
// diagnostics.

'use strict';

// Match <tool_call>...</tool_call> (qwen / hermes). Multiline + non-greedy.
const TOOL_CALL_TAG_RE = /<tool[_\-]?call>\s*([\s\S]*?)\s*<\/tool[_\-]?call>/gi;

// Qwen3-family models can serialize the provider's native tool call as XML
// inside message.content instead of returning an OpenAI `tool_calls` array.
const XML_FUNCTION_RE = /^\s*<function\s*=\s*["']?([A-Za-z_][\w.-]*)["']?\s*>([\s\S]*?)<\/function>\s*$/i;
const XML_PARAMETER_RE = /<parameter\s*=\s*["']?([A-Za-z_][\w.-]*)["']?\s*>([\s\S]*?)<\/parameter>/gi;

// Match ```json ... ``` and ```tool_call ... ``` fences.
const FENCED_RE = /```(?:json|tool_?call)?\s*\n?([\s\S]*?)\n?```/gi;

// Match a bare JSON object/array at the very start of content (whitespace ok).
const LEADING_JSON_RE = /^\s*([{\[][\s\S]+[}\]])\s*$/;

/**
 * @param {object} message       OpenAI-style choice.message; has .content + maybe .tool_calls
 * @param {Array}  toolSchemas   Same shape passed to the model: [{ function: { name, ... } }, ...]
 * @returns {{ patched: boolean, addedCalls: number }}
 *
 * Mutates `message` in place when extraction succeeds.
 */
function extractFromMessage(message, toolSchemas) {
  if (!message) return { patched: false, addedCalls: 0 };
  // Already has structured tool_calls — leave it alone.
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return { patched: false, addedCalls: 0 };
  }
  // Some local providers (LM Studio with Liquid AI lfm2.x, llama.cpp with
  // Qwen3 reasoning) split the response: visible text goes into `content`
  // and chain-of-thought goes into `reasoning_content`. When the budget is
  // tight the model can emit its tool call in reasoning_content and leave
  // content empty. Fall back to scanning reasoning_content if content is empty.
  const primary = typeof message.content === 'string' ? message.content : '';
  const fallback = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
  const content = primary && primary.trim().length > 0 ? primary : fallback;
  if (!content) return { patched: false, addedCalls: 0 };
  const usingReasoningFallback = content === fallback && content !== primary;

  const known = new Set();
  if (Array.isArray(toolSchemas)) {
    for (const t of toolSchemas) {
      const n = t?.function?.name || t?.name;
      if (typeof n === 'string') known.add(n);
    }
  }

  const calls = [];
  const consumedRanges = []; // [start, end) of content we transferred into tool_calls

  // 0. Qwen XML tool calls. Parse the complete outer block; malformed blocks
  //    remain visible, while unknown names become regular (safe) tool errors.
  for (const m of content.matchAll(TOOL_CALL_TAG_RE)) {
    const xmlCall = _parseXmlToolCall(m[1]);
    if (!xmlCall) continue;
    calls.push(xmlCall);
    consumedRanges.push([m.index, m.index + m[0].length]);
  }

  // 1. Liquid AI tool_call markers — `<|tool_call_start|>[func(kw=val)]<|tool_call_end|>`.
  //    Strongest signal when present; processed first so the rest of the
  //    pipeline doesn't try to interpret the Python-syntax payload as JSON.
  try {
    const { parseLiquidToolCalls } = require('./liquid_tool_parser');
    const { calls: liquidCalls, ranges: liquidRanges } = parseLiquidToolCalls(content);
    for (const c of liquidCalls) {
      calls.push(c);
    }
    if (liquidCalls.length > 0) {
      for (const r of liquidRanges) consumedRanges.push(r);
    }
  } catch {}

  // 2. Tagged JSON tool calls.
  for (const m of content.matchAll(TOOL_CALL_TAG_RE)) {
    const parsed = _safeParseAny(m[1]);
    const normalized = _normalize(parsed, known, { allowUnknown: true });
    for (const tc of normalized) calls.push(tc);
    if (normalized.length > 0) consumedRanges.push([m.index, m.index + m[0].length]);
  }

  // 2. Fenced JSON blocks. Skipped if we already got tagged calls.
  if (calls.length === 0) {
    for (const m of content.matchAll(FENCED_RE)) {
      const parsed = _safeParseAny(m[1]);
      const normalized = _normalize(parsed, known);
      if (normalized.length > 0) {
        for (const tc of normalized) calls.push(tc);
        consumedRanges.push([m.index, m.index + m[0].length]);
      }
    }
  }

  // 3. Bare JSON — only if the content is essentially nothing-but-JSON,
  //    so we don't accidentally swallow an explanation paragraph that
  //    happens to mention a tool.
  if (calls.length === 0) {
    const m = content.match(LEADING_JSON_RE);
    if (m) {
      const parsed = _safeParseAny(m[1]);
      const normalized = _normalize(parsed, known);
      if (normalized.length > 0) {
        for (const tc of normalized) calls.push(tc);
        consumedRanges.push([0, content.length]);
      }
    }
  }

  if (calls.length === 0) return { patched: false, addedCalls: 0 };

  // Synthesise OpenAI-style tool_calls.
  message.tool_calls = calls.map((c, i) => ({
    id: `call_extracted_${Date.now()}_${i}`,
    type: 'function',
    function: {
      name: c.name,
      arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}),
    },
  }));

  // Strip the consumed JSON spans from content. Process in reverse so
  // indices stay valid. Only mutate `message.content` — leave
  // `reasoning_content` untouched (it's metadata, not chat history).
  if (!usingReasoningFallback) {
    let newContent = content;
    consumedRanges.sort((a, b) => b[0] - a[0]);
    for (const [s, e] of consumedRanges) {
      newContent = newContent.slice(0, s) + newContent.slice(e);
    }
    message.content = newContent.trim();
  } else {
    // We extracted from reasoning_content; ensure message.content is at
    // least an empty string so the agent loop sees a valid message.
    message.content = typeof message.content === 'string' ? message.content : '';
  }

  return { patched: true, addedCalls: calls.length };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _safeParseAny(text) {
  if (!text) return null;
  const trimmed = text.trim();
  // Strip trailing commas which Qwen sometimes emits.
  const cleaned = trimmed.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(cleaned); } catch {}
  // Multiple JSON objects newline-separated → wrap into array.
  const lines = cleaned.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (lines.length > 1) {
    const arr = [];
    for (const line of lines) {
      try { arr.push(JSON.parse(line.replace(/,(\s*[}\]])/g, '$1'))); } catch { return null; }
    }
    return arr.length > 0 ? arr : null;
  }
  return null;
}

function _parseXmlToolCall(payload) {
  const fn = payload.match(XML_FUNCTION_RE);
  if (!fn) return null;

  const args = {};
  let parameterCount = 0;
  for (const parameter of fn[2].matchAll(XML_PARAMETER_RE)) {
    args[parameter[1]] = _decodeXml(parameter[2].trim());
    parameterCount += 1;
  }
  if (parameterCount === 0) return null;

  // Reject stray non-whitespace content between parameters. This prevents a
  // truncated XML block from silently becoming a different tool invocation.
  const remainder = fn[2].replace(XML_PARAMETER_RE, '').trim();
  if (remainder) return null;
  return { name: fn[1], arguments: args };
}

function _decodeXml(value) {
  return value.replace(/&(lt|gt|amp|quot|apos);/g, (_, entity) => ({
    lt: '<', gt: '>', amp: '&', quot: '"', apos: "'",
  })[entity]);
}

// Normalise whatever the model emitted into [{ name, arguments }, ...].
// Filters out entries that don't reference a known tool, when we have a
// known-tool list. Without a list, accepts anything name-shaped.
function _normalize(parsed, knownNames, options = {}) {
  if (!parsed) return [];
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const tc = _coerceOne(item);
    if (!tc) continue;
    if (!options.allowUnknown && knownNames.size > 0 && !knownNames.has(tc.name)) continue;
    out.push(tc);
  }
  return out;
}

function _coerceOne(item) {
  // Form A: { name, arguments }
  if (typeof item.name === 'string') {
    return { name: item.name, arguments: item.arguments ?? item.parameters ?? {} };
  }
  // Form B: { function: { name, arguments } } — OpenAI shape inline.
  if (item.function && typeof item.function.name === 'string') {
    return { name: item.function.name, arguments: item.function.arguments ?? {} };
  }
  // Form C: { tool, args } — some custom prompts.
  if (typeof item.tool === 'string') {
    return { name: item.tool, arguments: item.args ?? item.arguments ?? {} };
  }
  return null;
}

module.exports = { extractFromMessage };
