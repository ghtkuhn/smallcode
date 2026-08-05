// SmallCode — Session Persistence
// Save/resume conversations across restarts
// Adapted from OpenCode's SQLite session store, simplified to JSON files
//
// Storage: .smallcode/sessions/
//   {id}.json — full session with messages, tokens, metadata

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redactValue } = require('../security/sanitize');

const SESSIONS_DIR = '.smallcode/sessions';
const MAX_SESSIONS = 50; // Keep last 50 sessions
// File mode 0o600: owner read/write only — sessions contain conversation
// history which can include path-traversal hints, project secrets that
// leaked through tool output, and user prompts.
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

class SessionStore {
  constructor(rootDir) {
    this.rootDir = rootDir || process.cwd();
    this.sessionsDir = path.join(this.rootDir, SESSIONS_DIR);
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true, mode: DIR_MODE });
    } else {
      // Tighten perms on existing dir (best-effort, ignored on Windows)
      try { fs.chmodSync(this.sessionsDir, DIR_MODE); } catch {}
    }
    this.current = null;
  }

  // Create a new session
  create(model) {
    const id = this._generateId();
    const session = {
      id,
      title: '',
      model,
      messages: [],
      tokens: { input: 0, output: 0, total: 0 },
      cost: 0,
      toolCalls: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.current = session;
    this._save(session);
    return session;
  }

  // Resume the most recent session
  resume() {
    const sessions = this.list();
    if (sessions.length === 0) return null;
    const latest = sessions[0]; // Already sorted newest first
    return this.load(latest.id);
  }

  // Load a specific session
  load(id) {
    // Validate ID shape — only allow time-descending hex IDs we generate.
    // Prevents path traversal via '../foo' or absolute paths.
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      return null;
    }
    // Try exact match first
    const filePath = path.join(this.sessionsDir, `${id}.json`);
    // Containment guard — reject any resolved path that escapes the sessions dir.
    if (!filePath.startsWith(this.sessionsDir + path.sep)) return null;
    if (fs.existsSync(filePath)) {
      try {
        const session = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        this.current = session;
        return session;
      } catch { return null; }
    }
    // Try partial ID match (user may type short prefix from /sessions list)
    try {
      const files = fs.readdirSync(this.sessionsDir).filter(f => f.startsWith(id) && f.endsWith('.json'));
      if (files.length === 1) {
        const session = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, files[0]), 'utf-8'));
        this.current = session;
        return session;
      }
    } catch {}
    return null;
  }

  // Save current session state
  save(messages, metadata = {}) {
    if (!this.current) return;
    this.current.messages = messages;
    this.current.updatedAt = new Date().toISOString();
    if (metadata.tokens) this.current.tokens = metadata.tokens;
    if (metadata.cost) this.current.cost = metadata.cost;
    if (metadata.toolCalls) this.current.toolCalls = metadata.toolCalls;
    if (metadata.title) this.current.title = metadata.title;
    this._save(this.current);
  }

  // Auto-title from first user message
  autoTitle(messages) {
    if (this.current && !this.current.title) {
      const firstUser = messages.find(m => m.role === 'user');
      if (firstUser) {
        this.current.title = firstUser.content.slice(0, 60).replace(/\n/g, ' ');
        this._save(this.current);
      }
    }
  }

  // List all sessions (newest first)
  list() {
    try {
      const files = fs.readdirSync(this.sessionsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, f), 'utf-8'));
            return { id: data.id, title: data.title, model: data.model, updatedAt: data.updatedAt, msgs: data.messages?.length || 0 };
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      return files;
    } catch {
      return [];
    }
  }

  // Delete a session
  remove(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return false;
    const filePath = path.join(this.sessionsDir, `${id}.json`);
    if (!filePath.startsWith(this.sessionsDir + path.sep)) return false;
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  }

  // Prune old sessions beyond MAX_SESSIONS
  prune() {
    const sessions = this.list();
    if (sessions.length <= MAX_SESSIONS) return 0;
    const toRemove = sessions.slice(MAX_SESSIONS);
    for (const s of toRemove) this.remove(s.id);
    return toRemove.length;
  }

  // Record token usage for current session
  addUsage(inputTokens, outputTokens) {
    if (!this.current) return;
    this.current.tokens.input += inputTokens || 0;
    this.current.tokens.output += outputTokens || 0;
    this.current.tokens.total = this.current.tokens.input + this.current.tokens.output;
  }

  _save(session) {
    const filePath = path.join(this.sessionsDir, `${session.id}.json`);
    // Redact secrets that may have leaked into messages or tool output before
    // writing to disk. The redaction is one-way: stored sessions never carry
    // raw API keys, bearer tokens, or env-style secret assignments.
    const redacted = redactValue(session);
    // Atomic write: write to a temp file then rename. Prevents reading a
    // half-written session if the process crashes mid-save.
    const tmpPath = filePath + `.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(redacted, null, 2), { mode: FILE_MODE });
    fs.renameSync(tmpPath, filePath);
    try { fs.chmodSync(filePath, FILE_MODE); } catch {}
  }

  _generateId() {
    // Time-descending ID so newest sorts first lexicographically.
    // Use a wider epoch offset (good until year 2255) to avoid the overflow
    // that the old (9999999999999 - Date.now()) formula would hit in 2033.
    const MAX_TS = 9007199254740991; // Number.MAX_SAFE_INTEGER
    const time = (MAX_TS - Date.now()).toString(36).padStart(11, '0');
    const rand = crypto.randomBytes(3).toString('hex');
    return `${time}-${rand}`;
  }
}

module.exports = { SessionStore };
