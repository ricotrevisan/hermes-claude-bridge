# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## Unreleased

- Deprecated the project and disabled fresh installs by default. Existing users
  should uninstall with `hermes-claude-bridge uninstall` and use Hermes' native
  Anthropic provider or `claude-code` skill instead.

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
