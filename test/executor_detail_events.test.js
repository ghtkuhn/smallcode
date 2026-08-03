'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { executeTool } = require('../bin/executor');

test('successful file mutation tools emit chronological detail diffs', async () => {
  const previousCwd = process.cwd();
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'smallcode-detail-events-'));
  const events = [];
  const context = {
    _fullscreenRef: {
      addFileDiff: (...args) => events.push(args),
      addTool: () => {},
    },
    tui: { renderDiff: () => '' },
    config: { context: { detected_window: 8192 } },
    flags: {},
  };
  try {
    process.chdir(workdir);
    const operations = [
      ['write_file', { path: 'a.txt', content: 'one\ntwo' }],
      ['append_file', { path: 'a.txt', content: 'three' }],
      ['patch', { path: 'a.txt', old_str: 'one', new_str: 'ONE' }],
      ['read_and_patch', { path: 'a.txt', old_str: 'two', new_str: 'TWO' }],
    ];
    for (const [name, args] of operations) {
      const result = await executeTool(name, args, context);
      assert.equal(result.error, undefined, `${name}: ${result.error}`);
    }
    assert.deepEqual(events, [
      ['a.txt', '', 'one\ntwo', 1],
      ['a.txt', '', '\nthree', 2],
      ['a.txt', 'one', 'ONE', 1],
      ['a.txt', 'two', 'TWO', 2],
    ]);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('failed file mutation does not emit a detail diff', async () => {
  const events = [];
  const result = await executeTool('patch', {
    path: 'definitely-missing-file.txt',
    old_str: 'a',
    new_str: 'b',
  }, {
    _fullscreenRef: { addFileDiff: (...args) => events.push(args), addTool: () => {} },
    tui: { renderDiff: () => '' },
    config: {},
    flags: {},
  });
  assert.ok(result.error);
  assert.deepEqual(events, []);
});
