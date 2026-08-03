'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { executeTool } = require('../bin/executor');

const context = {
  _fullscreenRef: null,
  mcpCall: null,
  memoryStore: null,
  pluginLoader: null,
  mcpClient: null,
  flags: {},
  config: {},
  tui: null,
};

for (const tool of ['bash', 'run']) {
  test(`${tool} returns a tool error when command is missing`, async () => {
    const result = await executeTool(tool, {}, context);
    assert.match(result.error, new RegExp(`^${tool} requires`));
  });

  test(`${tool} returns a tool error when command is blank`, async () => {
    const result = await executeTool(tool, { command: '   ' }, context);
    assert.match(result.error, new RegExp(`^${tool} requires`));
  });
}
