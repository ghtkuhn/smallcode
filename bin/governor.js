// SmallCode — Governor Module (ARK-inspired)
// Wires into the agent loop: tool scoring, verification, hard fail

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Tool Scorer ─────────────────────────────────────────────────────────────

const SCORES_FILE = path.join(process.cwd(), '.smallcode', 'tool_scores.json');

class ToolScorer {
  constructor() {
    this.scores = {};
    this.load();
  }

  recordSuccess(toolName, taskType, latencyMs) {
    const key = `${toolName}:${taskType}`;
    const s = this.getOrCreate(key, toolName, taskType);
    s.success_count++;
    s.total_calls++;
    s.confidence = (s.success_count + 1) / (s.total_calls + 2);
    this.save();
  }

  recordFailure(toolName, taskType, error) {
    const key = `${toolName}:${taskType}`;
    const s = this.getOrCreate(key, toolName, taskType);
    s.failure_count++;
    s.total_calls++;
    s.confidence = (s.success_count + 1) / (s.total_calls + 2);
    s.last_error = error;
    this.save();
  }

  shouldAvoid(toolName, taskType) {
    const key = `${toolName}:${taskType}`;
    const s = this.scores[key];
    if (!s) return false;
    return s.total_calls >= 3 && s.confidence < 0.35;
  }

  getScore(toolName, taskType) {
    const key = `${toolName}:${taskType}`;
    if (!this.scores[key]) return 0.65; // exploration bonus
    return Math.min(this.scores[key].confidence, 0.95);
  }

  getOrCreate(key, toolName, taskType) {
    if (!this.scores[key]) {
      this.scores[key] = { tool_name: toolName, task_type: taskType, success_count: 0, failure_count: 0, total_calls: 0, confidence: 0.5, last_error: null };
    }
    return this.scores[key];
  }

  load() {
    try { if (fs.existsSync(SCORES_FILE)) this.scores = JSON.parse(fs.readFileSync(SCORES_FILE, 'utf-8')); } catch {}
  }

  save() {
    try {
      const dir = path.dirname(SCORES_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(SCORES_FILE, JSON.stringify(this.scores, null, 2));
    } catch {}
  }
}

// ─── Code Verifier ───────────────────────────────────────────────────────────

function verifyCode(filePath) {
  const fullPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(fullPath)) return { passed: false, errors: ['File not found'], confidence: 0 };

  const ext = path.extname(filePath);
  const result = { passed: false, confidence: 0, compiled: false, executed: false, errors: [] };

  // Compile check (use execFileSync with args array to avoid shell injection
  // via a crafted filePath like `evil.py; rm -rf /`).
  let compileExec = null; // [cmd, args]
  switch (ext) {
    case '.py': compileExec = ['python', ['-m', 'py_compile', fullPath]]; break;
    case '.js': case '.mjs': compileExec = ['node', ['--check', fullPath]]; break;
    case '.ts': case '.tsx': compileExec = ['npx', ['tsc', '--noEmit', fullPath]]; break;
    case '.go': compileExec = ['go', ['build', fullPath]]; break;
    case '.json':
      try { JSON.parse(fs.readFileSync(fullPath, 'utf-8')); result.compiled = true; }
      catch (e) { result.errors.push(e.message); }
      break;
    default: result.compiled = true; // Can't check, assume ok
  }

  if (compileExec) {
    try {
      execFileSync(compileExec[0], compileExec[1], { encoding: 'utf-8', timeout: 15000, cwd: process.cwd() });
      result.compiled = true;
    } catch (e) {
      result.errors.push((e.stdout || e.stderr || e.message || '').slice(0, 500));
    }
  }

  // Verification must never execute model-authored code implicitly. Runtime
  // behavior belongs to explicit test/run tools where cancellation and shell
  // policy are visible to the user.
  result.executed = result.compiled;

  // Confidence score
  result.confidence = (result.compiled ? 0.4 : 0) + (result.executed ? 0.4 : 0) + (result.errors.length === 0 ? 0.2 : 0);
  result.passed = result.compiled && result.executed;
  return result;
}

// ─── Hard Fail ───────────────────────────────────────────────────────────────

const MAX_VERIFICATION_RETRIES = 2;
const verificationHistory = {}; // filePath → [results]
const MAX_TRACKED_FILES = 50; // Prevent unbounded growth

