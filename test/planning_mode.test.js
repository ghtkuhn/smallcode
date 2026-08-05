'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PlanningModeController, PlanStore, ModePolicy } = require('../src/session/planning_mode');
const { validatePlanShellCommand } = require('../src/security/plan_shell_policy');
const { SmallCode } = require('../src/api');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smallcode-plan-'));
  const store = new PlanStore({ workspaceRoot: root, dir: path.join(root, 'cache') });
  return { root, store, controller: new PlanningModeController({ workspaceRoot: root, store }) };
}

test('planning mode defaults on and follows plan -> execution -> plan', () => {
  const { controller } = fixture();
  assert.equal(controller.mode, 'plan');
  const submitted = controller.submitPlan({ title: 'Change', steps: ['Inspect', 'Edit'], verification: ['test'] });
  assert.equal(submitted.ok, true);
  assert.equal(controller.beginExecution().ok, true);
  assert.equal(controller.mode, 'execution');
  controller.finishExecution(true);
  assert.equal(controller.mode, 'plan');
  assert.equal(controller.getPlan().status, 'completed');
});

test('failed and cancelled plans remain available after returning to plan mode', () => {
  const { controller } = fixture();
  controller.submitPlan({ title: 'Change', steps: ['Edit'] });
  controller.beginExecution(); controller.finishExecution(false, 'broken');
  assert.equal(controller.mode, 'plan'); assert.equal(controller.getPlan().status, 'failed');
  controller.beginExecution(); controller.cancelExecution();
  assert.equal(controller.mode, 'plan'); assert.equal(controller.getPlan().status, 'cancelled');
});

test('natural consent is deliberately narrow', () => {
  const { controller } = fixture();
  controller.submitPlan({ title: 'Change', steps: ['Edit'] });
  assert.equal(controller.isExecutionConsent('mach das'), true);
  assert.equal(controller.isExecutionConsent('mach das, aber ändere zusätzlich die API'), false);
  controller.beginExecution(); controller.finishExecution(true);
  assert.equal(controller.isExecutionConsent('mach das'), false);
});

test('mode policy hides and blocks mutation tools in plan mode', () => {
  const { controller, root } = fixture();
  const policy = new ModePolicy(controller);
  const tools = [{ type: 'function', function: { name: 'read_file' } }, { type: 'function', function: { name: 'write_file' } }, { type: 'function', readOnly: true, function: { name: 'plugin_read', readOnly: true } }];
  assert.deepEqual(policy.filterTools(tools).map(t => t.function.name), ['read_file', 'plugin_read']);
  assert.equal(policy.authorizeTool('write_file', {}, null, { workspaceRoot: root, cwd: root }).ok, false);
  controller.enabled = false; controller.mode = 'direct';
  assert.equal(policy.authorizeTool('write_file').ok, true);
});

test('plan shell allowlist permits inspection and rejects mutation/evaluation', () => {
  for (const command of ['pwd', 'rg -n TODO src | sort | head -20', "rg 'a|b' src", 'git status --short', 'find src -name "*.js"', "sed -n '1,20p' file.js", 'jq . package.json']) assert.equal(validatePlanShellCommand(command).ok, true, command);
  for (const command of ['rm x', 'cat a > b', 'sort -o out.txt input.txt', 'sed -i s/a/b/ file', 'uniq input output', 'node script.js', 'find . -delete', 'git checkout -- x', 'rg $(touch x)', 'ls & touch x']) assert.equal(validatePlanShellCommand(command).ok, false, command);
});

test('plan store is workspace-scoped and supports latest', () => {
  const { controller, store } = fixture();
  const plan = controller.submitPlan({ title: 'Stored', steps: ['One'] }).plan;
  assert.equal(store.load(plan.id).title, 'Stored');
  assert.equal(store.latest().id, plan.id);
});

test('programmatic API defaults to plan mode and can opt into direct mode', async () => {
  const { root } = fixture();
  const planned = new SmallCode({ cwd: root, planStoreDir: path.join(root, 'api-plans') });
  assert.equal(planned.mode, 'plan');
  assert.equal(planned._getTools().some(t => t.function.name === 'write_file'), false);
  const blocked = await planned._executeTool('write_file', { path: 'x.js', content: 'ok' });
  assert.equal(blocked.kind, 'mode_policy');
  const direct = new SmallCode({ cwd: root, planning: { enabled: false } });
  assert.equal(direct.mode, 'direct');
  assert.equal(direct._getTools().some(t => t.function.name === 'write_file'), true);
});
