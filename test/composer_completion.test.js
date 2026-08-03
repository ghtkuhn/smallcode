'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PluginLoader } = require('../src/plugins/loader');
const { FullScreenTUI } = require('../src/tui/fullscreen');
const { resolveReferences } = require('../src/session/references');

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'smallcode-completion-'));
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'main.js'), 'console.log("ok");\n');
  fs.writeFileSync(path.join(cwd, 'my notes.md'), '# Notes\n');
  return cwd;
}

test('project plugin registers a generic @ completion provider', () => {
  const root = path.resolve(__dirname, '..');
  const loader = new PluginLoader(root).loadAll();
  const provider = loader.getCompletionProviders().find(item => item.plugin === 'file-mentions');
  assert.ok(provider);
  assert.equal(provider.trigger, '@');
  assert.equal(typeof provider.complete, 'function');
});

test('file mention provider returns files, folders, and quoted selections', async t => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const provider = require('../.smallcode/plugins/file-mentions/completion');

  const src = await provider.complete({ cwd, query: 'src' });
  assert.ok(src.some(item => item.value === '@src/'));
  assert.ok(src.some(item => item.value === '@src/main.js'));

  const notes = await provider.complete({ cwd, query: 'notes' });
  assert.equal(notes[0].value, '@"my notes.md"');
});

test('composer opens, navigates, and inserts provider completions', async () => {
  const provider = {
    trigger: '@',
    title: 'Files',
    complete: ({ query }) => [
      { label: `${query}one.js`, detail: 'file', value: '@one.js' },
      { label: `${query}two.js`, detail: 'file', value: '@two.js' },
    ],
  };
  const tui = new FullScreenTUI({ completionProviders: [provider] });

  await tui._onKeypress(Buffer.from('fix @t'));
  assert.equal(tui.completion.query, 't');
  assert.equal(tui.completion.items.length, 2);

  await tui._onKeypress(Buffer.from('\x1b[B'));
  await tui._onKeypress(Buffer.from('\t'));
  assert.equal(tui.inputBuffer, 'fix @two.js ');
  assert.equal(tui.completion, null);
});

test('quoted @ references resolve paths containing spaces', t => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const resolved = resolveReferences('review @"my notes.md"', cwd);
  assert.equal(resolved.files.length, 1);
  assert.equal(resolved.files[0].path, 'my notes.md');
  assert.match(resolved.files[0].content, /Notes/);
});
