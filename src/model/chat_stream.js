'use strict';

function appendPart(current, part) {
  return current + (typeof part === 'string' ? part : '');
}

class ChatCompletionAccumulator {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.content = '';
    this.reasoning = '';
    this.toolCalls = new Map();
    this.finishReason = null;
    this.usage = undefined;
    this.id = undefined;
    this.model = undefined;
  }

  push(chunk) {
    if (!chunk || typeof chunk !== 'object') return;
    if (chunk.id) this.id = chunk.id;
    if (chunk.model) this.model = chunk.model;
    if (chunk.usage) this.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason != null) this.finishReason = choice.finish_reason;
    const delta = choice.delta || choice.message || {};

    if (typeof delta.content === 'string' && delta.content) {
      this.content = appendPart(this.content, delta.content);
      this.callbacks.onContent?.(delta.content);
    }
    const reasoningPart = [delta.reasoning_content, delta.reasoning, delta.thinking]
      .find(value => typeof value === 'string' && value.length > 0);
    if (reasoningPart) {
      this.reasoning = appendPart(this.reasoning, reasoningPart);
      this.callbacks.onReasoning?.(reasoningPart);
    }

    for (const fragment of delta.tool_calls || []) {
      const index = Number.isInteger(fragment.index) ? fragment.index : this.toolCalls.size;
      const current = this.toolCalls.get(index) || {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      };
      if (fragment.id) current.id = appendPart(current.id, fragment.id);
      if (fragment.type) current.type = fragment.type;
      if (fragment.function?.name) current.function.name = appendPart(current.function.name, fragment.function.name);
      if (fragment.function?.arguments) current.function.arguments = appendPart(current.function.arguments, fragment.function.arguments);
      this.toolCalls.set(index, current);
    }
  }

  result() {
    const message = { role: 'assistant', content: this.content || null };
    if (this.reasoning) message.reasoning_content = this.reasoning;
    if (this.toolCalls.size > 0) {
      message.tool_calls = [...this.toolCalls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => call);
    }
    return {
      ...(this.id ? { id: this.id } : {}),
      ...(this.model ? { model: this.model } : {}),
      choices: [{ message, finish_reason: this.finishReason }],
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }
}

function isEventStream(response) {
  return String(response?.headers?.get?.('content-type') || '').toLowerCase().includes('text/event-stream');
}

async function readChatCompletionResponse(response, callbacks = {}) {
  if (!isEventStream(response) || !response.body?.getReader) {
    const data = await response.json();
    const message = data?.choices?.[0]?.message;
    const reasoning = message?.reasoning_content || message?.reasoning || message?.thinking;
    if (typeof reasoning === 'string' && reasoning) callbacks.onReasoning?.(reasoning);
    callbacks.onReasoningEnd?.();
    return data;
  }

  const accumulator = new ChatCompletionAccumulator(callbacks);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let doneMarker = false;
  const processLine = line => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      doneMarker = true;
      return;
    }
    try { accumulator.push(JSON.parse(payload)); } catch {}
  };
  while (!doneMarker) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) processLine(line);
  }
  if (buffer.trim()) processLine(buffer.trim());
  callbacks.onReasoningEnd?.();
  return accumulator.result();
}

function stripEphemeralReasoning(message) {
  if (!message || typeof message !== 'object') return message;
  delete message.reasoning_content;
  delete message.reasoning;
  delete message.thinking;
  return message;
}

module.exports = { ChatCompletionAccumulator, readChatCompletionResponse, isEventStream, stripEphemeralReasoning };