function checkAndEnforceHardFail(filePath) {
  if (!verificationHistory[filePath]) verificationHistory[filePath] = [];

  // Bound the history: if we're tracking too many files, drop the oldest
  const trackedFiles = Object.keys(verificationHistory);
  if (trackedFiles.length > MAX_TRACKED_FILES) {
    // Remove the first N entries (oldest by insertion order)
    for (const k of trackedFiles.slice(0, trackedFiles.length - MAX_TRACKED_FILES)) {
      delete verificationHistory[k];
    }
  }
  
  const result = verifyCode(filePath);
  verificationHistory[filePath].push(result);
  
  if (result.passed) {
    verificationHistory[filePath] = []; // Reset on success
    return { action: 'accept', confidence: result.confidence };
  }

  const attempts = verificationHistory[filePath].length;
  if (attempts >= MAX_VERIFICATION_RETRIES) {
    // Instead of hard fail: DECOMPOSE the problem
    // Read the file, identify what's broken, ask model to tackle one piece at a time
    const fs = require('fs');
    const path = require('path');
    let content = '';
    try { content = fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf-8'); } catch {}
    
    const lines = content.split('\n').length;
    const errors = result.errors || [];
    
    verificationHistory[filePath] = []; // Reset for the decomposed attempt
    
    return { 
      action: 'decompose', 
      errors,
      fileContent: content,
      lines,
      strategy: pickDecomposeStrategy(content, errors, filePath),
    };
  }

  return { action: 'retry', errors: result.errors, attempt: attempts, escalate: attempts >= 2 };
}

// Choose how to break the problem apart based on what's failing
function pickDecomposeStrategy(content, errors, filePath) {
  const ext = require('path').extname(filePath);
  const lines = content.split('\n').length;
  const errorCount = errors.length;
  
  // Strategy 1: File is too big — split into smaller files
  if (lines > 80) {
    return {
      type: 'split_file',
      reason: `File is ${lines} lines with ${errorCount} errors. Too much for one pass.`,
      instruction: `The file ${filePath} is too complex to fix in one go (${lines} lines, ${errorCount} errors). 
Split it into smaller files:
1. First, extract the working parts into a separate file
2. Then fix the broken parts in isolation
3. Import between them

Start by identifying which functions/sections are correct and which have errors.`,
    };
  }
  
  // Strategy 2: Multiple unrelated errors — fix one at a time
  if (errorCount > 1) {
    const firstError = errors[0] || '';
    return {
      type: 'one_error_at_a_time',
      reason: `${errorCount} errors found. Fix them one at a time.`,
      instruction: `Stop trying to fix everything at once. Focus on ONE error only:

ERROR: ${firstError}

Fix ONLY this one error. Don't touch anything else. After this is fixed, I'll tell you the next one.`,
    };
  }
  
  // Strategy 3: Single persistent error — try different approach
  return {
    type: 'rewrite_section',
    reason: 'Same error persists after 2 attempts.',
    instruction: `The fix attempts aren't working. Try a completely different approach:
1. Delete the broken section entirely
2. Rewrite it from scratch using a simpler implementation
3. Don't copy the old logic — start fresh

Error that won't go away: ${errors[0] || 'unknown'}`,
  };
}

// ─── Task Classifier ─────────────────────────────────────────────────────────

// Synchronous regex-based classifier (fast, deterministic, no LLM)
// Used as default for fast tasks and as fallback for the LLM-based one.
function classifyTask(userMessage) {
  const msg = userMessage.toLowerCase();
  // Detect backend/API tasks that should use BoneScript — ONLY for Node.js/TypeScript backends
  // If user mentions Python/Django/FastAPI/Go/Rust/etc, do NOT trigger BoneScript
  const nonNodeBackend = msg.match(/\b(python|django|fastapi|flask|go|golang|rust|actix|axum|ruby|rails|php|laravel|java|spring|c#|dotnet|asp\.net|elixir|phoenix)\b/);
  if (!nonNodeBackend && (
    msg.match(/\b(api|backend|server|rest|crud|auth|database|endpoint|express|fastify|node|typescript|ts)\b.*\b(create|build|make|implement|set up)\b/) ||
    msg.match(/\b(create|build|make)\b.*\b(api|backend|server|rest|crud|endpoint)\b.*\b(node|typescript|ts|express|fastify)?\b/) ||
    msg.match(/\b(node|typescript|ts|express|fastify)\b.*\b(api|backend|server|rest|crud)\b/)
  )) {
    return 'backend';
  }
  if (msg.match(/\b(create|write|build|make|implement|add)\b.*\b(file|function|class|module|component|api|server)\b/)) return 'coding';
  if (msg.match(/\b(fix|patch|edit|change|update|modify|replace|rename)\b/)) return 'editing';
  if (msg.match(/\b(find|search|grep|where|which|look for)\b/)) return 'search';
  if (msg.match(/\b(run|execute|test|install|build|compile|deploy)\b/)) return 'shell';
  if (msg.match(/\b(explain|what|how|why|describe|show me)\b/)) return 'explanation';
  if (msg.match(/\b(and then|then|after that|also|plus|step)\b.*\b(and then|then|also)\b/)) return 'multi_step';
  if (msg.match(/\b(debug|fix|error|bug|crash|broken|failing)\b/)) return 'debugging';
  return 'coding'; // default
}

// Async classifier — uses MarrowScript-compiled cognition layer with caching,
// validation, retries, and tracing. Falls back to regex classifier on failure.
// Use this when latency budget allows (~200-500ms for a TinyClassifier call,
// 0ms on cache hit).
async function classifyTaskAsync(userMessage) {
  try {
    const { classifyTaskCompiled } = require('./cognition_adapter');
    return await classifyTaskCompiled(userMessage, { fallback: classifyTask });
  } catch {
    return classifyTask(userMessage);
  }
}

module.exports = { ToolScorer, verifyCode, checkAndEnforceHardFail, classifyTask, classifyTaskAsync, verificationHistory, pickDecomposeStrategy };
