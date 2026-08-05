'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WriteValidationRegistry, validatePythonWithCPython } = require('../src/validation/write_validation');
const { prepareFileEdit, commitValidatedEdit } = require('../src/validation/file_edit_transaction');

const validCases = [
  ['index.js', 'export function ok(value) { return value + 1; }'],
  ['view.jsx', 'export const View = () => <main>ok</main>;'],
  ['types.ts', 'interface User { name: string }\nexport const user: User = { name: "Ada" };'],
  ['view.tsx', 'type Props = { title: string }; export const View = (p: Props) => <h1>{p.title}</h1>;'],
  ['types.d.ts', 'declare module "demo" { export function run(): void; }'],
  ['script.py', 'def greet(name):\n    return f"Hello {name}"\n'],
  ['config.yaml', '---\nname: demo\n---\nenabled: true\n'],
  ['style.css', '@media (min-width: 10px) { .box { color: red; } }'],
  ['data.json', '{"ok":true,"items":[1,2]}'],
  ['app.ini', '\uFEFF[app]\nname = demo\ndescription: first line\n  continued\n'],
];

const invalidCases = [
  ['index.js', 'function broken( {'],
  ['view.tsx', 'const View = () => <main>'],
  ['script.py', 'def broken(:\n  pass'],
  ['config.yaml', 'name: [unterminated'],
  ['style.css', '.box { color: red;'],
  ['data.json', '{"ok": true,}'],
  ['app.ini', '[missing\nkey=value'],
];

test('required core formats accept valid complete candidates', async () => {
  const registry = new WriteValidationRegistry({ disablePythonProcess: true });
  for (const [filePath, content] of validCases) {
    const result = await registry.validateCandidate({ filePath, content });
    assert.equal(result.status, 'pass', `${filePath}: ${JSON.stringify(result.diagnostics)}`);
  }
});

test('required core formats reject syntax errors with positions', async () => {
  const registry = new WriteValidationRegistry({ disablePythonProcess: true });
  for (const [filePath, content] of invalidCases) {
    const result = await registry.validateCandidate({ filePath, content });
    assert.equal(result.status, 'fail', filePath);
    assert.ok(result.diagnostics[0].line >= 1, filePath);
    assert.ok(result.diagnostics[0].column >= 1, filePath);
  }
});

test('unknown formats are explicitly skipped', async () => {
  const result = await new WriteValidationRegistry().validateCandidate({ filePath: 'notes.xyz', content: 'anything' });
  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'unsupported');
});

test('failed pre-write validation leaves file and directories untouched', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smallcode-prewrite-'));
  try {
    const existing = path.join(root, 'existing.js');
    fs.writeFileSync(existing, 'const valid = true;\n', { mode: 0o640 });
    const failed = await prepareFileEdit({ filePath: existing, content: 'const = ;', previousContent: 'const valid = true;\n', workspaceRoot: root });
    assert.equal(failed.ok, false);
    assert.equal(failed.kind, 'prewrite_validation');
    assert.equal(fs.readFileSync(existing, 'utf8'), 'const valid = true;\n');

    const absent = path.join(root, 'new', 'broken.json');
    const newFailed = await prepareFileEdit({ filePath: absent, content: '{]', workspaceRoot: root });
    assert.equal(newFailed.ok, false);
    assert.equal(fs.existsSync(path.dirname(absent)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validated commits are atomic and preserve existing mode', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smallcode-prewrite-'));
  try {
    const filePath = path.join(root, 'index.js');
    fs.writeFileSync(filePath, 'const oldValue = 1;\n', { mode: 0o640 });
    const beforeMode = fs.statSync(filePath).mode & 0o777;
    const prepared = await prepareFileEdit({ filePath, content: 'const newValue = 2;\n', previousContent: 'const oldValue = 1;\n', workspaceRoot: root });
    assert.equal(prepared.ok, true);
    commitValidatedEdit(prepared);
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'const newValue = 2;\n');
    assert.equal(fs.statSync(filePath).mode & 0o777, beforeMode);
    assert.deepEqual(fs.readdirSync(root).sort(), ['index.js']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('plugin validators register and unregister by owner', async () => {
  const registry = new WriteValidationRegistry();
  registry.register({ name: 'dsl', owner: 'demo', extensions: ['.dsl'], validate: ({ content }) => content === 'ok' ? [] : [{ message: 'bad DSL', line: 1, column: 1 }] });
  assert.equal((await registry.validateCandidate({ filePath: 'x.dsl', content: 'bad' })).status, 'fail');
  assert.equal(registry.unregisterOwner('demo'), 1);
  assert.equal((await registry.validateCandidate({ filePath: 'x.dsl', content: 'bad' })).status, 'skip');
});

test('CPython validation compiles stdin without executing it', async t => {
  const marker = path.join(os.tmpdir(), `smallcode-python-marker-${process.pid}`);
  try { fs.unlinkSync(marker); } catch {}
  const content = `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("executed")\n`;
  const result = await validatePythonWithCPython(content, 'candidate.py');
  if (result === null) return t.skip('python3 unavailable');
  assert.deepEqual(result.diagnostics, []);
  assert.equal(fs.existsSync(marker), false);
  const invalid = await validatePythonWithCPython('def broken(:\n pass', 'candidate.py');
  assert.ok(invalid.diagnostics[0].line >= 1);
});

test('abort and validator timeout block the candidate', async () => {
  const registry = new WriteValidationRegistry();
  registry.register({ name: 'slow', owner: 'demo', extensions: ['.slow'], validate: () => new Promise(() => {}) });
  const timedOut = await registry.validateCandidate({ filePath: 'x.slow', content: 'x' }, { timeoutMs: 10 });
  assert.equal(timedOut.status, 'fail');
  assert.equal(timedOut.diagnostics[0].code, 'VALIDATOR_ERROR');

  const controller = new AbortController();
  controller.abort();
  const aborted = await prepareFileEdit({ filePath: 'x.js', content: 'const ok = true;', signal: controller.signal, registry });
  assert.equal(aborted.ok, false);
  assert.equal(aborted.kind, 'cancelled');
});
