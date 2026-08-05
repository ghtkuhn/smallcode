// SmallCode — Plan-Then-Execute Mode
//
// Small models drift on multi-step tasks. They forget step 3 by the time
// they finish step 1, repeat work, or skip steps entirely. This module
// asks the model to emit a numbered plan FIRST (before any tool calls),
// then re-injects that plan as an anchor in subsequent turns.
//
// Heuristic: only kick in for tasks the model categorizes as needing a plan
// (multi-step keywords, long messages, file count > 1) — single-shot tasks
// like "create hello.py" don't need a plan and shouldn't pay the latency.
//
// Plan format (we ask the model for):
//   PLAN:
//   1. <step>
//   2. <step>
//   3. <step>
//
// On subsequent turns we inject:
//   ACTIVE PLAN (step N of M):
//   ✓ 1. <done step>
//   → 2. <current step>
//     3. <pending step>
//
// This keeps the model anchored to the overall task even after context
// eviction trims early turns.
//
// Configuration:
//   SMALLCODE_PLAN=true          force-enable for all tasks (default: heuristic)
//   SMALLCODE_PLAN=false         disable entirely
//   SMALLCODE_PLAN_MIN_STEPS=2   minimum step count to keep a plan
//   SMALLCODE_PLAN_MAX_STEPS=8   trim plans to this many steps

'use strict';

const DEFAULT_MIN_STEPS = parseInt(process.env.SMALLCODE_PLAN_MIN_STEPS) || 2;
const DEFAULT_MAX_STEPS = parseInt(process.env.SMALLCODE_PLAN_MAX_STEPS) || 8;

// Keywords that strongly suggest a multi-step task — these tasks benefit
// most from explicit planning. We deliberately keep the list short to avoid
// triggering on simple prompts.
const PLAN_HINTS = [
  /\b(refactor|migrate|rewrite|reorganize)\b/i,
  /\b(implement|build|create)\b.*\b(feature|module|service|api|app|system|project)\b/i,
  /\bstep\s*(by|-)?\s*step\b/i,
  /\b(multiple|several|all)\b.*\b(files?|tests?|functions?|endpoints?)\b/i,
  /\bend.to.end\b/i,
];

/**
 * Decide whether a prompt should trigger plan-mode.
 */
function shouldPlan(userMessage) {
  if (process.env.SMALLCODE_PLAN === 'false') return false;
  if (process.env.SMALLCODE_PLAN === 'true') return true;
  if (typeof userMessage !== 'string' || userMessage.length === 0) return false;

  // Long messages are usually multi-step
  if (userMessage.length > 300) return true;

  // Keyword hints — strong indicators of a multi-step task
  if (PLAN_HINTS.some(p => p.test(userMessage))) return true;

  // Multiple imperative sentences AND the message is reasonably long.
  // Pure 3-sentence prompts like "Fix the bug in X. It uses Y. Use Z." are
  // single-step in practice — we require length > 150 chars too.
  if (userMessage.length > 150) {
    const sentences = userMessage.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 10);
    if (sentences.length >= 3) return true;
  }

  return false;
}

/**
 * Parse a model response that should contain a plan. Returns null if no
 * recognizable plan is found.
 *
 * Tolerates several formats:
 *   1. step\n2. step
 *   - step\n- step
 *   * step\n* step
 *   PLAN:\n1. step\n...
 *   STEPS:\n1. step\n...
 */
function parsePlan(text) {
  if (typeof text !== 'string' || text.length === 0) return null;

  // Strip markdown code fences and bold markers
  const clean = text.replace(/```[\w]*\n?|\n?```/g, '').replace(/\*\*/g, '');

  // Look for a "PLAN:" / "STEPS:" header and use only what follows
  let body = clean;
  const headerMatch = clean.match(/(?:^|\n)(?:plan|steps?|approach):?\s*\n([\s\S]+?)(?=\n\n[A-Z]|$)/i);
  if (headerMatch) body = headerMatch[1];

  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);

  // Numbered lines: "1. foo", "1) foo", "1 - foo"
  const numbered = [];
  for (const line of lines) {
    const m = line.match(/^(\d{1,2})[.\)\-:]\s+(.+)$/);
    if (m) numbered.push(m[2].trim());
    else if (numbered.length > 0 && /^[a-z]/i.test(line) && !/[:.]$/.test(line) && line.length < 80) {
      // Continuation of previous item — only merge short lowercase fragments,
      // not full sentences ending in punctuation or section headers.
      numbered[numbered.length - 1] += ' ' + line;
    }
  }
  if (numbered.length >= DEFAULT_MIN_STEPS) {
    return trimPlan(numbered);
  }

  // Bulleted lines: "- foo", "* foo"
  const bulleted = [];
  for (const line of lines) {
    const m = line.match(/^[-*•]\s+(.+)$/);
    if (m) bulleted.push(m[1].trim());
  }
  if (bulleted.length >= DEFAULT_MIN_STEPS) {
    return trimPlan(bulleted);
  }

  return null;
}

