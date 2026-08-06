// SmallCode — Liquid AI tool-call parser tests
//
// Coverage is the formats observed from `lfm2.5-8b-a1b-apex` via LM Studio
// (issue: bench polyglot-mini scoring 1/19 because every call landed in
// `message.content` instead of `tool_calls`).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { parseLiquidToolCalls } = require('../src/tools/liquid_tool_parser');
const { extractFromMessage } = require('../src/tools/tool_call_extractor');

const SCHEMA = [
  { function: { name: 'read_file' } },
  { function: { name: 'write_file' } },
  { function: { name: 'patch' } },
  { function: { name: 'bash' } },
];

test('parses a single write_file call', () => {
  const text = `<|tool_call_start|>[write_file(path='hello.py', content='def greet(name):\\n    return f"Hello, {name}!"')]<|tool_call_end|>`;
  const { calls, ranges } = parseLiquidToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'write_file');
  assert.equal(calls[0].arguments.path, 'hello.py');
  assert.match(calls[0].arguments.content, /^def greet\(name\):\n {4}return f"Hello, \{name\}!"/);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0][0], 0);
});

test('parses bash() with single-quoted command', () => {
  const text = `<|tool_call_start|>[bash(command='ls -la')]<|tool_call_end|>`;
  const { calls } = parseLiquidToolCalls(text);
  assert.deepEqual(calls, [{ name: 'bash', arguments: { command: 'ls -la' } }]);
});

test('parses multi-call list', () => {
  const text = `<|tool_call_start|>[read_file(path='a.py'), bash(command='ls')]<|tool_call_end|>`;
  const { calls } = parseLiquidToolCalls(text);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'read_file');
  assert.equal(calls[1].name, 'bash');
});

test('handles tab + newline escapes for Makefile content', () => {
  const text = `<|tool_call_start|>[write_file(path='Makefile', content='build:\\n\\t@echo building\\n')]<|tool_call_end|>`;
  const { calls } = parseLiquidToolCalls(text);
  assert.equal(calls[0].arguments.content, 'build:\n\t@echo building\n');
});

test('handles JSON content with embedded double quotes', () => {
  const text = `<|tool_call_start|>[write_file(path='config.json', content='{"name": "myapp", "port": 3000, "features": ["auth", "logging"]}')]<|tool_call_end|>`;
  const { calls } = parseLiquidToolCalls(text);
  assert.equal(calls[0].arguments.path, 'config.json');
  const parsed = JSON.parse(calls[0].arguments.content);
  assert.equal(parsed.name, 'myapp');
  assert.equal(parsed.port, 3000);
  assert.deepEqual(parsed.features, ['auth', 'logging']);
});

test('handles mixed numeric and string args', () => {
  const text = `<|tool_call_start|>[some_tool(count=3, label='x', ratio=1.5, on=True, off=None)]<|tool_call_end|>`;
  const { calls } = parseLiquidToolCalls(text);
  assert.deepEqual(calls[0].arguments, { count: 3, label: 'x', ratio: 1.5, on: true, off: null });
});

test('returns no calls when no markers present', () => {
  assert.deepEqual(parseLiquidToolCalls('hello world').calls, []);
  assert.deepEqual(parseLiquidToolCalls('').calls, []);
});

test('extractor patches message in-place from Liquid format', () => {
  const message = {
    role: 'assistant',
    content: `\n<|tool_call_start|>[write_file(path='hello.py', content='print("hi")')]<|tool_call_end|>\n`,
  };
  const { patched, addedCalls } = extractFromMessage(message, SCHEMA);
  assert.equal(patched, true);
  assert.equal(addedCalls, 1);
  assert.equal(message.tool_calls.length, 1);
  assert.equal(message.tool_calls[0].function.name, 'write_file');
  const args = JSON.parse(message.tool_calls[0].function.arguments);
  assert.equal(args.path, 'hello.py');
  assert.equal(args.content, 'print("hi")');
  // The Liquid block is consumed from content.
  assert.equal(message.content.includes('tool_call_start'), false);
});

