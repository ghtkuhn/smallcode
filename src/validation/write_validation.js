'use strict';

const path = require('path');
const { spawn } = require('child_process');
const babelParser = require('@babel/parser');
const YAML = require('yaml');
const csstree = require('css-tree');
const { parser: pythonParser } = require('@lezer/python');

const REQUIRED_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.yaml', '.yml', '.css', '.json', '.ini']);

function positionFromOffset(content, offset) {
  const safe = Math.max(0, Math.min(content.length, Number(offset) || 0));
  const prefix = content.slice(0, safe);
  const lines = prefix.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function diagnostic(message, location = {}, code = 'SYNTAX_ERROR') {
  return {
    message: String(message || 'Syntax error').replace(/\s+/g, ' ').trim().slice(0, 500),
    line: Number(location.line) || 1,
    column: Number(location.column ?? location.col) || 1,
    code,
  };
}

function validateBabel(content, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const plugins = ['decorators-legacy'];
  if (ext === '.jsx' || ext === '.tsx') plugins.push('jsx');
  if (ext === '.ts' || ext === '.tsx' || filePath.toLowerCase().endsWith('.d.ts')) {
    plugins.push(['typescript', { dts: filePath.toLowerCase().endsWith('.d.ts') }]);
  }
  try {
    babelParser.parse(content, { sourceType: 'unambiguous', plugins, errorRecovery: false, allowAwaitOutsideFunction: true });
    return [];
  } catch (error) {
    const location = error.loc ? { line: error.loc.line, column: error.loc.column + 1 } : {};
    return [diagnostic(error.reasonCode ? `${error.reasonCode}: ${error.message}` : error.message, location, error.reasonCode || 'BABEL_PARSE_ERROR')];
  }
}

function validateYaml(content) {
  const lineCounter = new YAML.LineCounter();
  const documents = YAML.parseAllDocuments(content, { lineCounter, prettyErrors: false });
  return documents.flatMap(document => document.errors).slice(0, 5).map(error => {
    const pos = Array.isArray(error.pos) ? error.pos[0] : 0;
    return diagnostic(error.message, lineCounter.linePos(pos), error.code || 'YAML_PARSE_ERROR');
  });
}

function validateCss(content) {
  const recoverable = [];
  try {
    csstree.parse(content, {
      context: 'stylesheet',
      positions: true,
      filename: 'candidate.css',
      onParseError: error => recoverable.push(diagnostic(error.message, { line: error.line, column: error.column }, error.name || 'CSS_PARSE_ERROR')),
    });
  } catch (error) {
    return [diagnostic(error.message, { line: error.line, column: error.column }, error.name || 'CSS_PARSE_ERROR')];
  }
  if (recoverable.length) return recoverable.slice(0, 5);
  const stack = [];
  let quote = null;
  let comment = false;
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    const next = content[index + 1];
    if (comment) { if (char === '*' && next === '/') { comment = false; index++; } continue; }
    if (quote) { if (char === '\\') { index++; continue; } if (char === quote) quote = null; continue; }
    if (char === '/' && next === '*') { comment = true; index++; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '{' || char === '(' || char === '[') stack.push({ char, index });
    if (char === '}' || char === ')' || char === ']') {
      const expected = { '}': '{', ')': '(', ']': '[' }[char];
      const open = stack.pop();
      if (!open || open.char !== expected) return [diagnostic(`Unexpected ${char}`, positionFromOffset(content, index), 'CSS_UNBALANCED_DELIMITER')];
    }
  }
  if (comment) return [diagnostic('Unterminated CSS comment', positionFromOffset(content, content.length), 'CSS_UNTERMINATED_COMMENT')];
  if (quote) return [diagnostic('Unterminated CSS string', positionFromOffset(content, content.length), 'CSS_UNTERMINATED_STRING')];
  if (stack.length) return [diagnostic(`Unclosed ${stack[stack.length - 1].char}`, positionFromOffset(content, stack[stack.length - 1].index), 'CSS_UNBALANCED_DELIMITER')];
  return [];
}

