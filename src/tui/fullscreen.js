// SmallCode — Full-Screen TUI Runtime
// Zero-dependency alternate-buffer terminal UI
// Uses raw ANSI escape sequences for full terminal control
//
// How it works (same technique as OpenCode/Bubble Tea/vim):
// 1. Enter alternate screen buffer (\x1b[?1049h)
// 2. Enable raw mode (keypresses come in as raw bytes)
// 3. Maintain a virtual framebuffer (2D array of cells)
// 4. On each render, diff the framebuffer and write only changed cells
// 5. On exit, restore the original terminal (\x1b[?1049l)

const readline = require('readline');
const { TerminalController } = require('./terminal.js');

const { visualWidth, visualLength, fitAnsi, stripAnsi } = require('./utils');


// Split string into visual lines, each no wider than maxVisualWidth.
function visualWrap(str, maxVisualWidth) {
  if (str.length === 0) return [''];
  const lines = [];
  let current = '';
  let curWidth = 0;
  for (const ch of str) {
    const w = visualWidth(ch);
    if (curWidth + w > maxVisualWidth) {
      lines.push(current);
      current = ch;
      curWidth = w;
    } else {
      current += ch;
      curWidth += w;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

// Compute cursor visual (line, col) from character index into str.
function visualCursorPosition(str, cursorIdx, maxVisualWidth) {
  let line = 0;
  let col = 0;
  let charIdx = 0;
  for (const ch of str) {
    if (charIdx >= cursorIdx) break;
    const w = visualWidth(ch);
    if (col + w > maxVisualWidth) {
      line++;
      col = 0;
    }
    col += w;
    charIdx++;
  }
  return { line, col };
}

// ─── ANSI Escape Sequences ───────────────────────────────────────────────────

const ESC = '\x1b[';
const ANSI = {
  // Screen buffer
  enterAlt: '\x1b[?1049h',
  leaveAlt: '\x1b[?1049l',
  // Cursor
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  moveTo: (row, col) => `${ESC}${row};${col}H`,
  // Erase
  clearScreen: `${ESC}2J`,
  clearLine: `${ESC}2K`,
  // Scroll region
  setScrollRegion: (top, bottom) => `${ESC}${top};${bottom}r`,
  resetScrollRegion: `${ESC}r`,
  // Style
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  italic: `${ESC}3m`,
  underline: `${ESC}4m`,
  inverse: `${ESC}7m`,
  // Colors (256-color)
  fg: (n) => `${ESC}38;5;${n}m`,
  bg: (n) => `${ESC}48;5;${n}m`,
  // Named colors
  fgRgb: (r, g, b) => `${ESC}38;2;${r};${g};${b}m`,
  bgRgb: (r, g, b) => `${ESC}48;2;${r};${g};${b}m`,
};

// ─── Theme ───────────────────────────────────────────────────────────────────

const THEMES = {
  dark: {
    bg: ANSI.bgRgb(15, 15, 15),
    fg: ANSI.fgRgb(190, 190, 195),
    accent: ANSI.fgRgb(180, 180, 185),
    muted: ANSI.fgRgb(90, 90, 100),
    success: ANSI.fgRgb(140, 200, 140),
    error: ANSI.fgRgb(220, 90, 90),
    warning: ANSI.fgRgb(220, 180, 80),
    border: ANSI.fgRgb(50, 50, 55),
    statusBg: ANSI.bgRgb(20, 20, 22),
    inputBg: ANSI.bgRgb(18, 18, 20),
    brand: ANSI.fgRgb(220, 220, 225),       // bright silver for logo
    brandDim: ANSI.fgRgb(120, 120, 130),    // dimmer silver
    cmdHighlight: ANSI.fgRgb(160, 140, 200), // subtle purple for commands
  },
  light: {
    bg: ANSI.bgRgb(250, 250, 252),
    fg: ANSI.fgRgb(30, 30, 40),
    accent: ANSI.fgRgb(60, 60, 70),
    muted: ANSI.fgRgb(140, 140, 160),
    success: ANSI.fgRgb(20, 160, 60),
    error: ANSI.fgRgb(200, 40, 40),
    warning: ANSI.fgRgb(180, 130, 0),
    border: ANSI.fgRgb(200, 200, 210),
    statusBg: ANSI.bgRgb(235, 235, 240),
    inputBg: ANSI.bgRgb(245, 245, 248),
    brand: ANSI.fgRgb(40, 40, 50),
    brandDim: ANSI.fgRgb(120, 120, 130),
    cmdHighlight: ANSI.fgRgb(100, 80, 160),
  },
  minimal: {
    bg: '',
    fg: '',
    accent: ANSI.fg(250),
    muted: ANSI.fg(242),
    success: ANSI.fg(78),
    error: ANSI.fg(196),
    warning: ANSI.fg(214),
    border: ANSI.fg(236),
    statusBg: ANSI.bg(233),
    inputBg: ANSI.bg(234),
    brand: ANSI.fg(255),
    brandDim: ANSI.fg(245),
    cmdHighlight: ANSI.fg(141),
  },
};

// ─── Box Drawing ─────────────────────────────────────────────────────────────

const BOX = {
  topLeft: '┌', topRight: '┐',
  bottomLeft: '└', bottomRight: '┘',
  horizontal: '─', vertical: '│',
  teeLeft: '├', teeRight: '┤',
  teeTop: '┬', teeBottom: '┴',
  cross: '┼',
  // Rounded
  rTopLeft: '╭', rTopRight: '╮',
  rBottomLeft: '╰', rBottomRight: '╯',
};

// ─── Full-Screen TUI Class ───────────────────────────────────────────────────

class FullScreenTUI {
  constructor(options = {}) {
    this.theme = THEMES[options.theme || 'dark'];
    this.showDetailPanel = options.showDetailPanel !== false;
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;

    // Single chronological, ephemeral UI event stream. Conversation history
    // remains owned by the agent loop; these events exist only for rendering.
    this.events = [];
    this._nextEventSeq = 1;
    this._activeThinkingEvent = null;
    this._activeAssistantEvent = null;
    this.inputBuffer = '';       // Current user input
    this.inputCursor = 0;       // Cursor position in input
    this.chatScroll = 0;        // Scroll offset for chat
    this.inputHistory = [];     // Command history
    this.historyIdx = -1;

    // Command palette
    this.commandPaletteOpen = false;
    this.commandPaletteSelection = 0;
    this._paletteScrollOffset = 0;
    this.completionProviders = Array.isArray(options.completionProviders) ? options.completionProviders : [];
    this.completion = null; // { provider, start, query, items, selection, scrollOffset }
    this._completionRequestId = 0;
    this.picker = null; // Generic modal selection picker
    this.commands = [
      { cmd: '/quit', alias: '/q', desc: 'Exit SmallCode' },
      { cmd: '/clear', alias: null, desc: 'Reset conversation' },
      { cmd: '/model', alias: null, desc: 'Show/switch model' },
      { cmd: '/endpoint', alias: null, desc: 'Switch API endpoint' },
      { cmd: '/stats', alias: null, desc: 'Session statistics' },
      { cmd: '/tokens', alias: null, desc: 'Token usage report' },
      { cmd: '/budget', alias: null, desc: 'Context window budget' },
      { cmd: '/think', alias: null, desc: 'Choose thinking preset' },
      { cmd: '/files', alias: null, desc: 'List project files' },
      { cmd: '/diff', alias: null, desc: 'Git diff summary' },
      { cmd: '/git', alias: null, desc: 'Run git command' },
      { cmd: '/loop', alias: null, desc: 'Validate + auto-fix file' },
      { cmd: '/memory', alias: null, desc: 'View project memory' },
      { cmd: '/trace', alias: null, desc: 'View execution traces' },
      { cmd: '/eval', alias: null, desc: 'Run prompt evaluation' },
      { cmd: '/escalation', alias: null, desc: 'Model escalation status' },
      { cmd: '/profile', alias: null, desc: 'Model profile + routing' },
      { cmd: '/cognition', alias: null, desc: 'MarrowScript cognition status' },
      { cmd: '/mcp', alias: null, desc: 'Connected MCP servers' },
      { cmd: '/skill', alias: null, desc: 'Manage reusable skills' },
      { cmd: '/plugin', alias: null, desc: 'Manage plugins' },
      { cmd: '/sessions', alias: null, desc: 'List/resume sessions' },
      { cmd: '/session', alias: null, desc: 'Parallel sessions' },
      { cmd: '/share', alias: null, desc: 'Export session' },
      { cmd: '/undo', alias: null, desc: 'Revert last edit' },
      { cmd: '/compact', alias: null, desc: 'Trim conversation history' },
      { cmd: '/help', alias: null, desc: 'Show all commands' },
      { cmd: '/version', alias: null, desc: 'Show SmallCode version' },
    ];

    // Layout dimensions (computed)
    this.statusHeight = 1;
    this.inputHeight = 3;
    this.chatHeight = 0;
    this.chatWidth = 0;
    this.toolWidth = 0;

    // State
    this.active = false;
    this.model = options.model || 'unknown';
    this.endpoint = options.endpoint || '';
    this.tokenCount = 0;
    this.msgCount = 0;
    this.isStreaming = false;
    this._modelStreaming = false;
    this._submitQueue = [];
    this._submitRunning = false;
    this.thinkingLevel = options.thinkingLevel || 'custom';
    this.showWelcome = true; // Show splash on first render

    // Callbacks
    this.onSubmit = options.onSubmit || (() => {});
    this.onCommand = options.onCommand || (() => {});
    this.onExit = options.onExit || (() => {});

    this._computeLayout();
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  enter() {
    this.active = true;

    // The TerminalController owns alt-buffer / raw-mode / mouse-tracking /
    // bracketed-paste setup and — critically — guarantees teardown on suspend
    // (Ctrl+Z), termination, and crashes (issue #71). On resume it redraws.
    if (!this._terminal) {
      this._terminal = new TerminalController({
        onResume: () => { this._computeLayout(); this.render(); },
      });
    }
    this._terminal.enter();

    // Store a direct reference to the real stdout.write (before any overrides)
    this._rawWrite = this._terminal.rawWrite;

    // Handle resize
    process.stdout.on('resize', () => this._onResize());

    // Handle raw keypresses
    process.stdin.on('data', (data) => this._onKeypress(data));

    this._computeLayout();
    this.render();
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    if (this._terminal) this._terminal.leave();
  }

  // ─── Layout ──────────────────────────────────────────────────────────

  _computeLayout() {
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;

    // Dynamic input height: grows with content (min 3, max 8 lines)
    const inputAvail = this.width - 5;
    const inputVisualLen = visualLength(this.inputBuffer);
    const wrappedLines = inputAvail > 0 ? Math.ceil(Math.max(1, inputVisualLen) / inputAvail) : 1;
    this.inputHeight = Math.min(8, Math.max(3, wrappedLines + 2)); // +2 for border + hint

    this.chatHeight = this.height - this.inputHeight - this.statusHeight;

    if (this.showDetailPanel && this.width > 120) {
      this.chatWidth = Math.floor(this.width * 0.65);
      this.toolWidth = this.width - this.chatWidth - 1;
    } else {
      this.chatWidth = this.width;
      this.toolWidth = 0;
    }
    if (this.events) {
      const maxBack = -(Math.max(0, this._scrollableLines().length - this.chatHeight));
      this.chatScroll = Math.max(maxBack, Math.min(0, this.chatScroll));
    }
  }

  // ─── Rendering ─────────────────────────────────────────────────────

  render() {
    if (!this.active) return;
    this._computeLayout(); // Recalculate in case input grew/shrunk

    let buf = '';

    // Clear
    buf += ANSI.clearScreen + ANSI.moveTo(1, 1);

    // Wide mode: conversation/THINK/DIFF is primary; technical activity is right.
    // Narrow mode: retain the full-width activity stream.
    if (this.toolWidth > 0) {
      const hasPrimaryEvents = this.events.some(event => ['user', 'assistant', 'thinking', 'diff'].includes(event.type));
      buf += this.showWelcome && !hasPrimaryEvents ? this._renderWelcomeScreen() : this._renderDetailPanel();
      buf += this._renderActivityPanel();
    } else {
      buf += this._renderChatPanel();
    }

    // Input area
    buf += this._renderInput();

    // Status bar
    buf += this._renderStatus();

    // Position cursor in wrapped input (visual-width-aware)
    const inputAvail = this.width - 5;
    const pos = visualCursorPosition(this.inputBuffer, this.inputCursor, inputAvail);
    const inputRow = this.chatHeight + 2 + pos.line; // +1 border, +1 for 1-index
    const inputCol = 5 + pos.col; // "│ > " prefix
    buf += ANSI.moveTo(inputRow, inputCol) + ANSI.showCursor;

    this._rawWrite(buf);
  }

  _renderChatPanel() {
    let buf = '';

    // Show welcome splash when no messages yet
    if (this.showWelcome && this.events.length === 0) {
      return this._renderWelcomeScreen();
    }

    const chatLines = this._formatEvents(
      this.events.filter(event => ['user', 'assistant', 'system', 'tool'].includes(event.type)),
      this.chatWidth,
    );
    const startLine = Math.max(0, chatLines.length - this.chatHeight + this.chatScroll);
    const endLine = startLine + this.chatHeight;
    const visible = chatLines.slice(startLine, endLine);

    for (let i = 0; i < this.chatHeight; i++) {
      buf += ANSI.moveTo(i + 1, 1);
      const line = visible[i] || '';
      buf += fitAnsi(line, this.chatWidth);
    }

    return buf;
  }

  _renderWelcomeScreen() {
    let buf = '';
    const w = this.chatWidth;
    const h = this.chatHeight;
    const t = this.theme;

    let version = 'unknown';
    try { version = require('../../package.json').version; } catch {}
    const cwd = process.cwd();

    const cardWidth = Math.max(10, Math.min(w - 4, 76));
    const padLeft = Math.max(0, Math.floor((w - cardWidth) / 2));
    const pl = ' '.repeat(padLeft);

    const bannerRow = Math.max(2, Math.floor(h * 0.25));

    if (w < 20) {
      buf += ANSI.moveTo(bannerRow, 1);
      buf += fitAnsi(' SmallCode TUI', w);
      return buf;
    }

    if (cardWidth < 45) {
      // Extremely compact version for narrow terminals
      buf += ANSI.moveTo(bannerRow, 1);
      buf += pl + t.border + BOX.rTopLeft + BOX.horizontal.repeat(Math.max(0, cardWidth - 2)) + BOX.rTopRight + ANSI.reset;

      buf += ANSI.moveTo(bannerRow + 1, 1);
      const title = fitAnsi(` SmallCode v${version}`, cardWidth - 2);
      buf += pl + t.border + BOX.vertical + ANSI.reset + t.brand + title + t.border + BOX.vertical + ANSI.reset;

      buf += ANSI.moveTo(bannerRow + 2, 1);
      const model = fitAnsi(` Model: ${this.model}`, cardWidth - 2);
      buf += pl + t.border + BOX.vertical + ANSI.reset + t.accent + model + t.border + BOX.vertical + ANSI.reset;

      buf += ANSI.moveTo(bannerRow + 3, 1);
      const ep = fitAnsi(` Endpoint: ${this.endpoint || 'http://localhost:11434'}`, cardWidth - 2, { ellipsis: true });
      buf += pl + t.border + BOX.vertical + ANSI.reset + t.muted + ep + t.border + BOX.vertical + ANSI.reset;

      buf += ANSI.moveTo(bannerRow + 4, 1);
      const hints = fitAnsi(` Hints: /help /quit /model /memory`, cardWidth - 2);
      buf += pl + t.border + BOX.vertical + ANSI.reset + t.muted + hints + t.border + BOX.vertical + ANSI.reset;

      buf += ANSI.moveTo(bannerRow + 5, 1);
      const hints2 = fitAnsi(`        /skill /diff /loop /mcp`, cardWidth - 2);
      buf += pl + t.border + BOX.vertical + ANSI.reset + t.muted + hints2 + t.border + BOX.vertical + ANSI.reset;

      buf += ANSI.moveTo(bannerRow + 6, 1);
      buf += pl + t.border + BOX.rBottomLeft + BOX.horizontal.repeat(Math.max(0, cardWidth - 2)) + BOX.rBottomRight + ANSI.reset;
    } else {
      // Sleek grid layout
      buf += ANSI.moveTo(bannerRow, 1);
      buf += pl + t.border + BOX.rTopLeft + BOX.horizontal.repeat(Math.max(0, cardWidth - 2)) + BOX.rTopRight + ANSI.reset;

      buf += ANSI.moveTo(bannerRow + 1, 1);
      const titlePart = ` ⚡ SmallCode v${version} `;
      const modelPart = ` Model: ${this.model} `;

      const titleLen = Math.max(0, Math.floor(cardWidth * 0.45));
      const modelLen = Math.max(0, cardWidth - 2 - titleLen - 1); // minus divider
      const col1 = fitAnsi(titlePart, titleLen);
      const col2 = fitAnsi(modelPart, modelLen, { align: 'right' });
      const contentRow1 = `${t.brand}${col1}${t.muted}│${t.accent}${col2}`;
      buf += pl + t.border + BOX.vertical + ANSI.reset + contentRow1 + t.border + BOX.vertical + ANSI.reset;

      buf += ANSI.moveTo(bannerRow + 2, 1);
      buf += pl + t.border + BOX.teeLeft + BOX.horizontal.repeat(Math.max(0, cardWidth - 2)) + BOX.teeRight + ANSI.reset;

      buf += ANSI.moveTo(bannerRow + 3, 1);
      const epPart = ` Endpoint: ${this.endpoint || 'http://localhost:11434'}`;
      const contentRowEp = ` ${t.muted}${fitAnsi(epPart, cardWidth - 4, { ellipsis: true })} `;
      buf += pl + t.border + BOX.vertical + ANSI.reset + contentRowEp + t.border + BOX.vertical + ANSI.reset;

      buf += ANSI.moveTo(bannerRow + 4, 1);
      const dirPart = ` Cwd: ${cwd}`;
      const contentRow2 = ` ${t.fg}${fitAnsi(dirPart, cardWidth - 4, { ellipsis: true })} `;
      buf += pl + t.border + BOX.vertical + ANSI.reset + contentRow2 + t.border + BOX.vertical + ANSI.reset;

      buf += ANSI.moveTo(bannerRow + 5, 1);
      buf += pl + t.border + BOX.teeLeft + BOX.horizontal.repeat(Math.max(0, cardWidth - 2)) + BOX.teeRight + ANSI.reset;

      buf += ANSI.moveTo(bannerRow + 6, 1);
      const hintPart = ` Hints: /help list  │  /model switch  │  /quit exit  │  /mcp servers`;
      const contentRow3 = ` ${t.muted}${fitAnsi(hintPart, cardWidth - 4)} `;
      buf += pl + t.border + BOX.vertical + ANSI.reset + contentRow3 + t.border + BOX.vertical + ANSI.reset;

      buf += ANSI.moveTo(bannerRow + 7, 1);
      const hintPart2 = `        /memory project memory  │  /skill manage skills  │  /diff git diff`;
      const contentRow4 = ` ${t.muted}${fitAnsi(hintPart2, cardWidth - 4)} `;
      buf += pl + t.border + BOX.vertical + ANSI.reset + contentRow4 + t.border + BOX.vertical + ANSI.reset;

      buf += ANSI.moveTo(bannerRow + 8, 1);
      buf += pl + t.border + BOX.rBottomLeft + BOX.horizontal.repeat(Math.max(0, cardWidth - 2)) + BOX.rBottomRight + ANSI.reset;
    }


    return buf;
  }

  _renderDetailPanel() {
    if (this.toolWidth <= 0) return '';
    let buf = '';

    const detailLines = this._formatEvents(
      this.events.filter(event => ['user', 'assistant', 'thinking', 'diff'].includes(event.type)),
      this.chatWidth,
    );
    const startLine = Math.max(0, detailLines.length - this.chatHeight + this.chatScroll);
    const visible = detailLines.slice(startLine, startLine + this.chatHeight);

    for (let i = 0; i < this.chatHeight; i++) {
      buf += ANSI.moveTo(i + 1, 1);
      const line = visible[i] || '';
      buf += fitAnsi(line, this.chatWidth);
    }

    return buf;
  }

  _renderActivityPanel() {
    if (this.toolWidth <= 0) return '';
    let buf = '';
    const col = this.chatWidth + 1;
    for (let i = 0; i < this.chatHeight; i++) {
      buf += ANSI.moveTo(i + 1, col);
      buf += this.theme.border + BOX.vertical + ANSI.reset;
    }
    const activityLines = this._formatEvents(
      this.events.filter(event => ['system', 'tool'].includes(event.type)),
      this.toolWidth - 1,
    );
    const startLine = Math.max(0, activityLines.length - this.chatHeight);
    const visible = activityLines.slice(startLine, startLine + this.chatHeight);
    for (let i = 0; i < this.chatHeight; i++) {
      buf += ANSI.moveTo(i + 1, col + 1);
      buf += fitAnsi(visible[i] || '', this.toolWidth - 1);
    }
    return buf;
  }

  _scrollableLines() {
    const types = this.toolWidth > 0
      ? ['user', 'assistant', 'thinking', 'diff']
      : ['user', 'assistant', 'system', 'tool'];
    return this._formatEvents(
      this.events.filter(event => types.includes(event.type)),
      this.chatWidth,
    );
  }

  _formatEvents(events, panelWidth) {
    const width = Math.max(1, panelWidth - 3);
    const lines = [];
    const compactLine = raw => {
      const value = String(raw || '');
      const limit = Math.max(240, width * 4);
      return value.length > limit ? value.slice(0, limit - 1) + '…' : value;
    };
    for (const event of events) {
      if (event.type === 'user' || event.type === 'assistant' || event.type === 'system') {
        lines.push(...this._formatMessageEvent(event, panelWidth));
      } else if (event.type === 'tool') {
        let icon = '⚙';
        let iconColor = this.theme.accent;
        if (event.status === 'ok') { icon = '✓'; iconColor = this.theme.success; }
        else if (event.status === 'err') { icon = '✗'; iconColor = this.theme.error; }
        const name = event.name ? `${this.theme.accent}${event.name}${ANSI.reset}: ` : '';
        const nameWidth = event.name ? event.name.length + 2 : 0;
        const wrapped = this._wordWrap(String(event.detail || ''), Math.max(1, panelWidth - nameWidth - 4));
        for (let i = 0; i < wrapped.length; i++) {
          const prefix = i === 0 ? ` ${iconColor}${icon}${ANSI.reset} ${name}` : '   ';
          lines.push(prefix + this.theme.muted + wrapped[i] + ANSI.reset);
        }
        lines.push('');
      } else if (event.type === 'thinking') {
        lines.push(` ${this.theme.cmdHighlight}THINK${ANSI.reset}`);
        const rawLines = String(event.text || '').split('\n');
        for (const raw of rawLines) {
          for (const wrapped of visualWrap(compactLine(raw), width)) {
            lines.push(` ${this.theme.muted}${wrapped}${ANSI.reset}`);
          }
        }
      } else if (event.type === 'diff') {
        const location = event.lineNum ? `${event.path}:${event.lineNum}` : event.path;
        lines.push(` ${this.theme.accent}DIFF${ANSI.reset} ${this.theme.fg}${location}${ANSI.reset}`);
        const allOldLines = event.oldStr ? String(event.oldStr).split('\n') : [];
        const allNewLines = event.newStr ? String(event.newStr).split('\n') : [];
        const oldLines = allOldLines.slice(0, 8);
        const newLines = allNewLines.slice(0, 8);
        for (const raw of oldLines) {
          for (const wrapped of visualWrap(compactLine(`- ${raw}`), width)) lines.push(` ${this.theme.error}${wrapped}${ANSI.reset}`);
        }
        for (const raw of newLines) {
          for (const wrapped of visualWrap(compactLine(`+ ${raw}`), width)) lines.push(` ${this.theme.success}${wrapped}${ANSI.reset}`);
        }
        const hiddenOld = Math.max(0, allOldLines.length - oldLines.length);
        const hiddenNew = Math.max(0, allNewLines.length - newLines.length);
        if (hiddenOld + hiddenNew > 0) lines.push(` ${this.theme.muted}… ${hiddenOld + hiddenNew} more lines${ANSI.reset}`);
      }
      lines.push('');
    }
    return lines;
  }

  _formatMessageEvent(event, panelWidth) {
    let prefix;
    if (event.type === 'user') prefix = this.theme.accent + '  USER  ' + this.theme.border + '│ ' + ANSI.reset;
    else if (event.type === 'assistant') prefix = this.theme.success + '   AI   ' + this.theme.border + '│ ' + ANSI.reset;
    else prefix = this.theme.muted + '  SYS   ' + this.theme.border + '│ ' + ANSI.reset;
    const contPrefix = '        ' + this.theme.border + '│ ' + ANSI.reset;
    const output = [];
    const rawLines = String(event.content || '').split('\n');
    let inCodeBlock = false;
    const maxWidth = Math.max(1, panelWidth - 10);
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        if (inCodeBlock) output.push((i === 0 ? prefix : contPrefix) + this.theme.border + '┌─ ' + this.theme.muted + line.trim().slice(3) + ANSI.reset);
        else output.push(contPrefix + this.theme.border + '└─' + ANSI.reset);
        continue;
      }
      if (inCodeBlock) {
        output.push(contPrefix + this.theme.border + '│ ' + ANSI.reset + this._highlightCode(line));
        continue;
      }
      const wrapped = this._wordWrap(line, maxWidth);
      for (let j = 0; j < wrapped.length; j++) output.push((i === 0 && j === 0 ? prefix : contPrefix) + wrapped[j]);
    }
    output.push('');
    return output;
  }

  _renderInput() {
    let buf = '';
    const row = this.chatHeight + 1;
    const t = this.theme;

    // Command palette (floating above input when typing a slash command)
    if (this.picker) {
      buf += this._renderPicker(row);
    } else if (this.commandPaletteOpen) {
      buf += this._renderCommandPalette(row);
    } else if (this.completion) {
      buf += this._renderCompletionPalette(row);
    }

    // Thin separator line
    buf += ANSI.moveTo(row, 1);
    buf += t.border + BOX.horizontal.repeat(this.width) + ANSI.reset;

    // Input area — wraps vertically for long text
    const inputAvail = this.width - 5; // "│ > " prefix / "│   " continuation
    const inputLines = visualWrap(this.inputBuffer, inputAvail);

    // Render each wrapped line
    for (let i = 0; i < inputLines.length && i < 6; i++) {
      buf += ANSI.moveTo(row + 1 + i, 1);
      buf += t.inputBg + t.border + BOX.vertical + ANSI.reset + t.inputBg;
      if (i === 0) {
        buf += t.muted + ' > ' + ANSI.reset + t.inputBg + t.fg;
      } else {
        buf += '   ' + t.inputBg + t.fg;
      }
      buf += inputLines[i];
      const lineVisualLen = visualLength(inputLines[i]);
      buf += ' '.repeat(Math.max(0, inputAvail - lineVisualLen));
      buf += ANSI.reset;
    }

    // Clear remaining input area lines
    for (let i = inputLines.length; i < this.inputHeight - 2; i++) {
      buf += ANSI.moveTo(row + 1 + i, 1);
      buf += ' '.repeat(this.width);
    }

    // Hint line
    const hintRow = row + this.inputHeight - 1;
    buf += ANSI.moveTo(hintRow, 1);
    if (this.picker) {
      buf += t.muted + '  ↑↓ navigate  enter select  esc cancel' + ANSI.reset;
    } else if (this.commandPaletteOpen) {
      buf += t.muted + '  ↑↓ navigate  enter select  esc cancel' + ANSI.reset;
    } else if (this.completion) {
      buf += t.muted + '  ↑↓ navigate  enter/tab select  esc cancel' + ANSI.reset;
    } else if (inputLines.length > 1) {
      buf += t.muted + `  ${this.inputBuffer.length} chars` + ANSI.reset;
    } else {
      buf += t.muted + '' + ANSI.reset;
    }

    return buf;
  }

  _renderCommandPalette(inputRow) {
    let buf = '';
    const filter = this.inputBuffer.slice(1).toLowerCase(); // Remove leading /
    const filtered = this.commands.filter(c =>
      c.cmd.slice(1).startsWith(filter) || (c.alias && c.alias.slice(1).startsWith(filter))
    );

    // Keep layout stable: fixed 8 visible rows
    const availableRows = inputRow - 3;
    const maxVisible = Math.max(1, Math.min(8, availableRows));
    this._paletteMaxVisible = maxVisible;

    // Clamp selection
    if (filtered.length > 0) {
      this.commandPaletteSelection = Math.max(0, Math.min(this.commandPaletteSelection, filtered.length - 1));
    } else {
      this.commandPaletteSelection = 0;
    }

    // Keep scroll offset in sync
    if (this.commandPaletteSelection < this._paletteScrollOffset) {
      this._paletteScrollOffset = this.commandPaletteSelection;
    } else if (this.commandPaletteSelection >= this._paletteScrollOffset + maxVisible) {
      this._paletteScrollOffset = this.commandPaletteSelection - maxVisible + 1;
    }
    const maxOffset = Math.max(0, filtered.length - maxVisible);
    this._paletteScrollOffset = Math.max(0, Math.min(this._paletteScrollOffset, maxOffset));

    const paletteWidth = Math.max(20, Math.min(this.width - 4, 60));
    const startRow = inputRow - maxVisible - 1;

    // Draw top border with result count (e.g. [5 of 12])
    buf += ANSI.moveTo(startRow, 2);
    const countLabel = filtered.length > 0
      ? `  ${this.commandPaletteSelection + 1}/${filtered.length}  `
      : '  0/0  ';
    const topLabel = ` Commands ${countLabel}`;
    const topFill = paletteWidth - 2 - topLabel.length;
    buf += this.theme.border + BOX.rTopLeft + this.theme.accent + topLabel + this.theme.border + BOX.horizontal.repeat(Math.max(0, topFill)) + BOX.rTopRight + ANSI.reset;

    // Render fixed maxVisible rows
    for (let i = 0; i < maxVisible; i++) {
      const row = startRow + 1 + i;
      buf += ANSI.moveTo(row, 2);
      buf += this.theme.border + BOX.vertical + ANSI.reset;

      const itemIdx = i + this._paletteScrollOffset;
      if (itemIdx < filtered.length) {
        const cmd = filtered[itemIdx];
        const isSelected = itemIdx === this.commandPaletteSelection;

        // Columns: Command (width 16) | Divider (width 3) | Description
        const CMD_COL_WIDTH = 16;
        const descWidth = Math.max(1, paletteWidth - 2 - 1 - CMD_COL_WIDTH - 3);

        const cmdText = cmd.cmd + (cmd.alias ? ` (${cmd.alias})` : '');
        const col1 = fitAnsi(cmdText, CMD_COL_WIDTH);
        const col2 = fitAnsi(cmd.desc, descWidth);

        // Row highlighting with premium contrast
        let rowContent = '';
        if (isSelected) {
          rowContent = ANSI.inverse + this.theme.cmdHighlight + ' ' + col1 + ANSI.reset + ANSI.inverse + this.theme.border + ' │ ' + ANSI.reset + ANSI.inverse + this.theme.accent + col2 + ANSI.reset;
        } else {
          rowContent = ' ' + this.theme.cmdHighlight + col1 + ANSI.reset + this.theme.border + ' │ ' + ANSI.reset + this.theme.fg + col2 + ANSI.reset;
        }

        buf += rowContent;
      } else {
        // Pad empty rows to keep the palette height fixed
        buf += ' '.repeat(Math.max(0, paletteWidth - 2));
      }

      buf += this.theme.border + BOX.vertical + ANSI.reset;
    }

    // Bottom border
    buf += ANSI.moveTo(startRow + maxVisible + 1, 2);
    buf += this.theme.border + BOX.rBottomLeft + BOX.horizontal.repeat(Math.max(0, paletteWidth - 2)) + BOX.rBottomRight + ANSI.reset;

    return buf;
  }

  _renderCompletionPalette(inputRow) {
    const state = this.completion;
    if (!state) return '';

    const items = state.items || [];
    const availableRows = inputRow - 3;
    const maxVisible = Math.max(1, Math.min(8, availableRows));
    state.maxVisible = maxVisible;
    state.selection = items.length > 0
      ? Math.max(0, Math.min(state.selection || 0, items.length - 1))
      : 0;
    state.scrollOffset = Math.max(0, state.scrollOffset || 0);
    if (state.selection < state.scrollOffset) state.scrollOffset = state.selection;
    if (state.selection >= state.scrollOffset + maxVisible) {
      state.scrollOffset = state.selection - maxVisible + 1;
    }
    state.scrollOffset = Math.min(state.scrollOffset, Math.max(0, items.length - maxVisible));

    const paletteWidth = Math.max(20, Math.min(this.width - 4, 70));
    const startRow = inputRow - maxVisible - 1;
    const countLabel = items.length > 0 ? `  ${state.selection + 1}/${items.length}  ` : '  0/0  ';
    const title = ` ${state.provider.title || 'Suggestions'} ${countLabel}`;
    let buf = ANSI.moveTo(startRow, 2);
    buf += this.theme.border + BOX.rTopLeft + this.theme.accent + title
      + this.theme.border + BOX.horizontal.repeat(Math.max(0, paletteWidth - 2 - title.length))
      + BOX.rTopRight + ANSI.reset;

    for (let i = 0; i < maxVisible; i++) {
      const row = startRow + 1 + i;
      const item = items[state.scrollOffset + i];
      buf += ANSI.moveTo(row, 2) + this.theme.border + BOX.vertical + ANSI.reset;
      if (item) {
        const selected = state.scrollOffset + i === state.selection;
        const detailWidth = 10;
        const labelWidth = Math.max(1, paletteWidth - detailWidth - 6);
        const label = fitAnsi(item.label || item.value || '', labelWidth);
        const detail = fitAnsi(item.detail || '', detailWidth);
        const content = ` ${label} │ ${detail}`;
        buf += selected
          ? ANSI.inverse + this.theme.cmdHighlight + content + ANSI.reset
          : this.theme.fg + content + ANSI.reset;
      } else {
        buf += ' '.repeat(Math.max(0, paletteWidth - 2));
      }
      buf += this.theme.border + BOX.vertical + ANSI.reset;
    }

    buf += ANSI.moveTo(startRow + maxVisible + 1, 2)
      + this.theme.border + BOX.rBottomLeft
      + BOX.horizontal.repeat(Math.max(0, paletteWidth - 2))
      + BOX.rBottomRight + ANSI.reset;
    return buf;
  }

  _renderPicker(inputRow) {
    const state = this.picker;
    if (!state) return '';
    const items = state.items || [];
    const maxVisible = Math.max(1, Math.min(8, inputRow - 3, items.length || 1));
    state.selection = items.length > 0
      ? Math.max(0, Math.min(state.selection || 0, items.length - 1))
      : 0;
    state.scrollOffset = Math.max(0, state.scrollOffset || 0);
    if (state.selection < state.scrollOffset) state.scrollOffset = state.selection;
    if (state.selection >= state.scrollOffset + maxVisible) state.scrollOffset = state.selection - maxVisible + 1;

    const paletteWidth = Math.max(24, Math.min(this.width - 4, 72));
    const startRow = inputRow - maxVisible - 1;
    const title = ` ${state.title || 'Select'} `;
    let buf = ANSI.moveTo(startRow, 2);
    buf += this.theme.border + BOX.rTopLeft + this.theme.accent + title
      + this.theme.border + BOX.horizontal.repeat(Math.max(0, paletteWidth - 2 - title.length))
      + BOX.rTopRight + ANSI.reset;

    for (let i = 0; i < maxVisible; i++) {
      const row = startRow + 1 + i;
      const item = items[state.scrollOffset + i];
      buf += ANSI.moveTo(row, 2) + this.theme.border + BOX.vertical + ANSI.reset;
      if (item) {
        const selected = state.scrollOffset + i === state.selection;
        const labelWidth = 12;
        const detailWidth = Math.max(1, paletteWidth - labelWidth - 6);
        const content = ` ${fitAnsi(item.label || item.value || '', labelWidth)} │ ${fitAnsi(item.detail || '', detailWidth)}`;
        buf += selected
          ? ANSI.inverse + this.theme.cmdHighlight + content + ANSI.reset
          : this.theme.fg + content + ANSI.reset;
      } else {
        buf += ' '.repeat(Math.max(0, paletteWidth - 2));
      }
      buf += this.theme.border + BOX.vertical + ANSI.reset;
    }
    buf += ANSI.moveTo(startRow + maxVisible + 1, 2)
      + this.theme.border + BOX.rBottomLeft
      + BOX.horizontal.repeat(Math.max(0, paletteWidth - 2))
      + BOX.rBottomRight + ANSI.reset;
    return buf;
  }

  _closeCompletion() {
    this._completionRequestId++;
    this.completion = null;
  }

  _findCompletionContext() {
    const beforeCursor = this.inputBuffer.slice(0, this.inputCursor);
    let best = null;
    for (const provider of this.completionProviders) {
      if (!provider || typeof provider.trigger !== 'string' || typeof provider.complete !== 'function') continue;
      const start = beforeCursor.lastIndexOf(provider.trigger);
      if (start < 0) continue;
      const previous = start > 0 ? beforeCursor[start - 1] : '';
      const query = beforeCursor.slice(start + provider.trigger.length);
      if ((previous && !/\s/.test(previous)) || /\s/.test(query)) continue;
      if (!best || start > best.start) best = { provider, start, query };
    }
    return best;
  }

  async _refreshCompletion() {
    const requestId = ++this._completionRequestId;
    if (this.commandPaletteOpen) {
      this._closeCompletion();
      return;
    }
    const context = this._findCompletionContext();
    if (!context) {
      this._closeCompletion();
      return;
    }
    try {
      const result = await context.provider.complete({
        query: context.query,
        cwd: process.cwd(),
        input: this.inputBuffer,
        cursor: this.inputCursor,
        limit: 50,
      });
      if (requestId !== this._completionRequestId) return;
      const items = Array.isArray(result) ? result.filter(Boolean) : [];
      this.completion = {
        ...context,
        items,
        selection: 0,
        scrollOffset: 0,
      };
    } catch {
      this._closeCompletion();
    }
  }

  _selectCompletion() {
    const state = this.completion;
    const item = state?.items?.[state.selection || 0];
    if (!state || !item) return false;
    const value = String(item.value || item.label || '');
    const suffix = this.inputBuffer.slice(this.inputCursor);
    const separator = suffix.length === 0 || !/^\s/.test(suffix) ? ' ' : '';
    this.inputBuffer = this.inputBuffer.slice(0, state.start) + value + separator + suffix;
    this.inputCursor = state.start + value.length + separator.length;
    this._closeCompletion();
    return true;
  }

  _renderStatus() {
    let buf = '';
    const row = this.height;
    const t = this.theme;

    buf += ANSI.moveTo(row, 1);
    buf += t.statusBg;

    // 1. Left: Action/Status
    let actionStr;
    if (this.isStreaming) {
      actionStr = ' Streaming...';
    } else if (this.statusMsg) {
      actionStr = ` ${this.statusMsg}`;
    } else {
      actionStr = ' enter send │ /help commands';
    }

    // 2. Middle: Scroll & Token info
    let scrollStr = this.chatScroll < 0 ? '↑ scrolled' : '';
    let tokenStr = this.tokenInfo ? `${this.tokenInfo}` : '';
    let middleStr = '';
    if (scrollStr && tokenStr) {
      middleStr = `${scrollStr} │ ${tokenStr}`;
    } else {
      middleStr = scrollStr || tokenStr || '';
    }

    // 3. Right: Brand, Model, and Indicator
    const modelTrunc = this.model.length > 20 ? this.model.slice(0, 17) + '...' : this.model;
    const indicatorText = this.isStreaming ? '⟳ streaming' : '● idle';
    const statusIndicator = this.isStreaming
      ? t.success + '⟳ streaming' + t.brandDim
      : t.muted + '● idle' + t.brandDim;

    // Compute raw lengths to adjust layout
    let rawAction = this._stripAnsi(actionStr);
    let rawMiddle = this._stripAnsi(middleStr);

    // Dynamically adjust segments based on total terminal width
    const totalWidth = this.width;

    if (totalWidth < 45) {
      // Tiny terminal: only left and indicator
      const rightPart = ` ${indicatorText} `;
      const maxLeft = Math.max(0, totalWidth - rightPart.length);
      const leftPart = rawAction.length > maxLeft ? rawAction.slice(0, Math.max(0, maxLeft - 3)) + '...' : rawAction.padEnd(maxLeft);

      const leftColored = (this.isStreaming ? t.success : t.accent) + leftPart + t.brandDim;
      const rightColored = this.isStreaming ? t.success + rightPart : t.muted + rightPart;

      const lineBuf = leftColored + rightColored;
      buf += this._truncate(lineBuf, totalWidth) + ANSI.reset;
      return buf;
    }

    // Moderate/Large terminal: Left, Middle (if fits), and Right
    let showMiddle = true;
    const thinkingLabel = `think:${this.thinkingLevel}`;
    let rightLabel = `smallcode │ ${modelTrunc} │ ${thinkingLabel} │ `;
    let rawRight = rightLabel + indicatorText;

    if (totalWidth < 70) {
      // Medium terminal: drop "smallcode | " to save space
      rightLabel = `${modelTrunc} │ ${thinkingLabel} │ `;
      rawRight = rightLabel + indicatorText;
    }

    // Check if middle fits, otherwise drop it
    const leftSpace = rawAction.length;
    const rightSpace = rawRight.length;
    const remaining = totalWidth - leftSpace - rightSpace;

    if (remaining < rawMiddle.length + 2) {
      showMiddle = false;
      middleStr = '';
      rawMiddle = '';
    }

    const newRemaining = totalWidth - leftSpace - rawRight.length;
    let leftSpacing = 0;
    let rightSpacing = 0;

    if (showMiddle && newRemaining > rawMiddle.length) {
      const centerPos = Math.floor(totalWidth / 2);
      const startMiddle = centerPos - Math.floor(rawMiddle.length / 2);
      leftSpacing = startMiddle - leftSpace;
      rightSpacing = totalWidth - leftSpace - leftSpacing - rawMiddle.length - rawRight.length;
      if (leftSpacing < 1) {
        leftSpacing = 1;
        rightSpacing = newRemaining - rawMiddle.length - 1;
      }
    } else {
      leftSpacing = newRemaining;
      rightSpacing = 0;
    }

    const actionColored = this.isStreaming ? t.success + actionStr + t.brandDim : t.accent + actionStr + t.brandDim;
    const middleColored = scrollStr ? t.warning + middleStr + t.brandDim : t.muted + middleStr + t.brandDim;
    const rightColored = t.brandDim + (totalWidth < 70 ? '' : `smallcode │ `)
      + t.fg + modelTrunc + t.brandDim + ` │ ${thinkingLabel} │ ` + statusIndicator;

    let lineBuf = actionColored;
    lineBuf += ' '.repeat(Math.max(0, leftSpacing));
    if (showMiddle) {
      lineBuf += middleColored;
    }
    lineBuf += ' '.repeat(Math.max(0, rightSpacing));
    lineBuf += rightColored;

    buf += this._truncate(lineBuf, totalWidth) + ANSI.reset;

    return buf;
  }

  /** Set a transient status message shown in the status bar. Pass '' to clear. */
  setStatus(msg) {
    this.statusMsg = msg || '';
    this.render();
  }

  /** Open a reusable modal selection picker. */
  openPicker({ title, items, selected, onSelect, onCancel } = {}) {
    const normalizedItems = Array.isArray(items) ? items.filter(Boolean) : [];
    const selectedIndex = normalizedItems.findIndex(item => item.value === selected);
    this.commandPaletteOpen = false;
    this._closeCompletion();
    this.picker = {
      title: title || 'Select',
      items: normalizedItems,
      selection: selectedIndex >= 0 ? selectedIndex : 0,
      scrollOffset: 0,
      onSelect,
      onCancel,
    };
    this.render();
  }

  // ─── Input Handling ──────────────────────────────────────────────────

  async _onKeypress(data) {
    const key = data.toString();

    if (this.picker) {
      const state = this.picker;
      if (key === '\x1b[A') {
        state.selection = Math.max(0, state.selection - 1);
      } else if (key === '\x1b[B') {
        state.selection = Math.min(Math.max(0, state.items.length - 1), state.selection + 1);
      } else if (key === '\r' || key === '\n' || key === '\t') {
        const item = state.items[state.selection];
        this.picker = null;
        if (item) await state.onSelect?.(item.value, item);
      } else if (key === '\x1b' || key === '\x03') {
        this.picker = null;
        await state.onCancel?.();
      }
      this.render();
      return;
    }

    // Bracketed paste detection — strip paste markers and handle as text
    if (key.includes('\x1b[200~')) {
      const cleaned = key.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '');
      if (cleaned.length > 0) {
        const printable = cleaned.split('').filter(c => c.charCodeAt(0) >= 32 || c === '\n').join('');
        // Replace newlines with spaces for single-line input
        const text = printable.replace(/\n/g, ' ');
        this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor) + text + this.inputBuffer.slice(this.inputCursor);
        this.inputCursor += text.length;
        this.commandPaletteOpen = this.inputBuffer.startsWith('/');
        await this._refreshCompletion();
        this.render();
      }
      return;
    }

    // Ctrl+C — exit
    if (key === '\x03') {
      this.leave();
      this.onExit();
      return;
    }

    // Ctrl+D — exit
    if (key === '\x04') {
      this.leave();
      this.onExit();
      return;
    }

    // Ctrl+Z — suspend cleanly. In raw mode the kernel delivers Ctrl+Z as a
    // raw byte (0x1a) rather than generating SIGTSTP, so we trigger the
    // controller's suspend path ourselves to restore the terminal first
    // (issue #71). On `fg`, SIGCONT re-enters the TUI and redraws.
    if (key === '\x1a') {
      if (this._terminal) this._terminal.suspend();
      return;
    }

    // Enter — submit
    if (key === '\r' || key === '\n') {
      if (this.completion) {
        this._selectCompletion();
        this.render();
        return;
      }
      // If command palette is open, select and execute immediately
      if (this.commandPaletteOpen) {
        const filter = this.inputBuffer.slice(1).toLowerCase();
        const filtered = this.commands.filter(c =>
          c.cmd.slice(1).startsWith(filter) || (c.alias && c.alias.slice(1).startsWith(filter))
        );
        if (filtered.length > 0) {
          const selected = filtered[Math.min(this.commandPaletteSelection, filtered.length - 1)];
          this.inputBuffer = selected.cmd;
          this.inputCursor = this.inputBuffer.length;
        }
        this.commandPaletteOpen = false;
        this.commandPaletteSelection = 0;
        this._paletteScrollOffset = 0;
        // Fall through to execute the command below (don't return)
      }

      const input = this.inputBuffer.trim();
      if (input) {
        this.inputHistory.push(input);
        this.historyIdx = this.inputHistory.length;
        this.inputBuffer = '';
        this.inputCursor = 0;

        if (input.startsWith('/')) {
          await this.onCommand(input);
        } else {
          this.addChat('user', input);
          await this._enqueueSubmit(input);
        }
      }
      this.render();
      return;
    }

    // Escape — close command palette
    if (key === '\x1b') {
      if (this.completion) {
        this._closeCompletion();
        this.render();
        return;
      }
      if (this.commandPaletteOpen) {
        this.commandPaletteOpen = false;
        this.commandPaletteSelection = 0;
        this._paletteScrollOffset = 0;
        this.render();
        return;
      }
    }

    // Backspace
    if (key === '\x7f' || key === '\b') {
      if (this.inputCursor > 0) {
        this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor - 1) + this.inputBuffer.slice(this.inputCursor);
        this.inputCursor--;
      }
      // Update command palette state
      if (this.inputBuffer.startsWith('/') && this.inputBuffer.length > 0) {
        this.commandPaletteOpen = true;
      } else {
        this.commandPaletteOpen = false;
        this.commandPaletteSelection = 0;
      }
      await this._refreshCompletion();
      this.render();
      return;
    }

    // Arrow keys (escape sequences)
    if (key === '\x1b[A') { // Up — history or palette navigation
      if (this.completion) {
        this.completion.selection = Math.max(0, this.completion.selection - 1);
        this.render();
        return;
      }
      if (this.commandPaletteOpen) {
        this.commandPaletteSelection = Math.max(0, this.commandPaletteSelection - 1);
        // Scroll offset: keep selection visible at top
        if (this.commandPaletteSelection < this._paletteScrollOffset) {
          this._paletteScrollOffset = this.commandPaletteSelection;
        }
        this.render();
        return;
      }
      if (this.historyIdx > 0) {
        this.historyIdx--;
        this.inputBuffer = this.inputHistory[this.historyIdx] || '';
        this.inputCursor = this.inputBuffer.length;
      }
      this.render();
      return;
    }
    if (key === '\x1b[B') { // Down — history or palette navigation
      if (this.completion) {
        this.completion.selection = Math.min(
          Math.max(0, this.completion.items.length - 1),
          this.completion.selection + 1,
        );
        this.render();
        return;
      }
      if (this.commandPaletteOpen) {
        const filter = this.inputBuffer.slice(1).toLowerCase();
        const filteredLen = this.commands.filter(c =>
          c.cmd.slice(1).startsWith(filter) || (c.alias && c.alias.slice(1).startsWith(filter))
        ).length;
        this.commandPaletteSelection = Math.min(filteredLen - 1, this.commandPaletteSelection + 1);
        // Scroll offset: keep selection visible at bottom
        const maxVis = this._paletteMaxVisible || 8;
        if (this.commandPaletteSelection >= this._paletteScrollOffset + maxVis) {
          this._paletteScrollOffset = this.commandPaletteSelection - maxVis + 1;
        }
        this.render();
        return;
      }
      if (this.historyIdx < this.inputHistory.length - 1) {
        this.historyIdx++;
        this.inputBuffer = this.inputHistory[this.historyIdx] || '';
      } else {
        this.historyIdx = this.inputHistory.length;
        this.inputBuffer = '';
      }
      this.inputCursor = this.inputBuffer.length;
      this.render();
      return;
    }
    if (key === '\x1b[C') { // Right
      if (this.inputCursor < this.inputBuffer.length) this.inputCursor++;
      await this._refreshCompletion();
      this.render();
      return;
    }
    if (key === '\x1b[D') { // Left
      if (this.inputCursor > 0) this.inputCursor--;
      await this._refreshCompletion();
      this.render();
      return;
    }

    // Tab accepts an active composer completion.
    if (key === '\t' && this.completion) {
      this._selectCompletion();
      this.render();
      return;
    }

    // Scroll chat — PgUp/PgDn, Shift+Up/Down, mouse wheel
    if (key === '\x1b[5~' || key === '\x1b[1;2A') { // PgUp or Shift+Up
      const maxBack = -(Math.max(0, this._scrollableLines().length - this.chatHeight));
      const step = key === '\x1b[1;2A' ? 3 : Math.floor(this.chatHeight / 2);
      this.chatScroll = Math.max(maxBack, this.chatScroll - step);
      this.render();
      return;
    }
    if (key === '\x1b[6~' || key === '\x1b[1;2B') { // PgDn or Shift+Down
      const step = key === '\x1b[1;2B' ? 3 : Math.floor(this.chatHeight / 2);
      this.chatScroll = Math.min(0, this.chatScroll + step);
      this.render();
      return;
    }
    // Mouse wheel (SGR mouse mode — \x1b[<64;x;yM = scroll up, \x1b[<65;x;yM = scroll down)
    if (key.startsWith('\x1b[<64;')) {
      const maxBack = -(Math.max(0, this._scrollableLines().length - this.chatHeight));
      this.chatScroll = Math.max(maxBack, this.chatScroll - 3);
      this.render();
      return;
    }
    if (key.startsWith('\x1b[<65;')) {
      this.chatScroll = Math.min(0, this.chatScroll + 3);
      this.render();
      return;
    }

    // Ctrl+L — clear and redraw
    if (key === '\x0c') {
      this.render();
      return;
    }

    // Ctrl+V — paste from clipboard (Windows)
    if (key === '\x16') {
      try {
        const { execSync } = require('child_process');
        let clipboard = '';
        if (process.platform === 'win32') {
          clipboard = execSync('powershell -command "Get-Clipboard"', { encoding: 'utf-8', timeout: 3000 }).trim();
        } else if (process.platform === 'darwin') {
          clipboard = execSync('pbpaste', { encoding: 'utf-8', timeout: 3000 }).trim();
        } else {
          clipboard = execSync('xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null', { encoding: 'utf-8', timeout: 3000, shell: true }).trim();
        }
        if (clipboard) {
          // Replace newlines with spaces for input line
          const text = clipboard.replace(/[\r\n]+/g, ' ');
          this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor) + text + this.inputBuffer.slice(this.inputCursor);
          this.inputCursor += text.length;
          this.commandPaletteOpen = this.inputBuffer.startsWith('/');
          await this._refreshCompletion();
          this.render();
        }
      } catch {}
      return;
    }

    // Regular character or paste (multiple characters at once)
    if (key.length >= 1 && !key.startsWith('\x1b')) {
      // Accept all printable characters (including UTF-8 multi-byte)
      const text = key.replace(/[\x00-\x1f\x7f]/g, ''); // Strip control chars only
      if (text.length > 0) {
        this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor) + text + this.inputBuffer.slice(this.inputCursor);
        this.inputCursor += text.length;

        // Open command palette when / is the first character
        if (this.inputBuffer.startsWith('/')) {
          this.commandPaletteOpen = true;
          this.commandPaletteSelection = 0;
          this._paletteScrollOffset = 0;
        } else {
          this.commandPaletteOpen = false;
          this._paletteScrollOffset = 0;
        }

        await this._refreshCompletion();

        this.render();
      }
    }
  }

  _onResize() {
    this._computeLayout();
    this.render();
  }

  // ─── Public API ──────────────────────────────────────────────────────

  addChat(role, content) {
    const type = role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'system';
    if (type === 'user' || type === 'assistant') this.showWelcome = false;
    this._pushEvent({ type, content: String(content || '') });
    if (type === 'user' || type === 'assistant') this._activeAssistantEvent = null;
    this.chatScroll = 0; // snap to bottom
    this.msgCount++;
    this.render();
  }

  addTool(name, status, detail) {
    this._pushEvent({ type: 'tool', name: name || '', status, detail: detail || '' });
    this.chatScroll = 0;
    this.render();
  }

  addFileDiff(filePath, oldStr, newStr, lineNum) {
    this._activeThinkingEvent = null;
    this._pushEvent({
      type: 'diff',
      path: filePath,
      oldStr: String(oldStr || '').slice(0, 20000),
      newStr: String(newStr || '').slice(0, 20000),
      lineNum,
    });
    this.render();
  }

  addDiff(filePath, oldStr, newStr, lineNum) {
    this.addFileDiff(filePath, oldStr, newStr, lineNum);
  }

  streamThinking(token) {
    if (!token) return;
    if (!this._activeThinkingEvent) {
      this._activeThinkingEvent = this._pushEvent({ type: 'thinking', text: '' });
    }
    this._activeThinkingEvent.text += token;
    if (this._activeThinkingEvent.text.length > 20000) {
      this._activeThinkingEvent.text = this._activeThinkingEvent.text.slice(-20000);
    }
    this.render();
  }

  endThinking() {
    this._activeThinkingEvent = null;
    this.render();
  }

  _pushEvent(event) {
    event.seq = this._nextEventSeq++;
    this.events.push(event);
    const maxEvents = 1000;
    if (this.events.length > maxEvents) this.events.splice(0, this.events.length - maxEvents);
    if (this._activeThinkingEvent && !this.events.includes(this._activeThinkingEvent)) this._activeThinkingEvent = null;
    if (this._activeAssistantEvent && !this.events.includes(this._activeAssistantEvent)) this._activeAssistantEvent = null;
    return event;
  }

  _enqueueSubmit(input) {
    return new Promise(resolve => {
      this._submitQueue.push({ input, resolve });
      this._syncBusyState();
      this._drainSubmitQueue();
    });
  }

  async _drainSubmitQueue() {
    if (this._submitRunning) return;
    this._submitRunning = true;
    this._syncBusyState();
    try {
      while (this._submitQueue.length > 0) {
        const job = this._submitQueue.shift();
        try {
          await this.onSubmit(job.input);
          job.resolve(true);
        } catch (error) {
          this.addTool('error', 'err', error?.message || String(error));
          job.resolve(false);
        }
      }
    } finally {
      this._submitRunning = false;
      this._syncBusyState();
    }
  }

  _syncBusyState() {
    const busy = this._modelStreaming || this._submitRunning || this._submitQueue.length > 0;
    const changed = this.isStreaming !== busy;
    this.isStreaming = busy;
    if (changed) this.render();
  }

  setStreaming(streaming) {
    this._modelStreaming = Boolean(streaming);
    this._syncBusyState();
  }

  setModel(name) {
    this.model = name;
    this.render();
  }

  setThinkingLevel(level) {
    this.thinkingLevel = level || 'custom';
    this.render();
  }

  setTokenInfo(info) {
    this.tokenInfo = info || '';
    this.render();
  }

  // Stream assistant output into its own mutable event.
  streamToken(token) {
    if (!token) return;
    if (!this._activeAssistantEvent) {
      this.showWelcome = false;
      this._activeAssistantEvent = this._pushEvent({ type: 'assistant', content: '' });
    }
    this._activeAssistantEvent.content += token;
    if (this._activeAssistantEvent.content.length > 100000) {
      this._activeAssistantEvent.content = this._activeAssistantEvent.content.slice(-100000);
    }
    this.chatScroll = 0;
    this.render();
  }

  endStream() {
    this._activeAssistantEvent = null;
    this.render();
  }

  // ─── Utilities ───────────────────────────────────────────────────────

  _truncate(str, maxLen) {
    return fitAnsi(str, maxLen, { pad: false });
  }

  _stripAnsi(str) {
    return stripAnsi(str);
  }

  _wordWrap(text, maxWidth) {
    if (maxWidth <= 0) maxWidth = 40;
    if (!text || this._stripAnsi(text).length <= maxWidth) return [text || ''];

    const words = text.split(' ');
    const lines = [];
    let current = '';

    for (const word of words) {
      const testLine = current ? current + ' ' + word : word;
      if (this._stripAnsi(testLine).length <= maxWidth) {
        current = testLine;
      } else {
        if (current) lines.push(current);
        // If a single word is longer than maxWidth, hard-break it
        if (this._stripAnsi(word).length > maxWidth) {
          let remaining = word;
          while (this._stripAnsi(remaining).length > maxWidth) {
            lines.push(remaining.slice(0, maxWidth));
            remaining = remaining.slice(maxWidth);
          }
          current = remaining;
        } else {
          current = word;
        }
      }
    }
    if (current) lines.push(current);
    return lines.length > 0 ? lines : [''];
  }

  _highlightCode(line) {
    const t = this.theme;
    let hl = line;
    // Strings
    hl = hl.replace(/(["'`])(?:(?!\1).)*\1/g, m => ANSI.fgRgb(140, 200, 120) + m + ANSI.reset);
    // Comments
    hl = hl.replace(/(\/\/.*)$/, m => t.muted + m + ANSI.reset);
    hl = hl.replace(/(#.*)$/, m => t.muted + m + ANSI.reset);
    // Keywords
    const kws = ['const','let','var','function','return','if','else','for','while','class','import','export','from','async','await','new','this','true','false','null','undefined','pub','fn','struct','impl','mut','match','def','self','None','type','interface','enum'];
    for (const kw of kws) {
      hl = hl.replace(new RegExp(`\\b${kw}\\b`, 'g'), ANSI.fgRgb(180, 140, 220) + kw + ANSI.reset);
    }
    // Numbers
    hl = hl.replace(/\b(\d+)\b/g, ANSI.fgRgb(120, 200, 220) + '$1' + ANSI.reset);
    return hl;
  }
}

module.exports = { FullScreenTUI, ANSI, BOX, THEMES };
