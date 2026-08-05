// SmallCode — MCP Client (Runtime)
// Compiled from: src/tools/mcp_client.ms
//
// Connects TO external MCP servers and exposes their tools to the agent.
// Config: .smallcode/mcp.json (project) or ~/.config/smallcode/mcp.json (user)
//
// Example mcp.json:
// {
//   "mcpServers": {
//     "github": {
//       "command": "uvx",
//       "args": ["mcp-server-github"],
//       "env": { "GITHUB_TOKEN": "..." }
//     }
//   }
// }

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createLineDemuxer, redactValue } = require('../security/sanitize');

class MCPClient {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
    this.servers = new Map(); // name → { config, process, connected, tools, demuxer, pendingRequests }
    this.tools = []; // flat list of all discovered tools
    this._requestId = 1;
  }

  /**
   * Load MCP configuration from project + user level.
   * Project config overrides user config for same server names.
   */
  loadConfig() {
    const configPaths = [
      path.join(os.homedir(), '.config', 'smallcode', 'mcp.json'),
      path.join(this.projectDir, '.smallcode', 'mcp.json'),
    ];

    for (const configPath of configPaths) {
      if (!fs.existsSync(configPath)) continue;
      try {
        const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const servers = content.mcpServers || {};
        for (const [name, cfg] of Object.entries(servers)) {
          if (cfg.disabled) continue;
          this.servers.set(name, {
            config: {
              name,
              command: cfg.command || '',
              args: cfg.args || [],
              env: cfg.env || {},
              autoApprove: cfg.autoApprove || [],
            },
            process: null,
            connected: false,
            tools: [],
          });
        }
      } catch {}
    }

    return this.servers.size;
  }

  /**
   * Connect to all configured servers and discover their tools.
   * Returns number of tools discovered.
   */
  async connectAll() {
    let totalTools = 0;
    for (const [name, server] of this.servers) {
      try {
        const tools = await this._connectServer(name, server);
        totalTools += tools;
      } catch {}
    }
    return totalTools;
  }

  /**
   * Get tool definitions formatted for the OpenAI tools array.
   */
  getToolDefs() {
    return this.tools.map(t => ({
      type: 'function',
      function: {
        name: `mcp__${t.serverName}__${t.name}`,
        description: `[${t.serverName}] ${t.description}`,
        parameters: t.inputSchema || { type: 'object', properties: {} },
      },
    }));
  }

  /**
   * Execute a tool call on the appropriate MCP server.
   * @param {string} fullName - Tool name in format mcp__serverName__toolName
   * @param {object} args - Tool arguments
   * @returns {object} { result, error }
   */
  async callTool(fullName, args) {
    // Parse mcp__serverName__toolName
    const parts = fullName.split('__');
    if (parts.length < 3 || parts[0] !== 'mcp') {
      return { error: `Invalid MCP tool name: ${fullName}` };
    }
    const serverName = parts[1];
    const toolName = parts.slice(2).join('__'); // Handle tools with __ in name

    const server = this.servers.get(serverName);
    if (!server || !server.connected) {
      return { error: `MCP server '${serverName}' is not connected` };
    }

    try {
      const response = await this._sendRequest(server, 'tools/call', {
        name: toolName,
        arguments: args,
      });

      if (!response) return { error: `No response from ${serverName}` };

      const content = response.content || [];
      const text = content
        .filter(c => c.type === 'text')
        .map(c => c.text || '')
        .join('\n');

      if (response.isError) {
        return { error: text || 'MCP tool returned error' };
      }
      // Sanitize MCP server output before returning — external servers can
      // return ANSI escapes, secrets from their own env, or binary garbage.
      const { sanitizeToolOutput } = require('../security/sanitize');
      return { result: sanitizeToolOutput(text) || '(no output)' };
    } catch (err) {
      return { error: `MCP call failed: ${err.message}` };
    }
  }

  /**
   * Check if a tool name belongs to an MCP server.
   */
  isMCPTool(name) {
    return name.startsWith('mcp__');
  }

  /**
   * List connected servers and their tools (for /mcp command).
   */
  status() {
    const result = [];
    for (const [name, server] of this.servers) {
      result.push({
        name,
        connected: server.connected,
        tools: server.tools.map(t => t.name),
        command: server.config.command,
      });
    }
    return result;
  }

  /**
   * Disconnect all servers.
   */
  disconnect() {
    for (const [, server] of this.servers) {
      // Close the demuxer first so the shared 'data' listener is detached
      // before we kill the process. Otherwise the listener can still see
      // EOF chunks and resolve in-flight requests with garbage.
      if (server.demuxer) {
        try { server.demuxer.close(); } catch {}
        server.demuxer = null;
      }
      if (server.process) {
        try { server.process.kill(); } catch {}
        server.process = null;
        server.connected = false;
      }
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  async _connectServer(name, server) {
    const { config } = server;
    if (!config.command) return 0;

    // Spawn the MCP server process. Use shell:false (default) and pass
    // args as an array — never as a single string — to avoid shell
    // injection via crafted server config in mcp.json. We also strip
    // SMALLCODE_*-style host secrets out of the inherited env unless
    // the server explicitly opted in via config.env.
    const baseEnv = { ...process.env };
    // Drop ambient API keys from the child unless the server's config
    // explicitly re-exports them. MCP servers run untrusted code; leaking
    // OPENAI_API_KEY / ANTHROPIC_API_KEY etc. into a third-party server
    // is a meaningful exfiltration risk.
    const SECRET_ENV_VARS = [
      'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY',
      'OPENAI_COMPAT_API_KEY', 'OPENROUTER_API_KEY',
      'GOOGLE_API_KEY', 'GEMINI_API_KEY',
      'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
      'GITHUB_TOKEN', 'GITLAB_TOKEN',
    ];
    for (const k of SECRET_ENV_VARS) {
      if (!(k in (config.env || {}))) delete baseEnv[k];
    }
    const env = { ...baseEnv, ...config.env };
    try {
      server.process = spawn(config.command, config.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.projectDir,
        env,
        shell: false, // explicit: never invoke a shell
      });
    } catch (err) {
      return 0;
    }

    server.process.on('error', () => { server.connected = false; });
    server.process.on('exit', () => {
      server.connected = false;
      server.process = null;
      if (server.demuxer) { try { server.demuxer.close(); } catch {} server.demuxer = null; }
    });

    // One shared line demuxer per server; per-request handlers register
    // briefly and unregister when the matching response arrives. This
    // replaces the prior pattern of attaching a fresh `on('data', ...)`
    // listener for every request, which leaked listeners under load and
    // could resolve a request with another request's bytes.
    server.demuxer = createLineDemuxer(server.process.stdout);

    // Initialize
    const initResult = await this._sendRequest(server, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smallcode', version: require('../../package.json').version },
    });

    if (!initResult) {
      if (server.process) { server.process.kill(); server.process = null; }
      return 0;
    }

    // Send initialized notification
    this._sendNotification(server, 'notifications/initialized', {});

    server.connected = true;

    // List tools
    const toolsResult = await this._sendRequest(server, 'tools/list', {});
    if (toolsResult && toolsResult.tools) {
      for (const tool of toolsResult.tools) {
        const mcpTool = {
          serverName: name,
          name: tool.name,
          description: tool.description || '',
          inputSchema: tool.inputSchema || { type: 'object', properties: {} },
        };
        server.tools.push(mcpTool);
        this.tools.push(mcpTool);
      }
    }

    return server.tools.length;
  }

  _sendRequest(server, method, params) {
    return new Promise((resolve) => {
      if (!server.process || !server.process.stdin || !server.demuxer) {
        resolve(null);
        return;
      }

      const id = this._requestId++;
      const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

      let timer = null;
      const finish = (val) => {
        if (timer) clearTimeout(timer);
        server.demuxer.unregister(id);
        resolve(val);
      };

      server.demuxer.register(id, (line) => {
        try {
          const resp = JSON.parse(line);
          if (resp.id === id) {
            finish(resp.result || null);
          }
        } catch { /* not our line; demuxer keeps trying others */ }
      });

      try {
        server.process.stdin.write(request);
      } catch {
        finish(null);
        return;
      }

      // Timeout after 10s. Note: we resolve null rather than reject so
      // callers don't blow up — MCP errors are operational, not fatal.
      timer = setTimeout(() => finish(null), 10000);
    });
  }

  _sendNotification(server, method, params) {
    if (!server.process || !server.process.stdin) return;
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    try { server.process.stdin.write(msg); } catch {}
  }
}

module.exports = { MCPClient };
