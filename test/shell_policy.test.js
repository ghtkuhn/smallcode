'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validateShellCommand } = require('../src/security/shell_policy');
const { executeTool } = require('../bin/executor');
const { SmallCode } = require('../src/api');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smallcode-policy-'));
  fs.mkdirSync(path.join(root, 'sub'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('allows destructive targets contained in the workspace', t => {
  const root = workspace(t);
  for (const command of ['rm sub/file', 'rm ./*', 'rmdir sub', 'echo ok > sub/out', 'truncate -s 0 sub/out', 'git clean -fd']) {
    assert.equal(validateShellCommand(command, { workspaceRoot: root, cwd: root }).ok, true, command);
  }
  assert.equal(validateShellCommand('echo rm', { workspaceRoot: root, cwd: root }).ok, true);
  assert.equal(validateShellCommand('git status', { workspaceRoot: root, cwd: root }).ok, true);
});

test('blocks outside, root, and dynamic destructive targets', t => {
  const root = workspace(t);
  const cases = [
    ['rm ../outside', 'OUTSIDE_WORKSPACE'],
    [`rm ${root}`, 'WORKSPACE_ROOT'],
    ['rm -rf .', 'WORKSPACE_ROOT'],
    ['echo nope > ../outside', 'OUTSIDE_WORKSPACE'],
    ['mv ../outside sub/file', 'OUTSIDE_WORKSPACE'],
    ['rm "$TARGET"', 'DYNAMIC_COMMAND'],
    ['rm $(pwd)/file', 'DYNAMIC_COMMAND'],
    ['(cd sub && rm file)', 'AMBIGUOUS_SUBSHELL'],
    ['sudo rm sub/file', 'AMBIGUOUS_DESTRUCTIVE_COMMAND'],
    ['git --work-tree=../outside clean -fd', 'OUTSIDE_WORKSPACE'],
    ['tee ../outside', 'OUTSIDE_WORKSPACE'],
    ['dd if=sub/in of=../outside', 'OUTSIDE_WORKSPACE'],
    ['cp --target-directory=../outside sub/in', 'OUTSIDE_WORKSPACE'],
  ];
  for (const [command, code] of cases) assert.equal(validateShellCommand(command, { workspaceRoot: root, cwd: root }).code, code, command);
});

test('blocks directory changes outside the fixed workspace', t => {
  const root = workspace(t);
  assert.equal(validateShellCommand('cd ..', { workspaceRoot: root, cwd: root }).code, 'OUTSIDE_WORKSPACE');
  const result = validateShellCommand('cd sub; rm file', { workspaceRoot: root, cwd: root });
  assert.equal(result.ok, true);
  assert.equal(result.nextCwd, fs.realpathSync(path.join(root, 'sub')));
});

test('resolves symlink ancestors before allowing destructive targets', t => {
  if (process.platform === 'win32') return;
  const root = workspace(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'smallcode-policy-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, 'escape'));
  assert.equal(validateShellCommand('rm escape/file', { workspaceRoot: root, cwd: root }).code, 'OUTSIDE_WORKSPACE');
});

test('supports Windows command forms and path boundaries lexically', () => {
  const options = { workspaceRoot: 'C:\\work', cwd: 'C:\\work', platform: 'win32' };
  assert.equal(validateShellCommand('del sub\\file.txt', options).ok, true);
  assert.equal(validateShellCommand('del C:\\Windows\\file.txt', options).code, 'OUTSIDE_WORKSPACE');
  assert.equal(validateShellCommand('rd /s C:\\work', options).code, 'WORKSPACE_ROOT');
  assert.equal(validateShellCommand('del %TEMP%\\file.txt', options).code, 'DYNAMIC_COMMAND');
});

test('executor rejects an outside deletion before starting a process', async t => {
  const root = workspace(t);
  const previous = process.cwd();
  process.chdir(root);
  t.after(() => process.chdir(previous));
  const result = await executeTool('bash', { command: 'rm ../outside' }, {
    _fullscreenRef: null, mcpCall: null, memoryStore: null, pluginLoader: null,
    mcpClient: null, flags: {}, config: {}, tui: null, workspaceRoot: root,
  });
  assert.match(result.error, /Shell policy blocked \[OUTSIDE_WORKSPACE\]/);

  const runResult = await executeTool('run', { command: 'rm ../outside' }, {
    _fullscreenRef: null, mcpCall: null, memoryStore: null, pluginLoader: null,
    mcpClient: null, flags: {}, config: {}, tui: null, workspaceRoot: root,
  });
  assert.match(runResult.error, /Shell policy blocked \[OUTSIDE_WORKSPACE\]/);
});

test('programmatic API uses the same shell policy', async t => {
  const root = workspace(t);
  const agent = new SmallCode({ cwd: root, planning: { enabled: false } });
  const result = await agent._executeTool('bash', { command: 'rm ../outside' });
  assert.match(result.error, /Shell policy blocked \[OUTSIDE_WORKSPACE\]/);
});
