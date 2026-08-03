'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FullScreenTUI } = require('../src/tui/fullscreen');
const { renderStatus, renderWelcome } = require('../bin/tui');
const { fitAnsi, visualLength, stripAnsi } = require('../src/tui/utils');

// Fullscreen TUI outputs coordinate positioning (\x1b[row;colH) rather than \n.
// This splits the absolute escape stream into rows.
function splitRows(buf) {
  return buf.split(/\x1b\[\d+;\d+H/).filter(l => l.length > 0);
}

// Helper to mock stdout dimensions cleanly without boilerplate
function runWithMockStdout(columns, rows, fn) {
  const origColumns = process.stdout.columns;
  const origRows = process.stdout.rows;
  try {
    Object.defineProperty(process.stdout, 'columns', {
      value: columns,
      writable: true,
      configurable: true
    });
    Object.defineProperty(process.stdout, 'rows', {
      value: rows,
      writable: true,
      configurable: true
    });
    fn();
  } finally {
    Object.defineProperty(process.stdout, 'columns', { value: origColumns, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: origRows, configurable: true });
  }
}

test('Fullscreen TUI welcome screen - responsive widths', () => {
  const widths = [1, 8, 12, 19, 30, 40, 80, 120];

  for (const w of widths) {
    runWithMockStdout(w, 24, () => {
      const tui = new FullScreenTUI();
      tui.model = 'anthropic/claude-3.5-sonnet';
      tui._computeLayout();

      const welcome = tui._renderWelcomeScreen();
      assert.ok(welcome, `Should render welcome screen for width ${w}`);

      const rows = splitRows(welcome);
      assert.ok(rows.length >= 1, `Should have rendered welcome rows for width ${w}`);

      for (const row of rows) {
        const visLen = stripAnsi(row).trimEnd().length;
        assert.ok(visLen <= w, `Row width ${visLen} exceeds terminal width ${w} in welcome screen: "${stripAnsi(row)}"`);
      }
    });
  }
});

test('Fullscreen TUI status bar - handles long model names and cwd', () => {
  const widths = [1, 8, 12, 19, 30, 40, 80, 120];

  for (const w of widths) {
    runWithMockStdout(w, 24, () => {
      const tui = new FullScreenTUI();
      tui.model = 'very-long-provider-name/extremely-long-custom-finetuned-model-v2.5.3-extra-large';
      tui.tokenInfo = '123,456 tokens';
      tui._computeLayout();

      const status = tui._renderStatus();
      assert.ok(status, `Should render status bar for width ${w}`);

      const rows = splitRows(status);
      for (const row of rows) {
        const clean = stripAnsi(row).trimEnd();
        assert.ok(clean.length <= w, `Status line width ${clean.length} exceeds terminal width ${w} for width ${w}: "${clean}"`);
      }
    });
  }
});

test('Fullscreen TUI command palette - stable layout and column fitting', () => {
  const widths = [40, 80, 120];

  for (const w of widths) {
    runWithMockStdout(w, 24, () => {
      const tui = new FullScreenTUI();
      tui.inputBuffer = '/git';
      tui.commandPaletteOpen = true;
      tui._computeLayout();

      const palette = tui._renderCommandPalette(20);
      assert.ok(palette, `Should render command palette for width ${w}`);

      const rows = splitRows(palette);
      assert.ok(rows.length >= 3, 'Palette should have at least 3 rows');

      for (const row of rows) {
        const clean = stripAnsi(row).trimEnd();
        assert.ok(clean.length <= w, `Palette line width ${clean.length} exceeds terminal width ${w} for width ${w}: "${clean}"`);
      }
    });
  }
});

test('Classic fallback TUI welcome card - responsive columns', () => {
  const widths = [1, 8, 12, 19, 30, 40, 80, 120];

  for (const w of widths) {
    runWithMockStdout(w, 24, () => {
      const config = { model: { name: 'deepseek/deepseek-coder-33b-instruct' } };
      const welcome = renderWelcome(config, true);
      assert.ok(welcome, `Should render classic welcome for width ${w}`);

      const lines = welcome.split('\n');
      for (const line of lines) {
        const visLen = stripAnsi(line).trimEnd().length;
        assert.ok(visLen <= w, `Classic welcome row ${visLen} exceeds width ${w} in split pane: "${stripAnsi(line)}"`);
      }
    });
  }
});

test('Classic fallback TUI status line - drops segments under tight columns', () => {
  const widths = [1, 8, 12, 19, 30, 45, 80, 120];

  for (const w of widths) {
    runWithMockStdout(w, 24, () => {
      const config = { model: { name: 'openai/gpt-4o-mini-extremely-long-suffix-for-testing-purposes' } };
      const status = renderStatus(config, 42);
      assert.ok(status, `Should render classic status for width ${w}`);

      const clean = stripAnsi(status);
      assert.ok(clean.length <= w, `Classic status line visual length ${clean.length} exceeds width ${w} for width ${w}`);

      if (w < 40 && w >= 20) {
        assert.ok(!clean.includes('msgs'), 'Should drop messages count on small terminal widths');
      }
    });
  }
});

test('fitAnsi - robust utility checks', () => {
  // 1. ANSI color reset preservation
  const colored = '\x1b[31mhello\x1b[0m';
  assert.equal(fitAnsi(colored, 3), '\x1b[31mhel\x1b[0m');
  assert.equal(fitAnsi('\x1b[31mhello', 3), '\x1b[31mhel\x1b[0m');

  // 2. Ellipsis
  assert.equal(fitAnsi('hello world', 8, { ellipsis: true, pad: false }), 'hello...');
  assert.equal(fitAnsi('hello world', 10, { ellipsis: true, pad: false }), 'hello w...');

  // 3. Width 0 and very tiny widths
  assert.equal(fitAnsi('hello', 0), '');
  assert.equal(fitAnsi('hello', 2, { pad: false }), 'he');

  // 4. CJK double-width character fitting
  assert.equal(fitAnsi('中文', 3, { pad: true }), '中 '); // C='中' (2) + ' ' (1) = 3
  assert.equal(fitAnsi('中文', 4, { pad: false }), '中文');
  assert.equal(fitAnsi('中文', 2, { pad: false }), '中');
  assert.equal(visualLength('中'), 2);

  // 5. Emoji & surrogate pair boundary preservation (surrogate-pair safe)
  assert.equal(fitAnsi('😊😊', 1, { pad: false }), '😊');
  assert.equal(visualLength('😊'), 1);

  // 6. ZWJ Grapheme Clusters (Intentionally Out of Scope / Partial support caveat)
  // fitAnsi does not fully resolve complex ZWJ family sequences into a single grapheme of width 2.
  // Instead, it splits them by code point.
  const zwjFamily = '👨‍👩‍👧‍👦';
  assert.ok(visualLength(zwjFamily) > 2, 'ZWJ sequence visual width is over-counted by simple code-point iteration');
  const truncatedFamily = fitAnsi(zwjFamily, 5, { pad: false });
  assert.equal(truncatedFamily, '👨‍👩‍👧');
});

test('wide fullscreen layout shows chronological THINK/DIFF details without tool duplication', () => {
  runWithMockStdout(160, 30, () => {
    const tui = new FullScreenTUI();
    tui.render = () => {};
    tui._computeLayout();
    assert.ok(tui.toolWidth > 0);

    tui.addTool('read_file', 'ok', 'src/a.js');
    assert.equal(tui.detailEvents.length, 0);
    assert.ok(tui.chatLines.some(line => stripAnsi(line).includes('read_file')));

    tui.streamThinking('Inspecting ');
    tui.streamThinking('the file');
    tui.endThinking();
    tui.addFileDiff('src/a.js', 'old', 'new', 4);
    const detail = stripAnsi(tui._renderDetailPanel());
    assert.match(detail, /THINK/);
    assert.match(detail, /Inspecting the file/);
    assert.match(detail, /DIFF/);
    assert.match(detail, /src\/a\.js:4/);
    assert.doesNotMatch(detail, /read_file/);
  });
});

test('detail pane responds to terminal resize and retains ephemeral events', () => {
  runWithMockStdout(100, 24, () => {
    const tui = new FullScreenTUI();
    tui.render = () => {};
    tui.streamThinking('retained');
    tui.endThinking();
    tui._computeLayout();
    assert.equal(tui.toolWidth, 0);

    Object.defineProperty(process.stdout, 'columns', { value: 160, writable: true, configurable: true });
    tui._computeLayout();
    assert.ok(tui.toolWidth > 0);
    assert.match(stripAnsi(tui._renderDetailPanel()), /retained/);

    Object.defineProperty(process.stdout, 'columns', { value: 100, writable: true, configurable: true });
    tui._computeLayout();
    assert.equal(tui.toolWidth, 0);
  });
});

test('detail event buffer is bounded', () => {
  const tui = new FullScreenTUI();
  tui.render = () => {};
  for (let i = 0; i < 250; i++) tui.addFileDiff(`f${i}`, '', `${i}`, 1);
  assert.equal(tui.detailEvents.length, 200);
  assert.equal(tui.detailEvents[0].path, 'f50');
});
