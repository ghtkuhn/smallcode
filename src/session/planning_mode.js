'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { validatePlanShellCommand } = require('../security/plan_shell_policy');

const READ_ONLY_TOOLS = new Set([
  'list_projects', 'graph_search', 'explain_symbol', 'memory_load', 'memory_list',
  'read_file', 'search', 'hybrid_search', 'find_files', 'find_and_read',
  'search_and_read', 'bone_check', 'web_search', 'web_fetch', 'provider_status',
  'contract_status', 'submit_plan', 'bash',
]);

function planId() {
  return `plan-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function normalizePlan(input, fallbackTask = '') {
  const steps = Array.isArray(input?.steps) ? input.steps.map(String).map(s => s.trim()).filter(Boolean).slice(0, 12) : [];
  if (!input || steps.length < 1) return null;
  return {
    id: input.id || planId(), title: String(input.title || 'Implementation plan').trim(),
    summary: String(input.summary || fallbackTask || '').trim(), steps,
    verification: Array.isArray(input.verification) ? input.verification.map(String).filter(Boolean) :
      (input.verification ? [String(input.verification)] : []),
    task: String(input.task || fallbackTask || '').trim(), revision: Number(input.revision || 1),
    status: input.status || 'ready', createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

class PlanStore {
  constructor(options = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    const hash = crypto.createHash('sha256').update(this.workspaceRoot).digest('hex').slice(0, 16);
    this.dir = options.dir || path.join(os.homedir(), '.cache', 'smallcode', 'plans', hash);
    this.limit = options.limit || 50;
  }
  save(plan) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const target = path.join(this.dir, `${plan.id}.json`);
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(plan, null, 2), { mode: 0o600 });
    fs.renameSync(temp, target);
    const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json')).map(f => ({ f, t: fs.statSync(path.join(this.dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const old of files.slice(this.limit)) fs.unlinkSync(path.join(this.dir, old.f));
    return plan;
  }
  load(id) { if (typeof id !== 'string' || !/^plan-[A-Za-z0-9-]{1,80}$/.test(id)) return null; try { return JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8')); } catch { return null; } }
  list() { try { return fs.readdirSync(this.dir).filter(f => f.endsWith('.json')).map(f => this.load(f.slice(0, -5))).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); } catch { return []; } }
  latest() { return this.list()[0] || null; }
}

class PlanningModeController {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.source = options.source || 'default';
    this.store = options.store || new PlanStore({ workspaceRoot: options.workspaceRoot });
    this.mode = this.enabled ? 'plan' : 'direct';
    this.activePlan = null;
    this.originalTask = '';
  }
  beginPlanning(task = '') { this.mode = this.enabled ? 'plan' : 'direct'; if (task) this.originalTask = task; return this.snapshot(); }
  submitPlan(input) {
    const next = normalizePlan({ ...input, task: input?.task || this.originalTask }, this.originalTask);
    if (!next) return { ok: false, error: 'A plan requires between 1 and 12 non-empty steps.' };
    if (this.activePlan && !input?.id) { next.id = this.activePlan.id; next.createdAt = this.activePlan.createdAt; next.revision = this.activePlan.revision + 1; }
    this.activePlan = this.store.save(next); this.mode = 'plan';
    return { ok: true, plan: this.activePlan };
  }
  beginExecution(id) {
    if (!this.enabled) { this.mode = 'direct'; return { ok: true, plan: null }; }
    const selected = id ? this.store.load(id) : this.activePlan;
    if (!selected) return { ok: false, error: 'No ready plan. Create a plan first.' };
    this.activePlan = { ...selected, status: 'executing', updatedAt: new Date().toISOString() };
    this.store.save(this.activePlan); this.mode = 'execution'; return { ok: true, plan: this.activePlan };
  }
  finishExecution(success = true, error = null) {
    if (this.activePlan) { this.activePlan = { ...this.activePlan, status: success ? 'completed' : 'failed', error: error || null, updatedAt: new Date().toISOString() }; this.store.save(this.activePlan); }
    this.mode = this.enabled ? 'plan' : 'direct'; return this.snapshot();
  }
  cancelExecution() { if (this.activePlan) { this.activePlan = { ...this.activePlan, status: 'cancelled', updatedAt: new Date().toISOString() }; this.store.save(this.activePlan); } this.mode = this.enabled ? 'plan' : 'direct'; return this.snapshot(); }
  discard() { this.activePlan = null; this.originalTask = ''; this.mode = this.enabled ? 'plan' : 'direct'; }
  getPlan() { return this.activePlan; }
  isExecutionConsent(text) { return !!this.activePlan && this.activePlan.status !== 'completed' && /^(mach das|setz(?:e)? (?:das|den plan) um|umsetzen|ausf(?:ü|u)hren|execute|do it|go ahead|proceed|start(?:e)?(?: damit)?|ja,? bitte)[.!\s]*$/i.test(String(text || '').trim()); }
  snapshot() { return { enabled: this.enabled, mode: this.mode, source: this.source, plan: this.activePlan, planId: this.activePlan?.id || null }; }
  prompt() {
    if (!this.enabled) return '';
    if (this.mode === 'execution') {
      const p = this.activePlan;
      return `\n\nMODE: EXECUTION. Execute only this approved plan, then stop:\n${p?.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') || '(missing plan)'}`;
    }
    return `\n\nMODE: PLAN. You may inspect the workspace but must not modify files, configuration, memory, git state, or run builds/tests/programs. For a requested change, investigate first, then call submit_plan exactly once and stop. For a purely read-only question, answer directly without submitting a plan.`;
  }
}

class ModePolicy {
  constructor(controller) { this.controller = controller; }
  isPlanMode() { return this.controller?.enabled && this.controller.mode === 'plan'; }
  filterTools(tools = []) {
    if (!this.isPlanMode()) return tools;
    return tools.filter(tool => {
      const name = tool?.function?.name;
      if (READ_ONLY_TOOLS.has(name)) return true;
      return tool?.readOnly === true || tool?.function?.readOnly === true || tool?.annotations?.readOnlyHint === true;
    });
  }
  authorizeTool(name, args = {}, toolDef = null, context = {}) {
    if (!this.isPlanMode()) return { ok: true };
    const markedReadOnly = toolDef?.readOnly === true || toolDef?.function?.readOnly === true || toolDef?.annotations?.readOnlyHint === true;
    if (!READ_ONLY_TOOLS.has(name) && !markedReadOnly) return { ok: false, code: 'PLAN_MODE_WRITE_BLOCKED', reason: `${name} is not available in plan mode` };
    if (name === 'bash') return validatePlanShellCommand(args.command, context);
    return { ok: true };
  }
}

module.exports = { PlanningModeController, PlanStore, ModePolicy, normalizePlan, READ_ONLY_TOOLS };
