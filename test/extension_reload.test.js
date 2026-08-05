'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PluginLoader } = require('../src/plugins/loader');
const { SkillManager } = require('../src/plugins/skills');
const { buildExtensionCatalog } = require('../src/plugins/catalog');

test('skill reload discovers files added after startup', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smallcode-reload-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new SkillManager(root);
  const dir = path.join(root, '.smallcode', 'skills');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fresh.md'), '---\nname: fresh\ntrigger: auto\n---\nnew');
  assert.equal(manager.reload().ok, true);
  assert.ok(manager.get('fresh'));
});

test('plugin reload rolls back when a new manifest is invalid', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smallcode-plugin-reload-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const loader = new PluginLoader(root).loadAll();
  const before = loader.list().map(p => p.name);
  const bad = path.join(root, '.smallcode', 'plugins', 'bad');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'plugin.json'), '{bad json');
  const result = await loader.reload();
  assert.equal(result.ok, false);
  assert.deepEqual(loader.list().map(p => p.name), before);
});

test('plugin reload replaces changed command handlers without duplicates', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smallcode-plugin-change-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '.smallcode', 'plugins', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name: 'demo', commands: [{ name: 'demo', handler: './cmd.js' }] }));
  fs.writeFileSync(path.join(dir, 'cmd.js'), 'module.exports = () => "one";');
  const loader = new PluginLoader(root).loadAll();
  assert.equal(await loader.executeCommand('demo', ''), 'one');
  fs.writeFileSync(path.join(dir, 'cmd.js'), 'module.exports = () => "two";');
  const result = await loader.reload();
  assert.equal(result.ok, true);
  assert.equal(await loader.executeCommand('demo', ''), 'two');
  assert.equal(loader.list().filter(p => p.name === 'demo').length, 1);
});

test('extension catalog exposes paths, scopes, triggers and diagnostics', () => {
  const loader = new PluginLoader(process.cwd()).loadAll();
  const skills = new SkillManager(process.cwd());
  const catalog = buildExtensionCatalog(loader, skills);
  assert.match(catalog.summary, /plugins.*skills.*warnings/);
  assert.ok(catalog.plugins.every(p => p.path && p.scope));
  assert.ok(catalog.skills.every(s => s.path && s.scope && s.trigger));
});
