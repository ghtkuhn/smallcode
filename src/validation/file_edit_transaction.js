'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getWriteValidationRegistry } = require('./write_validation');

function sourceExcerpt(content, line, radius = 1) {
  const lines = String(content).split('\n');
  const center = Math.max(1, Number(line) || 1);
  const start = Math.max(1, center - radius);
  const end = Math.min(lines.length, center + radius);
  return lines.slice(start - 1, end).map((text, index) => `${String(start + index).padStart(4)}| ${text}`).join('\n');
}

function formatValidationError(filePath, content, validation) {
  const details = validation.diagnostics.slice(0, 5).map(item => {
    const at = `${item.line || 1}:${item.column || 1}`;
    return `[${item.validator}] ${filePath}:${at} ${item.message}\n${sourceExcerpt(content, item.line)}`;
  });
  return `Pre-write validation blocked ${filePath}:\n${details.join('\n')}`;
}

async function prepareFileEdit({ filePath, content, previousContent = null, workspaceRoot, signal, registry } = {}) {
  if (typeof filePath !== 'string' || typeof content !== 'string') throw new TypeError('prepareFileEdit requires filePath and string content');
  const validation = await (registry || getWriteValidationRegistry()).validateCandidate({
    filePath,
    content,
    previousContent,
    workspaceRoot,
  }, { signal });
  if (validation.status === 'fail') {
    return {
      ok: false,
      kind: validation.aborted ? 'cancelled' : 'prewrite_validation',
      cancelled: !!validation.aborted,
      error: validation.aborted ? 'Pre-write validation cancelled' : formatValidationError(filePath, content, validation),
      diagnostics: validation.diagnostics,
      validation,
    };
  }
  return { ok: true, filePath, content, previousContent, validation };
}

function commitValidatedEdit(prepared) {
  if (!prepared?.ok) throw new TypeError('Only a validated edit can be committed');
  const filePath = path.resolve(prepared.filePath);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  let existingMode = null;
  try { existingMode = fs.statSync(filePath).mode & 0o777; } catch {}
  const temporary = path.join(dir, `.${path.basename(filePath)}.smallcode-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, prepared.content, existingMode === null ? undefined : { mode: existingMode });
    if (existingMode !== null) fs.chmodSync(temporary, existingMode);
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  return { path: filePath, validation: prepared.validation };
}

module.exports = { prepareFileEdit, commitValidatedEdit, formatValidationError, sourceExcerpt };
