// SmallCode — Skill System
// Skills are reusable prompt templates that teach the model specific behaviors.
// They're simpler than plugins — just markdown files with optional YAML frontmatter.
//
// Compiled from: src/plugins/skills.ms (port-mirror)
//
// Skill discovery layers (later overrides earlier):
//   <package>/skills/                    — bundled defaults
//   ~/.smallcode/skills/                 — user-level
//   ~/.config/smallcode/skills/          — XDG-style user config
//   <project>/.smallcode/skills/         — project (highest precedence)
//   <project>/.agents/skills/<name>/SKILL.md  — itsy/jukefr layout (closes #53)
//   <project>/.claude/skills/<name>/SKILL.md  — Claude Code layout (closes #53)
//
// Skills with YAML frontmatter behave as before. Skills loaded from
// `.agents/skills` or `.claude/skills` typically have no frontmatter — they
// are treated as `manual`-trigger skills named after their parent directory.
//
// Frontmatter accepts both LF and CRLF line endings (closes #52).

const fs = require('fs');
const path = require('path');
const os = require('os');

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
const KV_RE = /^(\w+)\s*:\s*(.+?)\s*$/;

class SkillManager {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
    this.skills = new Map(); // name → skill object
    this._load();
  }

  _getSkillDirs() {
    // Order matters: later entries override earlier ones (highest precedence
    // last). Project-level skills always win over user-level / bundled.
    return [
      // bundled defaults shipped with smallcode itself
      path.join(__dirname, '..', '..', 'skills'),
      // user-level
      path.join(os.homedir(), '.smallcode', 'skills'),
      path.join(os.homedir(), '.config', 'smallcode', 'skills'),
      // project-level
      path.join(this.projectDir, '.smallcode', 'skills'),
    ];
  }

  // Nested skill directories that follow the `<dir>/<name>/SKILL.md` layout.
  // `.agents/skills/` is the itsy/jukefr convention; `.claude/skills/` is
  // Claude Code's. Both are auto-detected when present in the project root.
  _getNestedSkillRoots() {
    return [
      path.join(this.projectDir, '.agents', 'skills'),
      path.join(this.projectDir, '.claude', 'skills'),
    ];
  }

  _load() {
    // Flat layout: <dir>/<name>.md
    for (const dir of this._getSkillDirs()) {
      this._loadFlat(dir);
    }
    // Nested layout: <root>/<name>/SKILL.md (case-insensitive)
    for (const root of this._getNestedSkillRoots()) {
      this._loadNested(root);
    }
  }

  _loadFlat(dir) {
    if (!dir || !fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const full = path.join(dir, entry);
      this._ingestFile(full, entry, dir);
    }
  }

  _loadNested(root) {
    if (!root || !fs.existsSync(root)) return;
    let dirs;
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const skillDir = path.join(root, d.name);
      // Look for SKILL.md, skill.md, or any .md file inside the folder.
      let skillFile = null;
      const candidates = ['SKILL.md', 'skill.md', 'Skill.md'];
      for (const c of candidates) {
        const p = path.join(skillDir, c);
        if (fs.existsSync(p)) { skillFile = p; break; }
      }
      if (!skillFile) {
        // Fall back to first .md in the folder
        try {
          const md = fs.readdirSync(skillDir).find(f => f.endsWith('.md'));
          if (md) skillFile = path.join(skillDir, md);
        } catch {}
      }
      if (!skillFile) continue;
      this._ingestFile(skillFile, path.basename(skillFile), skillDir, d.name);
    }
  }

  _ingestFile(filePath, filename, dir, defaultName) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return;
    }
    const skill = this._parse(content, filename, dir, defaultName);
    if (skill) this.skills.set(skill.name, skill);
  }

  _parse(content, filename, dir, defaultName) {
    // Parse YAML frontmatter (CRLF + LF tolerant — closes #52)
    const fmMatch = content.match(FM_RE);
    let frontmatter = '';
    let body = content;

    if (fmMatch) {
      frontmatter = fmMatch[1];
      body = fmMatch[2];
    } else if (!defaultName) {
      // Flat-layout files without frontmatter aren't skills (could be a
      // README). Nested-layout (.agents/skills/<name>/SKILL.md) files are
      // accepted as plain-body skills using the parent directory name.
      return null;
    }

    // Tiny YAML parser — no dep needed
    const meta = {};
    if (frontmatter) {
      for (const rawLine of frontmatter.split(/\r?\n/)) {
        const m = rawLine.match(KV_RE);
        if (!m) continue;
        let value = m[2].trim();
        if (value.startsWith('[') && value.endsWith(']')) {
          value = value.slice(1, -1).split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
        }
        meta[m[1]] = value;
      }
    }

    return {
      name: meta.name || defaultName || filename.replace(/\.md$/i, ''),
      trigger: meta.trigger || (defaultName ? 'manual' : 'manual'),
      keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
      content: body.trim(),
      path: path.join(dir, filename),
      origin: defaultName ? 'nested' : 'flat',
    };
  }

  // Get all skills
  list() {
    return [...this.skills.values()].map(s => ({
      name: s.name,
      trigger: s.trigger,
      keywords: s.keywords,
      preview: s.content.slice(0, 80) + (s.content.length > 80 ? '...' : ''),
      origin: s.origin || 'flat',
      path: s.path,
      scope: s.path.startsWith(this.projectDir) ? 'project'
        : s.path.startsWith(os.homedir()) ? 'user' : 'bundled',
    }));
  }

  reload() {
    const previous = this.skills;
    const next = new Map();
    this.skills = next;
    try {
      this._load();
      return { ok: true, skills: this.skills.size };
    } catch (error) {
      this.skills = previous;
      return { ok: false, error: error.message, skills: previous.size };
    }
  }

  // Get a skill by name
  get(name) {
    return this.skills.get(name) || null;
  }

  // Get skills that should auto-inject for a given message
  getAutoSkills(message) {
    const msg = (message || '').toLowerCase();
    const results = [];
    for (const skill of this.skills.values()) {
      if (skill.trigger === 'auto') {
        results.push(skill);
      } else if (skill.trigger === 'match' && skill.keywords.length > 0) {
        const match = skill.keywords.some(kw => msg.includes(String(kw).toLowerCase()));
        if (match) results.push(skill);
      }
    }
    return results;
  }

  // Create a new skill in the project's .smallcode/skills directory
  add(name, content, options = {}) {
    const dir = path.join(this.projectDir, '.smallcode', 'skills');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const trigger = options.trigger || 'manual';
    const keywords = options.keywords || [];

    const frontmatter = [
      '---',
      `name: ${name}`,
      `trigger: ${trigger}`,
      keywords.length ? `keywords: [${keywords.join(', ')}]` : null,
      '---',
    ].filter(Boolean).join('\n');

    const fullContent = `${frontmatter}\n${content}\n`;
    const filename = `${name.replace(/[^a-z0-9-_]/gi, '-')}.md`;
    const filePath = path.join(dir, filename);

    fs.writeFileSync(filePath, fullContent);

    const skill = {
      name,
      trigger,
      keywords,
      content,
      path: filePath,
      origin: 'flat',
    };
    this.skills.set(name, skill);
    return skill;
  }

  // Remove a skill
  remove(name) {
    const skill = this.skills.get(name);
    if (!skill) return false;
    if (fs.existsSync(skill.path)) {
      try { fs.unlinkSync(skill.path); } catch {}
    }
    this.skills.delete(name);
    return true;
  }

  // Format skills for system prompt injection
  formatForPrompt(skills) {
    if (skills.length === 0) return '';
    return '\n\nActive skills:\n' + skills.map(s => `[${s.name}] ${s.content}`).join('\n\n');
  }
}

module.exports = { SkillManager };
