# Security Policy

## Trust Model

SmallCode is a local development tool. It runs with the same permissions as your user account — it can read, write, and execute anything you can. This is by design. A coding agent that can't touch files or run commands isn't very useful.

If you're running SmallCode on your personal machine in your own project directories, the security surface is essentially the same as opening a terminal and typing commands yourself.

## What SmallCode Does

- **Reads and writes files** in your current working directory and subdirectories
- **Executes shell commands** via the `bash` tool (subject to a configurable timeout)
- **Connects to your local LLM server** (LM Studio, Ollama, llama.cpp) over HTTP on localhost
- **Optionally sends data to cloud APIs** when escalation is enabled (Anthropic, OpenAI, DeepSeek) — only when the local model fails and you have explicitly configured an API key

## What SmallCode Does Not Do

- It does not phone home, collect telemetry, or transmit data to any service unless you configure escalation
- It does not require an account, login, or registration
- It does not run a network server or listen on any port (except when started in MCP mode over stdio)
- Direct file tools and destructive shell syntax are restricted to the project directory captured when SmallCode starts

## API Keys and Credentials

If you configure escalation (Claude, GPT, DeepSeek), your API key is stored in your local `.env` file or `smallcode.toml`. These files should be in your `.gitignore` (the default `.gitignore` we ship already excludes `.env`). SmallCode reads the key at startup and sends it only to the provider you configured.

We recommend:
- Never commit `.env` files to version control
- Use environment variables instead of hardcoding keys in config files when possible
- Rotate keys if you suspect they've been exposed

## Plugins

The plugin system (`/plugin install`) runs arbitrary JavaScript from `.smallcode/plugins/`. Only install plugins you trust. Manifest permissions are displayed by `/extensions`, but plugins are not sandboxed and retain the same operating-system access as SmallCode itself.

## Bash Tool

The `bash`, `run`, API, and MCP execution paths share a workspace policy. The project directory captured at startup is a fixed boundary: direct deletion, movement, overwrite, truncation, redirection, and directory-change targets outside it are rejected. Targets are resolved through existing symlink ancestors; ambiguous variables, substitutions, and destructive subshells fail closed. Deleting the workspace root itself is also refused.

This is command validation, not an operating-system sandbox. A permitted program such as `node script.js`, `python task.py`, an npm script, or plugin JavaScript can perform filesystem operations that are not visible in the outer command. Exercise the same caution you would with any automated tool that has shell access.

## Provider Probes and Cloud APIs

SmallCode performs a minimal provider capability probe at startup and deeper probes when an endpoint/model fingerprint is new or changed. When a cloud provider is configured, these probes send synthetic prompts and may incur a small API charge. Results contain capability flags and fingerprints only; prompts and API keys are not written to the capability cache.

## Reporting Vulnerabilities

If you discover a security issue, please open a GitHub issue or contact the maintainer directly. We take reports seriously and will address them promptly.

For issues that could affect other users (e.g., a dependency vulnerability), we prefer responsible disclosure. Please reach out before posting publicly so we can prepare a fix.

## Scope

This policy applies to SmallCode itself. Dependencies (budget-aware-mcp, bonescript-compiler) have their own security considerations. We pin dependency versions and review updates, but we cannot guarantee the security of all transitive dependencies.

## Summary

SmallCode trusts you, and you should trust SmallCode only as much as you trust the code you can read in this repository. It's MIT-licensed, single-file core, and fully auditable. If something looks wrong, open an issue.
