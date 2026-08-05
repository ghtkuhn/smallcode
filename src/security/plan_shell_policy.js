'use strict';

const SAFE = new Set(['pwd', 'ls', 'tree', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'rg', 'grep', 'find', 'git', 'sort', 'uniq', 'cut', 'tr', 'sed', 'jq']);
const GIT_SAFE = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'grep']);

function reject(reason) { return { ok: false, code: 'PLAN_MODE_SHELL_BLOCKED', reason }; }

function inspectAndSplit(command) {
  const segments = [];
  let current = '', quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote && command[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if ('><`$\n\r'.includes(ch)) return { error: 'Redirection or dynamic shell expansion is not allowed in plan mode' };
    if (ch === '&' && command[i + 1] !== '&') return { error: 'Background shell jobs are not allowed in plan mode' };
    if (ch === ';' || ch === '|' || (ch === '&' && command[i + 1] === '&')) {
      if (ch === '|' && command[i + 1] === '|') i++;
      else if (ch === '&') i++;
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote) return { error: 'Unterminated shell quote' };
  if (current.trim()) segments.push(current.trim());
  return { segments };
}

function validatePlanShellCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return reject('Shell command is missing');
  const inspected = inspectAndSplit(command);
  if (inspected.error) return reject(inspected.error);
  if (/\b(?:sudo|env|xargs|tee|sh|bash|zsh|fish|node|python\d*|ruby|perl|awk)\b/.test(command)) return reject('Interpreters and commands with write-capable evaluation are not allowed in plan mode');
  const segments = inspected.segments;
  if (!segments.length) return reject('No command found');
  for (const segment of segments) {
    const words = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    const program = (words[0] || '').replace(/^.*\//, '');
    if (!SAFE.has(program)) return reject(`Command '${program || segment}' is not on the plan-mode read-only allowlist`);
    if (program === 'find' && words.some(w => /^-(delete|exec|execdir|ok|okdir|fls|fprint0?|fprintf)$/.test(w))) return reject('Mutating find actions are not allowed');
    if (program === 'tree' && words.some(w => w === '-o' || w.startsWith('--output'))) return reject('tree output files are not allowed');
    if (program === 'sort' && words.some(w => w === '-o' || w.startsWith('--output'))) return reject('sort output files are not allowed');
    if (program === 'sed' && words.some(w => /^-.*i/.test(w) || w === '--in-place' || w.startsWith('--in-place='))) return reject('in-place sed is not allowed');
    if (program === 'uniq' && words.slice(1).filter(w => !w.startsWith('-')).length > 1) return reject('uniq output-file operands are not allowed');
    if (program === 'git') {
      const sub = words.slice(1).find(w => !w.startsWith('-'));
      if (!sub || !GIT_SAFE.has(sub)) return reject(`git ${sub || '(missing subcommand)'} is not read-only`);
      if (words.some(w => /^--output(?:=|$)/.test(w))) return reject('git output files are not allowed');
    }
  }
  return { ok: true, operations: segments.map(s => s.split(/\s+/)[0]) };
}

module.exports = { validatePlanShellCommand };