function validateJson(content) {
  try {
    JSON.parse(content);
    return [];
  } catch (error) {
    const match = String(error.message).match(/position\s+(\d+)/i);
    const location = match ? positionFromOffset(content, Number(match[1])) : { line: 1, column: 1 };
    return [diagnostic(error.message, location, 'JSON_PARSE_ERROR')];
  }
}

function validateIni(content) {
  const diagnostics = [];
  let canContinue = false;
  const lines = String(content).replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length && diagnostics.length < 5; index++) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[')) {
      canContinue = false;
      if (!/^\[[^\]\r\n]+\](?:\s*[;#].*)?$/.test(trimmed)) {
        diagnostics.push(diagnostic('Malformed INI section header', { line: index + 1, column: 1 }, 'INI_SECTION_ERROR'));
      }
      continue;
    }
    const separator = raw.search(/[=:]/);
    if (/^\s/.test(raw) && separator < 0) {
      if (!canContinue) diagnostics.push(diagnostic('Continuation line has no preceding key', { line: index + 1, column: 1 }, 'INI_ORPHAN_CONTINUATION'));
      continue;
    }
    canContinue = false;
    if (separator <= 0 || !raw.slice(0, separator).trim()) {
      diagnostics.push(diagnostic('INI entry must contain a non-empty key followed by = or :', { line: index + 1, column: 1 }, 'INI_ENTRY_ERROR'));
      continue;
    }
    canContinue = true;
  }
  return diagnostics;
}

function validatePythonWithLezer(content) {
  const tree = pythonParser.parse(content);
  const cursor = tree.cursor();
  const diagnostics = [];
  do {
    if (cursor.type.isError) {
      const location = positionFromOffset(content, cursor.from);
      diagnostics.push(diagnostic('Invalid Python syntax', location, 'PYTHON_PARSE_ERROR'));
      if (diagnostics.length >= 5) break;
    }
  } while (cursor.next());
  return diagnostics;
}

