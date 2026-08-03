'use strict';

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'vendor', 'dist', 'build', 'out', 'target',
  'coverage', '.next', '.nuxt', '.cache', '.pytest_cache', '__pycache__',
  '.venv', 'venv',
]);

const cache = new Map();
const CACHE_MS = 1000;
const MAX_COLLECT = 5000;
const MAX_DEPTH = 10;

function collectEntries(cwd) {
  const cached = cache.get(cwd);
  if (cached && Date.now() - cached.time < CACHE_MS) return cached.entries;

  const entries = [];
  function walk(dir, depth) {
    if (depth > MAX_DEPTH || entries.length >= MAX_COLLECT) return;
    let children;
    try { children = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    children.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const child of children) {
      if (entries.length >= MAX_COLLECT) break;
      if (child.isDirectory() && (SKIP_DIRS.has(child.name) || child.name.startsWith('.'))) continue;

      const fullPath = path.join(dir, child.name);
      const relative = path.relative(cwd, fullPath).split(path.sep).join('/');
      if (!relative || relative.startsWith('../')) continue;

      if (child.isDirectory()) {
        entries.push({ path: `${relative}/`, type: 'directory' });
        walk(fullPath, depth + 1);
      } else if (child.isFile()) {
        entries.push({ path: relative, type: 'file' });
      }
    }
  }

  walk(cwd, 0);
  cache.set(cwd, { time: Date.now(), entries });
  return entries;
}

function score(entry, query) {
  if (!query) return entry.type === 'directory' ? 1 : 0;
  const candidate = entry.path.toLowerCase();
  const basename = path.posix.basename(candidate.replace(/\/$/, ''));
  if (candidate === query) return 100;
  if (candidate.startsWith(query)) return 80 - candidate.length / 1000;
  if (basename.startsWith(query)) return 70 - candidate.length / 1000;
  const index = candidate.indexOf(query);
  return index >= 0 ? 50 - index / 100 - candidate.length / 1000 : -1;
}

function complete({ query = '', cwd = process.cwd(), limit = 50 } = {}) {
  const normalizedQuery = String(query).replace(/^\.\//, '').toLowerCase();
  return collectEntries(cwd)
    .map(entry => ({ entry, score: score(entry, normalizedQuery) }))
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path))
    .slice(0, limit)
    .map(({ entry }) => ({
      label: entry.path,
      detail: entry.type === 'directory' ? 'folder' : 'file',
      value: /\s/.test(entry.path) ? `@"${entry.path}"` : `@${entry.path}`,
    }));
}

module.exports = { title: 'Files and folders', complete, collectEntries };
