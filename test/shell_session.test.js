// SmallCode — persistent shell session (issue #58, parts 1 & 2)
//
// 1. zsh users: the shell must launch with bash on POSIX regardless of $SHELL,
//    because the sentinel command-wrapper emits bash/POSIX syntax and passes
//    bash-only flags. Honouring $SHELL=zsh broke every bash tool call.
// 2. stdin EPIPE: a dead shell must not crash the process with an unhandled
//    'error' event on stdin.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { ShellSession } = require('../src/tools/shell_session');

test('shell runs a command and captures output + exit code', async () => {
  const sh = new ShellSession({ timeout: 15000 });
  try {
    const r = await sh.run(process.platform === 'win32' ? 'echo hi' : 'echo hi');
    assert.match(r.stdout, /hi/);
    assert.equal(r.exitCode, 0);
  } finally {
    await sh.close();
  }
});

test('shell launches successfully even when $SHELL is zsh (POSIX)', async () => {
  if (process.platform === 'win32') return; // POSIX-only concern
  const prev = process.env.SHELL;
  process.env.SHELL = '/usr/bin/zsh';
  const sh = new ShellSession({ timeout: 15000 });
  try {
    const started = await sh.start();
    assert.equal(started, true, 'shell should start with bash, not zsh --norc');
    const r = await sh.run('echo zsh-ok');
    assert.match(r.stdout, /zsh-ok/);
    assert.equal(r.exitCode, 0);
  } finally {
    await sh.close();
    if (prev === undefined) delete process.env.SHELL;
    else process.env.SHELL = prev;
  }
});

test('a stopped shell auto-restarts on the next run without crashing', async () => {
  const sh = new ShellSession({ timeout: 15000 });
  try {
    await sh.run('echo first');
    await sh.close();          // kill the shell
    // Next run must transparently restart rather than throwing / crashing.
    const r = await sh.run(process.platform === 'win32' ? 'echo second' : 'echo second');
    assert.match(r.stdout, /second/);
    assert.equal(r.exitCode, 0);
  } finally {
    await sh.close();
  }
});

test('stdin has an error listener attached (no unhandled EPIPE)', async () => {
  const sh = new ShellSession({ timeout: 15000 });
  try {
    await sh.start();
    assert.ok(sh.proc, 'process should be spawned');
    // The fix attaches an 'error' listener to stdin at spawn time.
    assert.ok(sh.proc.stdin.listenerCount('error') >= 1,
      'stdin must have an error listener to swallow async EPIPE');
  } finally {
    await sh.close();
  }
});

test('close is idempotent and releases process streams', async () => {
  const sh = new ShellSession({ timeout: 15000 });
  await sh.run('echo close-ok');
  await Promise.all([sh.close(), sh.close()]);
  assert.equal(sh.proc, null);
  assert.equal(sh.queue.length, 0);
});