function validatePythonWithCPython(content, filePath, signal, timeoutMs = 3000) {
  return new Promise(resolve => {
    const script = 'import sys; source=sys.stdin.read(); compile(source, sys.argv[1], "exec")';
    let stderr = '';
    let settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const child = spawn('python3', ['-c', script, filePath], { stdio: ['pipe', 'ignore', 'pipe'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(null); }, timeoutMs);
    const abort = () => { child.kill('SIGKILL'); finish({ aborted: true, diagnostics: [] }); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', chunk => { if (stderr.length < 4000) stderr += chunk; });
    child.on('error', () => finish(null));
    child.on('exit', code => {
      signal?.removeEventListener('abort', abort);
      if (code === 0) return finish({ diagnostics: [] });
      const lineMatch = stderr.match(/line\s+(\d+)/i);
      const caretLine = stderr.split('\n').find(line => line.includes('^')) || '';
      const message = stderr.trim().split('\n').filter(Boolean).slice(-1)[0] || 'Invalid Python syntax';
      finish({ diagnostics: [diagnostic(message, { line: Number(lineMatch?.[1]) || 1, column: Math.max(1, caretLine.indexOf('^') + 1) }, 'PYTHON_COMPILE_ERROR')] });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(content);
  });
}

class WriteValidationRegistry {
  constructor(options = {}) {
    this.validators = [];
    this.disablePythonProcess = options.disablePythonProcess || false;
    this._registerCore();
  }

  _registerCore() {
    this.register({ name: 'babel', owner: 'core', extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'], validate: ({ content, filePath }) => validateBabel(content, filePath) });
    this.register({ name: 'yaml', owner: 'core', extensions: ['.yaml', '.yml'], validate: ({ content }) => validateYaml(content) });
    this.register({ name: 'css-tree', owner: 'core', extensions: ['.css'], validate: ({ content }) => validateCss(content) });
    this.register({ name: 'json', owner: 'core', extensions: ['.json'], validate: ({ content }) => validateJson(content) });
    this.register({ name: 'ini', owner: 'core', extensions: ['.ini'], validate: ({ content }) => validateIni(content) });
    this.register({ name: 'python', owner: 'core', extensions: ['.py'], validate: async ({ content, filePath, signal }) => {
      if (!this.disablePythonProcess) {
        const result = await validatePythonWithCPython(content, filePath, signal);
        if (result) return result;
      }
      return validatePythonWithLezer(content);
    } });
  }

  register(spec) {
    if (!spec || typeof spec.name !== 'string' || typeof spec.validate !== 'function') throw new TypeError('Validator requires name and validate()');
    const extensions = (spec.extensions || []).map(ext => ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`);
    if (!extensions.length && typeof spec.match !== 'function') throw new TypeError(`Validator "${spec.name}" requires extensions or match()`);
    const entry = { ...spec, extensions, owner: spec.owner || 'anonymous', priority: Number(spec.priority) || 0 };
    this.validators.push(entry);
    this.validators.sort((a, b) => b.priority - a.priority);
    return () => { const index = this.validators.indexOf(entry); if (index >= 0) this.validators.splice(index, 1); };
  }

  unregisterOwner(owner) {
    const before = this.validators.length;
    this.validators = this.validators.filter(validator => validator.owner === 'core' || validator.owner !== owner);
    return before - this.validators.length;
  }

  list() {
    return this.validators.map(({ name, owner, extensions, priority }) => ({ name, owner, extensions: [...extensions], priority }));
  }

  async validateCandidate(candidate, options = {}) {
    if (process.env.SMALLCODE_PREWRITE_VALIDATION === 'false') return { status: 'skip', diagnostics: [], validators: [], reason: 'disabled' };
    const filePath = candidate.filePath;
    const ext = path.extname(filePath).toLowerCase();
    const matching = this.validators.filter(v => v.extensions.includes(ext) || v.match?.(filePath));
    if (!matching.length) return { status: 'skip', diagnostics: [], validators: [], reason: 'unsupported' };
    const diagnostics = [];
    const used = [];
    for (const validator of matching) {
      if (options.signal?.aborted) return { status: 'fail', aborted: true, diagnostics: [], validators: used };
      used.push(validator.name);
      try {
        const timeoutMs = Number(validator.timeoutMs || options.timeoutMs) || 3000;
        let timer;
        const raw = await Promise.race([
          Promise.resolve(validator.validate({ ...candidate, signal: options.signal })),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs); }),
        ]).finally(() => clearTimeout(timer));
        if (raw?.aborted) return { status: 'fail', aborted: true, diagnostics: [], validators: used };
        const items = Array.isArray(raw) ? raw : (raw?.diagnostics || []);
        for (const item of items.slice(0, 5 - diagnostics.length)) diagnostics.push({ validator: validator.name, ...diagnostic(item.message, item, item.code) });
      } catch (error) {
        diagnostics.push({ validator: validator.name, ...diagnostic(`Validator failed: ${error.message}`, {}, 'VALIDATOR_ERROR') });
      }
      if (diagnostics.length >= 5) break;
    }
    return { status: diagnostics.length ? 'fail' : 'pass', diagnostics, validators: used, required: REQUIRED_EXTENSIONS.has(ext) };
  }
}

let singleton;
function getWriteValidationRegistry(options) {
  if (!singleton || options) singleton = new WriteValidationRegistry(options);
  return singleton;
}
function resetWriteValidationRegistry() { singleton = null; }

module.exports = {
  WriteValidationRegistry,
  getWriteValidationRegistry,
  resetWriteValidationRegistry,
  validateBabel,
  validateYaml,
  validateCss,
  validateJson,
  validateIni,
  validatePythonWithLezer,
  validatePythonWithCPython,
};
