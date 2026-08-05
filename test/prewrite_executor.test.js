'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { executeTool } = require('../bin/executor');

function context(events) {
  return {
    _fullscreenRef: {
      addTool: (...args) => events.push(['tool', ...args]),
      addFileDiff: (...args) => events.push(['diff', ...args]),
    },
    tui: { renderDiff: () => '' },
    flags: {},
    config: {},
  };
}

test('all direct write tools block invalid candidates before changing files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smallcode-executor-prewrite-'));
  const oldCwd = process.cwd();
  const events = [];
  try {
    process.chdir(root);
    fs.writeFileSync('target.js', 'const value = 1;\n');
    const ctx = context(events);
    const calls = [
      ['write_file', { path: 'new/broken.js', content: 'const = ;' }],
      ['append_file', { path: 'target.js', content: 'function broken( {' }],
      ['patch', { path: 'target.js', old_str: 'const value = 1;', new_str: 'const value = ;' }],
      ['read_and_patch', { path: 'target.js', old_str: 'const value = 1;', new_str: 'const value = ;' }],
      ['create_and_run', { path: 'run.js', content: 'function broken( {', command: 'node run.js' }],
    ];
    for (const [name, args] of calls) {
      const result = await executeTool(name, args, ctx);
      assert.equal(result.kind, 'prewrite_validation', name);
    }
    assert.equal(fs.readFileSync('target.js', 'utf8'), 'const value = 1;\n');
    assert.equal(fs.existsSync('new'), false);
    assert.equal(fs.existsSync('run.js'), false);
    assert.equal(events.some(event => event[0] === 'diff'), false);
    assert.equal(events.filter(event => event[0] === 'tool' && event[1] === 'verify').length, calls.length);
  } finally {
    process.chdir(oldCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('successful write reports verification before its diff', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smallcode-executor-prewrite-'));
  const oldCwd = process.cwd();
  const events = [];
  try {
    process.chdir(root);
    const result = await executeTool('write_file', { path: 'valid.ts', content: 'export const value: number = 1;\n' }, context(events));
    assert.equal(result.action, 'Created');
    assert.equal(fs.readFileSync('valid.ts', 'utf8'), 'export const value: number = 1;\n');
    assert.deepEqual(events.map(event => event[0]), ['tool', 'diff']);
    assert.match(events[0][3], /passed/);
  } finally {
    process.chdir(oldCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('programmatic API uses the same pre-write gate', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smallcode-api-prewrite-'));
  try {
    const { SmallCode } = require('../src/api');
    const api = new SmallCode({ cwd: root, planning: { enabled: false } });
    const result = await api._executeTool('write_file', { path: 'broken.json', content: '{]' });
    assert.equal(result.kind, 'prewrite_validation');
    assert.equal(fs.existsSync(path.join(root, 'broken.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
