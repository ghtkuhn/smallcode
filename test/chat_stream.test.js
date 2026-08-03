'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChatCompletionAccumulator, readChatCompletionResponse, stripEphemeralReasoning } = require('../src/model/chat_stream');

test('accumulator combines reasoning, content, usage, and fragmented tool calls', () => {
  const reasoning = [];
  const acc = new ChatCompletionAccumulator({ onReasoning: token => reasoning.push(token) });
  acc.push({ id: 'x', model: 'm', choices: [{ delta: { reasoning_content: 'Let ' } }] });
  acc.push({ choices: [{ delta: { reasoning: 'me think. ', content: 'Done', tool_calls: [{ index: 0, id: 'call_', type: 'function', function: { name: 'patch', arguments: '{"pa' } }] } }] });
  acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: '1', function: { arguments: 'th":"a"}' } }] }, finish_reason: 'tool_calls' }], usage: { completion_tokens: 12 } });
  const result = acc.result();
  assert.equal(reasoning.join(''), 'Let me think. ');
  assert.equal(result.choices[0].message.content, 'Done');
  assert.equal(result.choices[0].message.reasoning_content, 'Let me think. ');
  assert.deepEqual(result.choices[0].message.tool_calls[0], { id: 'call_1', type: 'function', function: { name: 'patch', arguments: '{"path":"a"}' } });
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.equal(result.usage.completion_tokens, 12);
});

test('SSE reader handles chunk boundaries and emits live reasoning', async () => {
  const encoded = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"reasoning_content":"first "}}]}\n',
    '\ndata: {"choices":[{"delta":{"reasoning_content":"second"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  ].map(value => encoded.encode(value));
  let index = 0;
  const response = {
    headers: { get: () => 'text/event-stream; charset=utf-8' },
    body: { getReader: () => ({ read: async () => index < chunks.length ? { done: false, value: chunks[index++] } : { done: true } }) },
  };
  const seen = [];
  const result = await readChatCompletionResponse(response, { onReasoning: token => seen.push(token) });
  assert.equal(seen.join(''), 'first second');
  assert.equal(result.choices[0].message.reasoning_content, 'first second');
});

test('JSON response remains unchanged and surfaces completed reasoning', async () => {
  const data = { choices: [{ message: { role: 'assistant', content: 'ok', reasoning_content: 'thought' }, finish_reason: 'stop' }] };
  const seen = [];
  const result = await readChatCompletionResponse({ headers: { get: () => 'application/json' }, json: async () => data }, { onReasoning: token => seen.push(token) });
  assert.equal(result, data);
  assert.deepEqual(seen, ['thought']);
});

test('ephemeral reasoning is removed before history persistence', () => {
  const message = {
    role: 'assistant',
    content: 'answer',
    reasoning_content: 'private stream',
    reasoning: 'alternate field',
    thinking: 'legacy field',
    tool_calls: [{ id: 'call_1' }],
  };
  stripEphemeralReasoning(message);
  assert.deepEqual(message, {
    role: 'assistant',
    content: 'answer',
    tool_calls: [{ id: 'call_1' }],
  });
});
