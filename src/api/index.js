// SmallCode — Programmatic API (Runtime)
// Compiled from: src/api/index.ms
//
// Usage:
//   const { SmallCode } = require('smallcode');
//   const agent = new SmallCode({ model: 'gemma-4-e4b', baseUrl: 'http://localhost:1234/v1' });
//   const result = await agent.run("create a hello world script and run it");
//   console.log(result.response);
//   console.log(result.filesCreated);
//   console.log(result.toolCalls.length, 'tool calls');

const path = require('path');
const { EventEmitter } = require('events');
const { EarlyStopDetector } = require('../governor/early_stop');
const { getProfile } = require('../model/profiles');
const {
  escapeShellArg,
  buildCommand,
  safeResolvePath,
  sanitizeToolOutput,
} = require('../security/sanitize');
const { validateShellCommand } = require('../security/shell_policy');
const { runProcess } = require('../tools/process_runner');
const { getTDDGovernor } = require('../governor/tdd_governor');
const { prepareFileEdit, commitValidatedEdit } = require('../validation/file_edit_transaction');
const { PlanningModeController, PlanStore, ModePolicy } = require('../session/planning_mode');

class SmallCode extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      model: config.model || process.env.SMALLCODE_MODEL || '',
      baseUrl: config.baseUrl || process.env.SMALLCODE_BASE_URL || 'http://localhost:1234/v1',
      provider: config.provider || process.env.SMALLCODE_PROVIDER || 'openai',
      apiKey: config.apiKey || process.env.OPENAI_API_KEY || null,
      contextWindow: config.contextWindow || 0,
      maxToolCalls: config.maxToolCalls || 50,
      timeout: config.timeout || 120000,
      cwd: config.cwd || process.cwd(),
      tools: config.tools || null, // null = all tools
      verbose: config.verbose || false,
      planning: { enabled: config.planning?.enabled !== undefined ? config.planning.enabled : (process.env.SMALLCODE_PLAN_MODE !== undefined ? process.env.SMALLCODE_PLAN_MODE !== 'false' : (process.env.SMALLCODE_PLAN !== undefined ? process.env.SMALLCODE_PLAN !== 'false' : true)) },
    };
    try { this.config.cwd = require('fs').realpathSync.native(this.config.cwd); }
    catch { this.config.cwd = path.resolve(this.config.cwd); }

    this.earlyStop = new EarlyStopDetector();
    this.profile = getProfile(this.config.model, this.config.contextWindow);
    this._history = [];
    this.planningController = new PlanningModeController({ enabled: this.config.planning.enabled, source: config.planning?.enabled !== undefined ? 'api' : 'default', workspaceRoot: this.config.cwd, store: new PlanStore({ workspaceRoot: this.config.cwd, dir: config.planStoreDir }) });
    this.modePolicy = new ModePolicy(this.planningController);
  }

  /**
   * Run a single prompt through the agent loop.
   * Returns structured results with response, tool calls, and file changes.
   */
  async run(prompt) {
    const startTime = Date.now();
    this.earlyStop.newTurn();
    this._history = [];

    if (this.planningController.enabled) {
      if (this.planningController.mode === 'plan' && this.planningController.isExecutionConsent(prompt)) {
        const started = this.planningController.beginExecution();
        if (!started.ok) return { response: '', success: false, error: started.error, mode: 'plan', requiresApproval: true };
        prompt = `Execute approved plan ${started.plan.id}: ${started.plan.title}`;
      } else if (this.planningController.mode === 'plan') {
        this.planningController.beginPlanning(prompt);
      }
    }

    const result = {
      response: '',
      toolCalls: [],
      filesCreated: [],
      filesEdited: [],
      tokensUsed: { input: 0, output: 0, total: 0 },
      duration: 0,
      success: false,
      error: null,
      mode: this.planningController.mode,
      plan: this.planningController.getPlan(),
      planId: this.planningController.getPlan()?.id || null,
      requiresApproval: false,
      executionStatus: this.planningController.mode === 'execution' ? 'executing' : null,
    };

    try {
      const messages = [
        { role: 'system', content: this._buildSystemPrompt() },
        { role: 'user', content: prompt },
      ];

      let toolCallCount = 0;

      while (toolCallCount < this.config.maxToolCalls) {
        const response = await this._chatCompletion(messages);
        if (!response) {
          result.error = 'No response from model';
          break;
        }

        const message = response.choices?.[0]?.message;
        if (!message) break;

        // Recover tool calls embedded in text content (qwen2.5-coder etc.)
        // See src/tools/tool_call_extractor.js + issue #36.
        try {
          const { extractFromMessage } = require('../tools/tool_call_extractor');
          extractFromMessage(message, this._getTools());
        } catch {}

        // Track token usage
        if (response.usage) {
          result.tokensUsed.input += response.usage.prompt_tokens || 0;
          result.tokensUsed.output += response.usage.completion_tokens || 0;
          result.tokensUsed.total = result.tokensUsed.input + result.tokensUsed.output;
        }

        // Tool calls
        if (message.tool_calls && message.tool_calls.length > 0) {
          messages.push(message);

          for (const tc of message.tool_calls) {
            toolCallCount++;
            const toolName = tc.function.name;
            let toolArgs;
            try { toolArgs = JSON.parse(tc.function.arguments); } catch { toolArgs = {}; }

            this.emit('tool_start', { name: toolName, args: toolArgs });
            const toolStart = Date.now();

            // TDD phase gate: block writes that violate the current phase
            const tddGate = getTDDGovernor({ workdir: this.config.cwd }).checkToolCall(toolName, toolArgs);
            if (tddGate) {
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: tddGate,
              });
              result.toolCalls.push({ name: toolName, args: toolArgs, result: tddGate, error: null, durationMs: 0 });
              continue;
            }

            let toolResult = await this._executeTool(toolName, toolArgs);
            // TDD post-write hook (same as bin/executor.js wrapper)
            const TDD_WRITE_TOOLS = new Set(['write_file', 'patch', 'append_file', 'read_and_patch']);
            if (TDD_WRITE_TOOLS.has(toolName) && toolResult && !toolResult.error) {
              toolResult = await this._tddPostWrite(toolArgs && (toolArgs.path || ''), toolResult);
            }
            const toolMs = Date.now() - toolStart;

            this.emit('tool_end', { name: toolName, result: toolResult, ms: toolMs });

            // Track file changes
            if (toolResult.action === 'Created') result.filesCreated.push(toolResult.path || toolArgs.path);
            if (toolResult.action === 'Edited' || toolResult.action === 'Updated') result.filesEdited.push(toolResult.path || toolArgs.path);

            result.toolCalls.push({
              name: toolName,
              args: toolArgs,
              result: toolResult.result || toolResult.error || '',
              error: toolResult.error || null,
              durationMs: toolMs,
            });

            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: toolResult.result || toolResult.error || '',
            });

            if (toolName === 'submit_plan' && !toolResult.error) {
              const plan = toolResult.plan;
              result.response = `${plan.title}\n\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
              result.plan = plan; result.planId = plan.id; result.mode = 'plan'; result.requiresApproval = true;
              result.executionStatus = plan.status; result.success = true; result.duration = Date.now() - startTime;
              return result;
            }

            // Patch spiral detection
            if (toolName === 'patch' || toolName === 'read_and_patch') {
              const signal = this.earlyStop.recordPatchResult(toolArgs.path, !toolResult.error);
              if (signal) {
                this.emit('early_stop', signal);
                messages.push({ role: 'user', content: signal.injection });
                break;
              }
            }
          }
          continue;
        }

        // Text response (done)
        if (message.content) {
          result.response = message.content;
          this.emit('token', message.content);
        }
        break;
      }

      result.success = !result.error;
      if (this.planningController.mode === 'execution') this.planningController.finishExecution(result.success, result.error);
    } catch (err) {
      result.error = err.message;
      this.emit('error', err);
      if (this.planningController.mode === 'execution') this.planningController.finishExecution(false, err.message);
    }

    result.duration = Date.now() - startTime;
    result.mode = this.planningController.mode;
    result.plan = this.planningController.getPlan();
    result.planId = result.plan?.id || null;
    result.requiresApproval = this.planningController.enabled && result.mode === 'plan' && result.plan?.status === 'ready';
    result.executionStatus = result.plan?.status || null;
    return result;
  }

  get mode() { return this.planningController.mode; }
  getPlan() { return this.planningController.getPlan(); }
  async executePlan(id) {
    const selected = id === 'latest' ? this.planningController.store.latest() : (id ? this.planningController.store.load(id) : this.planningController.getPlan());
    if (selected) this.planningController.activePlan = selected;
    const started = this.planningController.beginExecution();
    if (!started.ok) return { success: false, error: started.error, mode: 'plan', requiresApproval: true };
    return this.run(`Execute approved plan ${started.plan.id}: ${started.plan.title}`);
  }

  /**
   * Get the detected model profile.
   */
  getProfile() {
    return this.profile;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  _buildSystemPrompt() {
    const tddPhase = getTDDGovernor({ workdir: this.config.cwd }).phasePrompt();
    return `You are SmallCode, a coding assistant. You have tools to read, write, and edit files, run shell commands, and search code.
Rules:
- Use patch for edits (search-and-replace). Do NOT rewrite whole files.
- Be concise — show what you did, not lengthy explanations.
- Working directory: ${this.config.cwd}${tddPhase}${this.planningController.prompt()}`;
  }

  async _chatCompletion(messages) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    if (this.config.baseUrl.includes('openrouter.ai')) {
      headers['HTTP-Referer'] = 'https://github.com/Doorman11991/smallcode';
      headers['X-Title'] = 'SmallCode';
    }

    const tools = this._getTools();

    const body = {
      model: this.config.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      temperature: 0.1,
      max_tokens: 4096,
    };

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      // Redact provider error before throwing — some providers echo the
      // request back including Authorization headers on 401/403.
      throw new Error(`API error ${response.status}: ${sanitizeToolOutput(err).slice(0, 200)}`);
    }

    return response.json();
  }

  _getTools() {
    const fs = require('fs');
    // Minimal tool set for programmatic use
    const tools = [
      { type: 'function', function: { name: 'submit_plan', description: 'Submit the final implementation plan and stop.', parameters: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' }, steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 }, verification: { type: 'array', items: { type: 'string' } } }, required: ['title', 'steps'] } } },
      { type: 'function', function: { name: 'read_file', description: 'Read a file. Returns content with line numbers.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to cwd' } }, required: ['path'] } } },
      { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a file.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'Full file content' } }, required: ['path', 'content'] } } },
      { type: 'function', function: { name: 'patch', description: 'Edit file by replacing old_str with new_str. old_str must match exactly ONE location.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File to edit' }, old_str: { type: 'string', description: 'Exact text to find' }, new_str: { type: 'string', description: 'Replacement text' } }, required: ['path', 'old_str', 'new_str'] } } },
      { type: 'function', function: { name: 'bash', description: 'Run a shell command. Returns stdout/stderr.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Shell command' } }, required: ['command'] } } },
      { type: 'function', function: { name: 'search', description: 'Search file contents using regex. Returns matching lines.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Regex pattern' } }, required: ['pattern'] } } },
      { type: 'function', function: { name: 'find_files', description: 'Find files matching a glob pattern.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Glob pattern' } }, required: ['pattern'] } } },
      { type: 'function', function: { name: 'run_tests', description: 'Run the project\'s test suite and return structured results: pass/fail counts and per-failing-test names and messages.', parameters: { type: 'object', properties: { test_filter: { type: 'string', description: 'Optional: run only tests matching this pattern.' } }, required: [] } } },
      { type: 'function', function: { name: 'tdd_loop', description: 'Start a TDD loop for a list of requirements. Harness enforces Red→Green automatically on every file write.', parameters: { type: 'object', properties: { requirements: { type: 'array', items: { type: 'string' } } }, required: ['requirements'] } } },
      { type: 'function', function: { name: 'tdd_status', description: 'Show current TDD phase and requirements checklist.', parameters: { type: 'object', properties: {}, required: [] } } },
    ];

    if (this.config.tools) {
      return this.modePolicy.filterTools(tools.filter(t => this.config.tools.includes(t.function.name)));
    }
    return this.modePolicy.filterTools(tools);
  }

  async _tddPostWrite(filePath, toolResult) {
    try {
      const { getTDDState, _isTestFile } = require('./session/tdd_state');
      const tdd = getTDDState({ workdir: this.config.cwd });
      if (!tdd.loopActive) return toolResult;
      const { runTests, formatResult } = require('./tools/run_tests');
      const { getTDDGovernor } = require('./governor/tdd_governor');
      const filter = (!tdd.isRefactor() && !tdd.allRequirementsDone() && tdd.targetTest) ? tdd.targetTest : null;
      const testResult = runTests({ workdir: this.config.cwd, test_filter: filter || undefined });
      if (tdd.isIdle() && _isTestFile(filePath || '') && (testResult.failed > 0 || testResult.errors > 0)) {
        const name = (testResult.failures[0] && testResult.failures[0].name) || 'new test';
        tdd.beginCycle(name);
      }
      const tddMsg = getTDDGovernor({ workdir: this.config.cwd }).processTestResult(testResult);
      const note = `\n\n[harness] run_tests: ${testResult.summary}${tddMsg ? '\n[TDD] ' + tddMsg : ''}`;
      return { ...toolResult, result: (toolResult.result || '') + note };
    } catch {
      return toolResult;
    }
  }

  async _executeTool(name, args) {
    const fs = require('fs');
    const { execSync } = require('child_process');
    const cwd = this.config.cwd;

    const auth = this.modePolicy.authorizeTool(name, args, null, { workspaceRoot: cwd, cwd, platform: process.platform });
    if (!auth.ok) return { error: `Mode policy blocked [${auth.code}]: ${auth.reason}`, kind: 'mode_policy' };
    if (name === 'submit_plan') {
      const submitted = this.planningController.submitPlan(args);
      return submitted.ok ? { result: `Plan ${submitted.plan.id} ready.`, action: 'PlanSubmitted', plan: submitted.plan } : { error: submitted.error };
    }

    switch (name) {
      case 'read_file': {
        const safe = safeResolvePath(args.path, cwd);
        if (!safe.ok) return { error: `read_file rejected: ${safe.reason}` };
        const filePath = safe.fullPath;
        if (!fs.existsSync(filePath)) return { error: `File not found: ${args.path}` };
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const start = (args.start_line || 1) - 1;
        const end = args.end_line || lines.length;
        const numbered = lines.slice(start, end).map((l, i) => `${String(start + i + 1).padStart(4)}│ ${sanitizeToolOutput(l)}`).join('\n');
        return { result: `${args.path} (${lines.length} lines):\n${numbered}` };
      }

      case 'write_file': {
        const safe = safeResolvePath(args.path, cwd);
        if (!safe.ok) return { error: `write_file rejected: ${safe.reason}` };
        const filePath = safe.fullPath;
        const existed = fs.existsSync(filePath);
        const before = existed ? fs.readFileSync(filePath, 'utf8') : null;
        const prepared = await prepareFileEdit({ filePath, content: args.content, previousContent: before, workspaceRoot: cwd });
        if (!prepared.ok) return prepared;
        commitValidatedEdit(prepared);
        const action = existed ? 'Updated' : 'Created';
        return { result: `${action} ${args.path} (${args.content.split('\n').length} lines)`, action, path: args.path };
      }

      case 'patch': {
        const safe = safeResolvePath(args.path, cwd);
        if (!safe.ok) return { error: `patch rejected: ${safe.reason}` };
        const filePath = safe.fullPath;
        if (!fs.existsSync(filePath)) return { error: `File not found: ${args.path}` };
        let content = fs.readFileSync(filePath, 'utf-8');
        const count = content.split(args.old_str).length - 1;
        if (count === 0) return { error: `old_str not found in ${args.path}` };
        if (count > 1) return { error: `old_str matches ${count} locations. Be more specific.` };
        const before = content;
        content = content.replace(args.old_str, args.new_str);
        const prepared = await prepareFileEdit({ filePath, content, previousContent: before, workspaceRoot: cwd });
        if (!prepared.ok) return prepared;
        commitValidatedEdit(prepared);
        return { result: `Patched ${args.path}`, action: 'Edited', path: args.path };
      }

      case 'bash': {
        let command = args.command;
        const policy = validateShellCommand(command, { workspaceRoot: cwd, cwd, platform: process.platform });
        if (!policy.ok) return { error: `Shell policy blocked [${policy.code}]: ${policy.reason}`, command, target: policy.target, workspaceRoot: policy.workspaceRoot };
        if (process.platform === 'win32') {
          command = command.replace(/^ls\b/, 'dir').replace(/^cat /, 'type ');
        }
        try {
          const processResult = await runProcess(command, { timeout: 30000, cwd });
          if (processResult.exitCode !== 0) throw Object.assign(new Error(processResult.stderr), { stdout: processResult.stdout, stderr: processResult.stderr, status: processResult.exitCode });
          const output = processResult.stdout;
          return { result: sanitizeToolOutput(output).slice(0, 3000) || '(no output)', command };
        } catch (e) {
          const output = (e.stdout || '') + (e.stderr || '');
          return { result: sanitizeToolOutput(output).slice(0, 2000) || sanitizeToolOutput(e.message || ''), error: `Exit code ${e.status || 'unknown'}`, command };
        }
      }

      case 'search': {
        try {
          const cmd = buildCommand('rg', ['--line-number', '--max-count', '10'], String(args.pattern || '')) + ' .';
          const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000, cwd });
          return { result: sanitizeToolOutput(output).slice(0, 3000) };
        } catch {
          return { result: 'No matches found.' };
        }
      }

      case 'find_files': {
        try {
          const cmd = 'rg --files --glob ' + escapeShellArg(String(args.pattern || ''))
            + ' --glob ' + escapeShellArg('!node_modules')
            + ' --glob ' + escapeShellArg('!.git');
          const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000, cwd });
          const files = output.trim().split('\n').filter(Boolean).slice(0, 30);
          return { result: files.length ? `Found ${files.length} files:\n${files.join('\n')}` : 'No files found.' };
        } catch {
          return { result: 'No files found.' };
        }
      }

      case 'run_tests': {
        const { runTests, formatResult } = require('../tools/run_tests');
        const { getTDDGovernor } = require('../governor/tdd_governor');
        const testOpts = { workdir: cwd, timeout: 120000 };
        if (args.test_filter) testOpts.test_filter = args.test_filter;
        const testResult = runTests(testOpts);
        let tddMessage = null;
        try {
          const gov = getTDDGovernor({ workdir: cwd });
          tddMessage = gov.processTestResult(testResult);
        } catch {}
        const formatted = formatResult(testResult);
        return { result: tddMessage ? `${formatted}\n\n[TDD] ${tddMessage}` : formatted };
      }

      case 'tdd_loop': {
        const { getTDDState } = require('../session/tdd_state');
        const { resetTDDGovernor } = require('../governor/tdd_governor');
        resetTDDGovernor();
        const r = getTDDState({ workdir: cwd }).initRequirements(Array.isArray(args.requirements) ? args.requirements : []);
        return { result: r.ok ? r.message : `tdd_loop error: ${r.message}` };
      }

      case 'tdd_begin_cycle': {
        const { getTDDState } = require('../session/tdd_state');
        const r = getTDDState({ workdir: cwd }).beginCycle(args.test_name || '');
        return { result: r.message };
      }

      case 'tdd_status': {
        const { getTDDState, PHASES } = require('../session/tdd_state');
        const tdd = getTDDState({ workdir: cwd });
        const lines = [];
        if (tdd.loopActive && tdd.requirements.length > 0) {
          lines.push(`TDD Loop: ${tdd.doneRequirements().length}/${tdd.requirements.length} done${tdd.loopComplete() ? ' ✓' : ''}`);
          for (const r of tdd.requirements) {
            lines.push(`  ${r.status === 'done' ? '✓' : r.status === 'active' ? '→' : '○'} ${r.id}: ${r.text}`);
          }
        }
        if (tdd.isIdle() && !tdd.loopActive) return { result: 'TDD: idle — no active cycle.' };
        if (!tdd.isIdle()) {
          const confirmed = tdd.phase === PHASES.RED ? (tdd.redConfirmed ? ' (confirmed)' : ' (unconfirmed)') : '';
          lines.push(`Phase: ${tdd.phase}${confirmed}`, `Target: ${tdd.targetTest}`);
        }
        return { result: lines.join('\n') };
      }

      case 'tdd_advance': {
        const { getTDDState } = require('../session/tdd_state');
        const { runTests } = require('../tools/run_tests');
        const tdd = getTDDState({ workdir: cwd });
        if (tdd.isIdle()) return { result: 'No active TDD cycle. Call tdd_begin_cycle first.' };
        if (tdd.phase === 'red') {
          if (!tdd.redConfirmed) return { result: 'Call run_tests first to confirm the test is failing.' };
          const r = tdd.advanceToGreen(runTests({ workdir: cwd }));
          return { result: r.message };
        }
        if (tdd.phase === 'green') {
          const r = args.skip_refactor ? tdd.skipRefactor() : tdd.enterRefactor();
          return { result: r.message };
        }
        if (tdd.phase === 'refactor') {
          const r = tdd.completeCycle(runTests({ workdir: cwd }));
          return { result: r.message };
        }
        return { result: `Unexpected TDD phase: ${tdd.phase}` };
      }

      case 'tdd_reset': {
        const { getTDDState } = require('../session/tdd_state');
        const r = getTDDState({ workdir: cwd }).reset();
        return { result: r.message };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  }
}

module.exports = { SmallCode };