test('extractor leaves message alone when structured tool_calls already present', () => {
  const message = {
    role: 'assistant',
    content: `<|tool_call_start|>[bash(command='ls')]<|tool_call_end|>`,
    tool_calls: [{ id: '1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
  };
  const r = extractFromMessage(message, SCHEMA);
  assert.equal(r.patched, false);
});

test('extractor moves unknown Liquid tool names into the structured channel', () => {
  const message = {
    role: 'assistant',
    content: `<|tool_call_start|>[no_such_tool(x='y')]<|tool_call_end|>`,
  };
  const r = extractFromMessage(message, SCHEMA);
  assert.deepEqual(r, { patched: true, addedCalls: 1 });
  assert.equal(message.content, '');
  assert.equal(message.tool_calls[0].function.name, 'no_such_tool');
});

test('extractor recovers Qwen XML tool calls from assistant text', () => {
  const message = {
    role: 'assistant',
    content: `<tool_call>
<function=bash>
<parameter=command>
ls -la data/ai/kanban/todo/ 2&gt;/dev/null || echo "No todo directory"
</parameter>
<parameter=description>
Check kanban todo tasks
</parameter>
</function>
</tool_call>`,
  };
  const result = extractFromMessage(message, SCHEMA);
  assert.deepEqual(result, { patched: true, addedCalls: 1 });
  assert.equal(message.content, '');
  assert.equal(message.tool_calls[0].function.name, 'bash');
  assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), {
    command: 'ls -la data/ai/kanban/todo/ 2>/dev/null || echo "No todo directory"',
    description: 'Check kanban todo tasks',
  });
});

test('extractor recovers multiple Qwen XML calls and preserves prose', () => {
  const message = {
    role: 'assistant',
    content: `Checking both files.
<tool_call><function=read_file><parameter=path>a.md</parameter></function></tool_call>
<tool_call><function=read_file><parameter=path>b.md</parameter></function></tool_call>
Continuing after the reads.`,
  };
  const result = extractFromMessage(message, SCHEMA);
  assert.equal(result.addedCalls, 2);
  assert.equal(message.content, 'Checking both files.\n\n\nContinuing after the reads.');
  assert.deepEqual(message.tool_calls.map(call => JSON.parse(call.function.arguments)), [
    { path: 'a.md' },
    { path: 'b.md' },
  ]);
});

test('extractor moves unknown Qwen XML calls but leaves malformed calls visible', () => {
  const unknown = {
    role: 'assistant',
    content: '<tool_call><function=list_files><parameter=dir>src</parameter></function></tool_call>',
  };
  assert.deepEqual(extractFromMessage(unknown, SCHEMA), { patched: true, addedCalls: 1 });
  assert.equal(unknown.content, '');
  assert.equal(unknown.tool_calls[0].function.name, 'list_files');

  for (const content of [
    '<tool_call><function=bash><parameter=command>ls</function></tool_call>',
  ]) {
    const message = { role: 'assistant', content };
    assert.deepEqual(extractFromMessage(message, SCHEMA), { patched: false, addedCalls: 0 });
    assert.equal(message.content, content);
  }
});

test('parser rejects malformed payload conservatively', () => {
  const text = `<|tool_call_start|>[write_file(path=]<|tool_call_end|>`;
  const { calls } = parseLiquidToolCalls(text);
  assert.equal(calls.length, 0);
});


test('extractor falls back to reasoning_content when content is empty', () => {
  // Observed in the wild: lfm2.5 spends its budget on `reasoning_content`
  // and emits empty `content` plus empty `tool_calls`. Recover the call
  // from reasoning_content as a last-resort.
  const message = {
    role: 'assistant',
    content: '',
    reasoning_content: `\n<|tool_call_start|>[write_file(path='Makefile', content='build:\\n\\t@echo building')]<|tool_call_end|>`,
  };
  const r = extractFromMessage(message, SCHEMA);
  assert.equal(r.patched, true);
  assert.equal(r.addedCalls, 1);
  assert.equal(message.tool_calls[0].function.name, 'write_file');
  // reasoning_content must be left untouched (it's debug/trace metadata).
  assert.match(message.reasoning_content, /tool_call_start/);
});

test('extractor still prefers content over reasoning_content when both are non-empty', () => {
  const message = {
    role: 'assistant',
    content: `<|tool_call_start|>[write_file(path='a.txt', content='primary')]<|tool_call_end|>`,
    reasoning_content: `<|tool_call_start|>[write_file(path='b.txt', content='reasoning')]<|tool_call_end|>`,
  };
  const r = extractFromMessage(message, SCHEMA);
  assert.equal(r.addedCalls, 1);
  const args = JSON.parse(message.tool_calls[0].function.arguments);
  assert.equal(args.path, 'a.txt');
});
