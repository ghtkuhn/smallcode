'use strict';

class AgentRunController {
  constructor(onChange) { this.onChange = onChange || (() => {}); this.active = null; this.nextId = 1; }
  begin(meta = {}) {
    if (this.active) this.cancel('superseded');
    this.active = { id: this.nextId++, controller: new AbortController(), startedAt: Date.now(), phase: 'thinking', abortables: new Set(), meta };
    this._emit(); return this.active;
  }
  get signal() { return this.active?.controller.signal || null; }
  setPhase(phase) { if (this.active) { this.active.phase = phase; this._emit(); } }
  registerAbortable(fn) { if (!this.active || typeof fn !== 'function') return () => {}; this.active.abortables.add(fn); return () => this.active?.abortables.delete(fn); }
  cancel(reason = 'cancelled') {
    if (!this.active) return false;
    this.active.phase = 'cancelling'; this._emit();
    try { this.active.controller.abort(reason); } catch {}
    for (const abort of this.active.abortables) { try { abort(reason); } catch {} }
    return true;
  }
  finish() { this.active = null; this._emit(); }
  snapshot() { return this.active ? { active: true, id: this.active.id, phase: this.active.phase, elapsedMs: Date.now() - this.active.startedAt, meta: this.active.meta } : { active: false, phase: 'idle', elapsedMs: 0 }; }
  _emit() { this.onChange(this.snapshot()); }
}

module.exports = { AgentRunController };