function trimPlan(steps) {
  // Trim each step to a reasonable length; cap total step count
  const trimmed = steps
    .map(s => s.length > 200 ? s.slice(0, 200) + '…' : s)
    .slice(0, DEFAULT_MAX_STEPS);
  return trimmed;
}

/**
 * State for an active plan during a single agent run.
 * One instance per runAgentLoop invocation.
 */
class PlanTracker {
  constructor() {
    this.plan = null;            // string[] of steps
    this.currentStep = 0;        // 0-indexed
    this.completedSteps = new Set();
    this.shouldInject = false;
  }

  /** Activate plan mode for this run. Caller decides via shouldPlan(). */
  activate() {
    this.shouldInject = true;
  }

  /** Returns true if plan-mode is on but no plan extracted yet. */
  needsPlan() {
    return this.shouldInject && !this.plan;
  }

  /** Try to extract a plan from a model response. Returns true on success. */
  ingestResponse(text) {
    if (!this.shouldInject || this.plan) return false;
    const parsed = parsePlan(text);
    if (parsed && parsed.length >= DEFAULT_MIN_STEPS) {
      this.plan = parsed;
      this.currentStep = 0;
      return true;
    }
    return false;
  }

  /**
   * Async version of ingestResponse using MarrowScript Feature #3 (extract_plan).
   * Tries the compiled LLM extractor first — handles plans embedded in prose.
   * Falls back to the regex parsePlan() on failure.
   */
  async ingestResponseAsync(text) {
    if (!this.shouldInject || this.plan) return false;
    // Try LLM extractor first
    try {
      const { extractPlanSteps } = require('../bin/features_adapter');
      const steps = await extractPlanSteps(text);
      if (steps && steps.length >= DEFAULT_MIN_STEPS) {
        this.plan = steps.slice(0, DEFAULT_MAX_STEPS);
        this.currentStep = 0;
        return true;
      }
    } catch {}
    // Fallback to regex
    return this.ingestResponse(text);
  }

  /** Mark step N (0-indexed) as complete. */
  completeStep(n) {
    if (n >= 0 && n < (this.plan?.length || 0)) {
      this.completedSteps.add(n);
      // Advance currentStep past completed
      while (this.completedSteps.has(this.currentStep)) this.currentStep++;
    }
  }

  /** Heuristic auto-advance: when we see a successful tool result we move on. */
  notifyToolSuccess() {
    if (!this.plan) return;
    if (this.currentStep < this.plan.length) {
      // Don't auto-advance — let the model explicitly mark completion via
      // completeStep(). Auto-advance leads to drift in long traces.
    }
  }

  /** Render the plan as a system-prompt fragment. Returns '' if no plan. */
  formatForPrompt() {
    if (!this.plan || this.plan.length === 0) return '';
    const total = this.plan.length;
    const allDone = this.completedSteps.size >= total;
    const cur = allDone ? total : Math.min(this.currentStep + 1, total);
    let out = allDone
      ? `\n\nCOMPLETED PLAN (all ${total} steps done):`
      : `\n\nACTIVE PLAN (step ${cur} of ${total}):`;
    for (let i = 0; i < this.plan.length; i++) {
      let mark;
      if (this.completedSteps.has(i)) mark = '✓';
      else if (!allDone && i === this.currentStep) mark = '→';
      else mark = ' ';
      out += `\n${mark} ${i + 1}. ${this.plan[i]}`;
    }
    if (!allDone) {
      out += `\n\nWork on the current step (→). When done, mention "step ${cur} done" or move on naturally.`;
    }
    return out;
  }

  /** The instruction we inject when asking the model to produce a plan. */
  static planRequestInstruction() {
    return `\n\nThis is a multi-step task. Before any tool calls, briefly emit a numbered plan in this format:\n\nPLAN:\n1. <first step>\n2. <second step>\n3. <third step>\n\nKeep it to ${DEFAULT_MAX_STEPS} steps or fewer.\n\nIMPORTANT: After the plan, IMMEDIATELY start executing step 1 with the appropriate tool call. Do NOT stop after writing the plan — the plan is just a header for your work, not the work itself. The user expects you to actually do all the steps.`;
  }

  reset() {
    this.plan = null;
    this.currentStep = 0;
    this.completedSteps.clear();
    this.shouldInject = false;
  }

  serialize() {
    return {
      plan: this.plan,
      currentStep: this.currentStep,
      completedSteps: [...this.completedSteps],
      shouldInject: this.shouldInject,
    };
  }
}

module.exports = {
  shouldPlan,
  parsePlan,
  PlanTracker,
  DEFAULT_MIN_STEPS,
  DEFAULT_MAX_STEPS,
};
