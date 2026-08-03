// SmallCode — @file Reference Resolution
// Parse @path mentions in user input and inject file content
// Adapted from OpenCode's reference system (simplified)
//
// Syntax:
//   @src/main.ts          — inject file content
//   @package.json         — inject file content
//   @src/                 — list directory contents
//   @"docs/my file.md"    — quote paths that contain spaces
//   @~/config.json        — resolve from home dir (allowed but path-checked)
//
// Safety:
//   - Resolved paths must be inside cwd OR home dir
//   - Sensitive paths (.ssh, .aws, /etc/shadow, etc.) are refused
//   - File content is sanitized (ANSI stripped, secrets redacted) before
//     injection so the model never sees raw API keys / tokens / passwords

const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeResolvePath, sanitizeToolOutput } = require('../security/sanitize');

// Matches @path but not inside backticks or after word chars
const FILE_REGEX = /(?<![\w`])@(?:"([^"]+)"|'([^']+)'|(\.?[^\s`,.]*(?:\.[^\s`,.]+)*))/g;

/**
 * Parse @file references from user input.
 * Returns the text with references resolved + injected file contents.
 */
function resolveReferences(input, cwd) {
  const matches = [...input.matchAll(FILE_REGEX)];
  if (matches.length === 0) return { text: input, files: [] };

  const files = [];
  const seen = new Set();

  for (const match of matches) {
    const rawPath = match[1] || match[2] || match[3];
    if (!rawPath || rawPath.length < 2) continue;
    if (seen.has(rawPath)) continue;
    seen.add(rawPath);

    // Resolve the path safely. We allow `~/...` but require the resolved
    // path NOT to be a sensitive credential file (.ssh, .aws, etc.).
    // For project-relative paths we additionally require containment.
    const isHome = rawPath.startsWith('~/') || rawPath.startsWith('~\\');
    const safe = safeResolvePath(rawPath, cwd, {
      allowHome: isHome,
      allowOutside: isHome, // a ~/-relative path is by definition outside cwd
    });
    if (!safe.ok) continue; // Silently skip unsafe references — model gets nothing
    const resolvedPath = safe.fullPath;

    if (!fs.existsSync(resolvedPath)) continue;

    let stat;
    try { stat = fs.statSync(resolvedPath); } catch { continue; }

    if (stat.isFile()) {
      // Refuse files larger than 5MB up front — prevents DoS via @largebinary
      if (stat.size > 5 * 1024 * 1024) continue;
      // Read file content (capped at 500 lines)
      try {
        const content = fs.readFileSync(resolvedPath, 'utf-8');
        const lines = content.split('\n');
        const truncated = lines.length > 500
          ? lines.slice(0, 500).join('\n') + `\n... (${lines.length - 500} more lines)`
          : content;

        files.push({
          path: rawPath,
          resolvedPath,
          type: 'file',
          // Sanitize before sending into the conversation: strip ANSI/control
          // chars and redact secrets. A user-typed `@.env` no longer leaks
          // their API keys to a (possibly remote) model.
          content: sanitizeToolOutput(truncated),
          lines: lines.length,
        });
      } catch {}
    } else if (stat.isDirectory()) {
      // List directory contents
      try {
        const entries = fs.readdirSync(resolvedPath, { withFileTypes: true })
          .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
          .slice(0, 50)
          .map(e => e.isDirectory() ? `${e.name}/` : e.name);

        files.push({
          path: rawPath,
          resolvedPath,
          type: 'directory',
          content: entries.join('\n'),
          lines: entries.length,
        });
      } catch {}
    }
  }

  return { text: input, files };
}

/**
 * Format resolved files for injection into the conversation.
 * Returns a string to append to the user message.
 * Capped at ~2000 tokens (8000 chars) to prevent context overflow when
 * the user types @dir/ on a large directory.
 */
function formatReferencesForPrompt(files) {
  if (files.length === 0) return '';

  const MAX_REF_CHARS = 8000; // ~2000 tokens
  let output = '\n\n--- Referenced files ---\n';
  let totalChars = output.length;

  for (const file of files) {
    let entry = '';
    if (file.type === 'file') {
      // Cap individual file content to 4000 chars
      const cappedContent = file.content.length > 4000
        ? file.content.slice(0, 4000) + `\n... (${file.lines} lines total, truncated)`
        : file.content;
      entry = `\n📄 ${file.path} (${file.lines} lines):\n\`\`\`\n${cappedContent}\n\`\`\`\n`;
    } else {
      entry = `\n📁 ${file.path}/:\n${file.content}\n`;
    }

    if (totalChars + entry.length > MAX_REF_CHARS) {
      output += `\n... (${files.length - files.indexOf(file)} more files truncated to fit context budget)\n`;
      break;
    }
    output += entry;
    totalChars += entry.length;
  }
  return output;
}

module.exports = { resolveReferences, formatReferencesForPrompt, FILE_REGEX };
