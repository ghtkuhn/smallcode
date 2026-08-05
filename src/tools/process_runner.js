'use strict';

const { spawn } = require('child_process');

function runProcess(command, options = {}) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, {
      cwd: options.cwd || process.cwd(), env: options.env || process.env,
      shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = result => { if (!settled) { settled = true; cleanup(); resolve(result); } };
    const max = options.maxBuffer || 1024 * 1024;
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-max); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-max); });
    child.on('error', error => finish({ stdout, stderr, exitCode: -1, error: error.message }));
    child.on('exit', (code, signal) => finish({ stdout, stderr, exitCode: code ?? -1, signal, cancelled: options.signal?.aborted || false }));
    const kill = signal => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { try { child.kill(signal); } catch {} }
    };
    const abort = () => kill('SIGTERM');
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { kill('SIGKILL'); finish({ stdout, stderr, exitCode: -1, timedOut: true }); }, options.timeout || 30000);
    timer.unref?.();
    function cleanup() { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
  });
}

module.exports = { runProcess };
