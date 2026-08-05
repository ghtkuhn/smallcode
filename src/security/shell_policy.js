'use strict';

const fs = require('fs');
const path = require('path');

const DYNAMIC = /[`]|\$\(|\$\{|(?:^|[^\\])\$[A-Za-z_?*#@!-]|%[A-Za-z_][A-Za-z0-9_]*%|![A-Za-z_][A-Za-z0-9_]*!/;
const DESTRUCTIVE_COMMANDS = new Set(['rm', 'rmdir', 'unlink', 'del', 'erase', 'rd', 'mv', 'cp', 'install', 'truncate', 'shred', 'tee', 'dd']);

function canonicalExistingAncestor(candidate, pathApi = path) {
  let probe = pathApi.resolve(candidate);
  if (pathApi !== path) return probe;
  const tail = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    tail.unshift(path.basename(probe));
    probe = parent;
  }
  let real = probe;
  try { real = fs.realpathSync.native(probe); } catch { real = path.resolve(probe); }
  return path.join(real, ...tail);
}

function isInside(root, candidate, allowRoot = true, pathApi = path) {
  const rel = pathApi.relative(root, candidate);
  if (rel === '') return allowRoot;
  return !rel.startsWith('..') && !pathApi.isAbsolute(rel);
}

function tokenize(command, platform) {
  const out = [];
  let word = '';
  let quote = null;
  const push = () => { if (word) { out.push(word); word = ''; } };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '\\' && i + 1 < command.length) {
      if (platform === 'win32') word += ch;
      else word += command[++i];
      continue;
    }
    if (/\s/.test(ch)) { push(); continue; }
    if (';&|<>'.includes(ch)) {
      push();
      let op = ch;
      if (command[i + 1] === ch || (ch === '>' && command[i + 1] === '|')) op += command[++i];
      out.push(op);
      continue;
    }
    word += ch;
  }
  if (quote) return { error: 'unclosed quote' };
  push();
  return { tokens: out };
}

function reject(code, reason, root, target) {
  const result = { ok: false, code, reason, workspaceRoot: root };
  if (target !== undefined) result.target = target;
  return result;
}

function validateTarget(raw, state, operation, allowRoot = true) {
  if (!raw || /^-/.test(raw)) return null;
  if (DYNAMIC.test(raw)) return reject('DYNAMIC_TARGET', `cannot safely resolve dynamic target for ${operation}`, state.root, raw);

  const wildcard = raw.search(/[*?[]/);
  const staticPart = wildcard >= 0 ? raw.slice(0, wildcard) : raw;
  const baseCandidate = state.pathApi.isAbsolute(staticPart)
    ? staticPart
    : state.pathApi.resolve(state.cwd, staticPart || '.');
  const resolved = canonicalExistingAncestor(baseCandidate, state.pathApi);
  if (!allowRoot && state.pathApi.resolve(resolved) === state.root && wildcard < 0) {
    return reject('WORKSPACE_ROOT', `${operation} may not target the project workspace root`, state.root, raw);
  }
  // A wildcard rooted at the workspace denotes its children, not the root
  // directory itself (`rm ./*`). The static prefix must still be contained.
  if (!isInside(state.root, resolved, allowRoot || wildcard >= 0, state.pathApi)) {
    return reject('OUTSIDE_WORKSPACE', `${operation} target resolves outside project workspace`, state.root, raw);
  }
  return null;
}

function commandSegments(tokens) {
  const segments = [];
  let current = [];
  for (const token of tokens) {
    if (token === ';' || token === '&&' || token === '||' || token === '|') {
      if (current.length) segments.push(current);
      current = [];
    } else current.push(token);
  }
  if (current.length) segments.push(current);
  return segments;
}

function executableName(words) {
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word === 'sudo' || word === 'command' || word === 'env') { i++; continue; }
    if (word.startsWith('-')) { i++; continue; }
    return path.basename(word).toLowerCase();
  }
  return '';
}

function hasDestructiveSyntax(tokens) {
  for (const words of commandSegments(tokens)) {
    if (words.some(w => w === '>' || w === '>|' || w === '>>')) return true;
    const cmd = executableName(words);
    if (DESTRUCTIVE_COMMANDS.has(cmd)) return true;
    if (cmd === 'find' && words.includes('-delete')) return true;
    if (cmd === 'git' && (words.includes('clean') || words.includes('rm'))) return true;
    if (cmd === 'xargs' && words.some(w => ['rm', 'rmdir', 'unlink'].includes(path.basename(w).toLowerCase()))) return true;
  }
  return false;
}

function validateShellCommand(command, options = {}) {
  if (typeof command !== 'string' || !command.trim()) return { ok: false, code: 'INVALID_COMMAND', reason: 'command must be a non-empty string' };
  const pathApi = options.platform === 'win32' ? path.win32 : path;
  const rootInput = options.workspaceRoot || options.cwd || process.cwd();
  const root = canonicalExistingAncestor(rootInput, pathApi);
  const cwd = canonicalExistingAncestor(options.cwd || root, pathApi);
  if (!isInside(root, cwd, true, pathApi)) return reject('OUTSIDE_WORKSPACE', 'shell cwd is outside project workspace', root, cwd);

  const parsed = tokenize(command, options.platform);
  if (parsed.error) return reject('INVALID_SYNTAX', parsed.error, root);
  const destructive = hasDestructiveSyntax(parsed.tokens);
  if (destructive && DYNAMIC.test(command)) return reject('DYNAMIC_COMMAND', 'dynamic shell expansion is not allowed in destructive commands', root);
  if (destructive && /[()]/.test(command)) return reject('AMBIGUOUS_SUBSHELL', 'subshells are not allowed in destructive commands', root);

  const state = { root, cwd, pathApi };
  const isOption = word => word.startsWith('-') || (options.platform === 'win32' && /^\/[A-Za-z]+$/.test(word));
  const operations = [];
  let nextCwd = cwd;
  for (const words of commandSegments(parsed.tokens)) {
    if (!words.length) continue;
    const cmd = executableName(words);
    if (cmd === 'cd' || cmd === 'pushd' || cmd === 'chdir') {
      if (words.length !== 2) {
        if (destructive) return reject('AMBIGUOUS_CWD', 'complex directory changes are not allowed with destructive commands', root);
        continue;
      }
      const target = canonicalExistingAncestor(pathApi.isAbsolute(words[1]) ? words[1] : pathApi.resolve(nextCwd, words[1]), pathApi);
      if (!isInside(root, target, true, pathApi)) return reject('OUTSIDE_WORKSPACE', 'directory change would leave project workspace', root, words[1]);
      nextCwd = target;
      state.cwd = target;
      operations.push({ type: 'cwd', target });
      continue;
    }

    let targets = [];
    let allowRoot = true;
    let op = null;
    const destructiveExecutable = DESTRUCTIVE_COMMANDS.has(cmd)
      || (cmd === 'find' && words.includes('-delete'))
      || (cmd === 'git' && (words.includes('clean') || words.includes('rm')))
      || cmd === 'xargs';
    if (destructiveExecutable && cmd && path.basename(words[0]).toLowerCase() !== cmd) {
      return reject('AMBIGUOUS_DESTRUCTIVE_COMMAND', 'wrapped destructive commands are not allowed because their targets cannot be determined safely', root);
    }
    if (['rm', 'rmdir', 'unlink', 'del', 'erase', 'rd'].includes(cmd)) {
      op = cmd; allowRoot = false; targets = words.slice(1).filter(w => !isOption(w));
    } else if (cmd === 'find' && words.includes('-delete')) {
      op = 'find -delete'; allowRoot = false;
      const idx = words.findIndex(w => w.startsWith('-'));
      targets = words.slice(1, idx < 0 ? words.length : idx);
    } else if (cmd === 'git' && words.includes('clean')) {
      op = 'git clean'; allowRoot = false;
      const c = words.indexOf('-C');
      targets = c >= 0 && words[c + 1] ? [words[c + 1]] : ['.'];
      for (const word of words) {
        if (/^-C.+/.test(word)) targets.push(word.slice(2));
        if (/^--(?:work-tree|git-dir)=/.test(word)) targets.push(word.slice(word.indexOf('=') + 1));
      }
      allowRoot = true;
    } else if (cmd === 'git' && words.includes('rm')) {
      op = 'git rm'; allowRoot = true;
      const rmIndex = words.indexOf('rm');
      targets = words.slice(rmIndex + 1).filter(w => !isOption(w));
    } else if (['mv', 'cp', 'install'].includes(cmd)) {
      op = cmd;
      const operands = words.filter((w, i) => i > 0 && !isOption(w));
      targets = cmd === 'mv' ? operands : operands.slice(-1);
      for (let i = 1; i < words.length; i++) {
        if ((words[i] === '-t' || words[i] === '--target-directory') && words[i + 1]) targets.push(words[i + 1]);
        if (words[i].startsWith('--target-directory=')) targets.push(words[i].slice(words[i].indexOf('=') + 1));
      }
    } else if (cmd === 'truncate') {
      op = cmd; targets = words.filter((w, i) => i > 0 && !isOption(w) && !/^\d+$/.test(w));
    } else if (cmd === 'shred' || cmd === 'tee') {
      op = cmd; targets = words.filter((w, i) => i > 0 && !isOption(w));
    } else if (cmd === 'dd') {
      op = cmd; targets = words.filter(w => /^of=/.test(w)).map(w => w.slice(3));
    }
    if (op) {
      if (!targets.length) return reject('AMBIGUOUS_TARGET', `cannot determine target for ${op}`, root);
      for (const target of targets) {
        const failure = validateTarget(target, state, op, allowRoot);
        if (failure) return failure;
        operations.push({ type: op, target });
      }
    }

    for (let i = 0; i < words.length - 1; i++) {
      if (words[i] === '>' || words[i] === '>|' || words[i] === '>>') {
        const target = words[i + 1];
        const failure = validateTarget(target, state, 'redirection', true);
        if (failure) return failure;
        operations.push({ type: 'redirection', target });
      }
    }
  }
  if (destructive && operations.length === 0) {
    return reject('AMBIGUOUS_DESTRUCTIVE_COMMAND', 'destructive syntax is present but its targets cannot be determined safely', root);
  }
  return { ok: true, operations, nextCwd };
}

module.exports = { validateShellCommand };
