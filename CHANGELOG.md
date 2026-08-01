# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## Unreleased

- Authenticated the local endpoint ([#9](https://github.com/ricotrevisan/hermes-claude-bridge/issues/9)):
  the installer now generates a random per-install `CLAUDE_BRIDGE_API_KEY` instead of a
  placebo placeholder, the server validates it as a bearer token on every route except
  `/healthz`, and it refuses to start without one.
- Hardened full-agent mode: `CLAUDE_BRIDGE_*` variables are stripped from the SDK child
  environment, and the default working directory is `~/.hermes/claude-bridge-workspace`
  instead of `$HOME`.
- Added header and request-body timeouts so a stalled client cannot hold a connection open.

## [0.2.0] - 2026-07-30

- Revived the bridge using Claude Agent SDK `query()` now that Agent SDK turns
  can use Claude subscription quota again.
- Enforced subscription-only execution per query so ambient Anthropic API keys
  or an SDK-selected Extra Usage lane cannot silently switch turns to metered billing.
- Kept the official Claude Code system-prompt preset as a tested subscription-routing
  boundary and excluded the outer Hermes harness system prompt, which selects Extra Usage.
- Added current Claude Code models, measured subscription-compatible context routing,
  served-context drift warnings, SDK stream/error handling, abort cleanup, isolated child
  settings, browser-origin request hardening, and offline transport tests.
- Updated installation to provision the pinned Agent SDK and its platform-native
  Claude Code runtime beside the stable bridge service.
- Deliberately deferred Hermes tool passthrough ([#1](https://github.com/ricotrevisan/hermes-claude-bridge/issues/1)):
  default mode is a clean conversational provider, while optional full-agent mode uses Claude Code's own tools.

## [0.1.0] - 2026-06-24

Initial release.

- OpenAI-compatible local bridge (`/v1/chat/completions` streaming + non-streaming,
  `/v1/models`, `/healthz`) that drives the `claude -p` CLI on a Claude Code
  Pro/Max subscription — no `ANTHROPIC_API_KEY`.
- Multi-turn context via `cc-session-io` session replay + `claude --resume`.
- Hermes provider plugin + `config.yaml` registration so `claude-bridge` is
  selectable via `hermes model`.
- Installer/uninstaller with a durable self-contained runtime copy and a
  launchd (macOS) / systemd --user (Linux) auto-start service.
- Clean-assistant mode by default; `CLAUDE_BRIDGE_FULL_AGENT=1` for the full
  Claude Code agent.
