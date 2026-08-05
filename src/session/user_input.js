'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_QUESTIONS = 3;
const MAX_ROUNDS = 3;
const CUSTOM_VALUE = '__custom__';

function requestId() { return `question-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`; }

function normalizeRequest(input, meta = {}) {
  if (!input || !Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > MAX_QUESTIONS) return { ok: false, error: 'questions must contain 1 to 3 entries' };
  const seen = new Set();
  const questions = [];
  for (const raw of input.questions) {
    const id = String(raw?.id || '').trim();
    const header = String(raw?.header || '').trim();
    const question = String(raw?.question || '').trim();
    const options = Array.isArray(raw?.options) ? raw.options : [];
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(id) || seen.has(id)) return { ok: false, error: `invalid or duplicate question id: ${id || '(missing)'}` };
    if (!header || header.length > 40 || !question || options.length < 2 || options.length > 3) return { ok: false, error: `question ${id} requires a header, prompt, and 2 to 3 options` };
    const normalizedOptions = options.map(option => ({ label: String(option?.label || '').trim(), description: String(option?.description || '').trim() }));
    if (normalizedOptions.some(option => !option.label || !option.description)) return { ok: false, error: `question ${id} has an incomplete option` };
    seen.add(id); questions.push({ id, header, question, options: normalizedOptions });
  }
  return { ok: true, request: { id: input.id || requestId(), questions, status: 'pending', answers: {}, planId: meta.planId || null, planRevision: meta.planRevision || 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), continuation: meta.continuation || null } };
}

class QuestionStore {
  constructor(options = {}) {
    const root = path.resolve(options.workspaceRoot || process.cwd());
    const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
    this.dir = options.dir || path.join(os.homedir(), '.cache', 'smallcode', 'questions', hash);
    this.limit = options.limit || 50;
  }
  save(request) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    request.updatedAt = new Date().toISOString();
    const target = path.join(this.dir, `${request.id}.json`); const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(request, null, 2), { mode: 0o600 }); fs.renameSync(temp, target);
    const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json')).map(f => ({ f, t: fs.statSync(path.join(this.dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const old of files.slice(this.limit)) fs.unlinkSync(path.join(this.dir, old.f));
    return request;
  }
  load(id) { if (typeof id !== 'string' || !/^question-[A-Za-z0-9-]{1,80}$/.test(id)) return null; try { return JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8')); } catch { return null; } }
  list() { try { return fs.readdirSync(this.dir).filter(f => f.endsWith('.json')).map(f => this.load(f.slice(0, -5))).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); } catch { return []; } }
  listPending() { return this.list().filter(r => ['pending', 'answering', 'paused'].includes(r.status)); }
  remove(id) { const request = this.load(id); if (!request) return false; try { fs.unlinkSync(path.join(this.dir, `${id}.json`)); return true; } catch { return false; } }
}

function normalizeAnswers(request, answers) {
  const out = {};
  for (const question of request.questions) {
    const raw = answers?.[question.id];
    const value = typeof raw === 'object' ? raw.value : raw;
    if (typeof value !== 'string' || !value.trim()) return { ok: false, error: `missing answer for ${question.id}` };
    const match = question.options.find(option => option.label === value);
    out[question.id] = { value: value.trim(), custom: typeof raw === 'object' ? raw.custom === true : !match };
  }
  return { ok: true, answers: out };
}

class UserInputBroker {
  constructor(options = {}) { this.store = options.store || new QuestionStore(options); this.interact = options.interact || null; this.rounds = new Map(); }
  async request(input, meta = {}) {
    const key = `${meta.planId || 'none'}:${meta.planRevision || 0}`;
    const persistedRounds = this.store.list().filter(request => `${request.planId || 'none'}:${request.planRevision || 0}` === key).length;
    const rounds = Math.max(this.rounds.get(key) || 0, persistedRounds) + 1;
    if (rounds > MAX_ROUNDS) return { ok: false, error: `maximum ${MAX_ROUNDS} question rounds reached; state assumptions and submit the plan` };
    const normalized = normalizeRequest(input, meta); if (!normalized.ok) return normalized;
    this.rounds.set(key, rounds); const request = this.store.save(normalized.request);
    if (!this.interact) return { ok: true, pending: true, request };
    request.status = 'answering'; this.store.save(request);
    const answers = await this.interact(request);
    if (!answers) { request.status = 'paused'; this.store.save(request); return { ok: true, pending: true, paused: true, request }; }
    return this.answer(request.id, answers);
  }
  answer(id, answers) { const request = this.store.load(id); if (!request) return { ok: false, error: `question request not found: ${id}` }; const normalized = normalizeAnswers(request, answers); if (!normalized.ok) return normalized; request.answers = normalized.answers; request.status = 'answered'; this.store.save(request); return { ok: true, request, answers: normalized.answers }; }
  pause(id) { const request = this.store.load(id); if (!request) return false; request.status = 'paused'; this.store.save(request); return true; }
  cancel(id) { const request = this.store.load(id); if (!request) return false; request.status = 'cancelled'; this.store.save(request); return true; }
  discard(id) { return this.store.remove(id); }
  discardAll() { for (const request of this.store.listPending()) this.store.remove(request.id); }
}

module.exports = { UserInputBroker, QuestionStore, normalizeRequest, normalizeAnswers, MAX_QUESTIONS, MAX_ROUNDS, CUSTOM_VALUE };
