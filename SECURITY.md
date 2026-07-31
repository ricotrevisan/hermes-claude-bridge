# Security

## Reporting a vulnerability

Please use GitHub Security Advisories (the repository's **Report a vulnerability** action) instead of opening a public issue.

## Threat model

- The bridge binds to `127.0.0.1` only. It rejects requests with a browser `Origin` header and requires `Content-Type: application/json`, preventing ordinary cross-site form/simple-fetch attacks. It has no HTTP authentication, so any local process can still submit prompts and consume Claude subscription quota.
- Every Agent SDK child environment removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_TOKEN`, and `ANTHROPIC_BASE_URL`. Before forwarding output, the bridge requires SDK account metadata for a first-party Claude subscription, rejects explicit API-key credential sources, and aborts when SDK rate-limit metadata reports `isUsingOverage: true`. Claude Code currently reports `apiKeySource: "none"` for valid Keychain-backed subscription OAuth, so account metadata is the primary check.
- The bridge retains the SDK's official Claude Code system-prompt preset and does not forward the outer Hermes harness system prompt. Both a raw custom prompt and appending the full Hermes harness prompt were observed to route through Extra Usage even for a first-party Max account, so this preset-only behavior and its regression tests are billing-safety boundaries.
- OAuth credentials remain owned by Claude Code. The bridge does not copy them into Hermes or its own runtime.
- Default mode disables Claude Code tools, settings, skills, hooks, filesystem/cloud MCP servers, auto-memory, and auto-compaction. Hermes tools are not currently passed through.
- Full-agent mode (`CLAUDE_BRIDGE_FULL_AGENT=1`) enables Claude Code's built-in tools under `bypassPermissions`. It can read, modify, and execute files and commands as the current user in `CLAUDE_BRIDGE_CWD`. Treat it like running Claude Code with permission checks disabled.
- The installer writes under `~/.hermes` and the current user's launchd/systemd directories. It runs `npm install` inside `~/.hermes/claude-bridge` to install the pinned Agent SDK and its platform-specific executable; it uses no privileged commands.
