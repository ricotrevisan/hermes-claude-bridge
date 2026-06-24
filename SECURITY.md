# Security

## Reporting a vulnerability

Please report security issues privately via GitHub Security Advisories
("Report a vulnerability" on the repository's Security tab) rather than a public
issue. I'll respond as soon as I can.

## Scope and threat model

- The bridge **binds to `127.0.0.1` only** — it is not reachable off-host. There
  is no authentication on the local endpoint by design (it is a localhost-only
  shim); any local process can reach it, same as a local Ollama/llama.cpp server.
- It runs on **your** Claude Code subscription via the `claude -p` CLI and at
  startup unsets `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`
  so turns cannot silently fall through to a metered API key.
- In **full-agent mode** (`CLAUDE_BRIDGE_FULL_AGENT=1`) Claude runs its own tools
  (file read/write, shell) in `CLAUDE_BRIDGE_CWD` under `bypassPermissions`. Treat
  that with the same caution as running Claude Code itself. The default
  (clean-assistant) mode runs with no tools.
- The installer writes only inside `~/.hermes` and your user `launchd`/`systemd`
  directories, runs no privileged commands, and is fully reversible via
  `uninstall`.
