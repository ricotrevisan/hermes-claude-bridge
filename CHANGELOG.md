# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## Unreleased

## [0.3.0] - 2026-08-05

- **Hermes tool bridging (issue #1).** When Hermes sends `tools` in its request, the
  bridge exposes those exact schemas to Claude Code through an in-process MCP server
  (`src/toolbridge.ts`). Claude Code gets no built-in tools; every tool call is surfaced to
  Hermes as an OpenAI `tool_call` with `finish_reason: "tool_calls"`, Hermes executes it
  with its own permissions, and the bridge resolves the blocked MCP handler so Claude
  continues the same turn (`src/coordinator.ts`). The bridge never executes a tool itself.
  Verified live on openclaw on both streaming and buffered paths on the subscription lane.
- **Full-agent mode removed.** `CLAUDE_BRIDGE_FULL_AGENT=1` no longer enables Claude Code's
  bypass-permission built-in tools; tool mode supersedes it with a strictly smaller attack
  surface. The env var is ignored (regression-tested).
- **Agent SDK 0.2.141 → 0.3.220** (exact pin kept), plus direct deps `zod` and
  `@modelcontextprotocol/sdk` for the MCP server. The newer bundled Claude Code also
  refreshes genuinely-expired OAuth tokens that 0.2.141's bundled CLI wedged on.

- Clarified the provider wording: the picker row and install output no longer say "no API
  key" right before Hermes' setup flow shows one — they now explain that the detected key is
  the installer's auto-managed local bearer token (keep it), not an Anthropic API key.
- Stopped writing the `providers.claude-bridge` entry to `config.yaml` (and clean up the
  obsolete one on install): hermes-agent ≥ 2026-05 surfaces the provider plugin natively in
  every picker, so the entry only produced a duplicate "Claude Bridge" row and mislabeled
  sessions as `billing_provider: custom`. Port-change detection now reads the previously
  installed plugin file instead. Stock hermes-agent still rejects plugin-only providers in
  `/model … --provider` and `hermes doctor` (resolution never consults the plugin registry);
  `docs/patches/hermes-plugin-provider-resolution.patch` fixes that until it lands upstream.

- Hardened the installer ([#10](https://github.com/ricotrevisan/hermes-claude-bridge/issues/10)):
  a normal install after `install --link` now replaces the plugin symlinks instead of writing
  the port-substituted files through them into the source checkout (temp file + atomic rename);
  uninstall removes only the keys and files install created, so user-added
  `providers.claude-bridge` keys and extra plugin-dir files survive; the post-install health
  check verifies the `/healthz` `service`/`version` identity instead of accepting any 200, and
  install fails loudly while the port is held by something that is not the bridge; a
  `--no-service` reinstall on a new port warns when an old bridge is still serving the
  previous one.

- Fixed system content being silently dropped
  ([#5](https://github.com/ricotrevisan/hermes-claude-bridge/issues/5)): `system` and
  `developer` messages were extracted and then discarded, so "always answer in French" had
  no effect. They are now delivered as a `<system-instructions>` preamble on the live user
  turn. The SDK's `systemPrompt` remains locked to the official `claude_code` preset.

- Fixed truncated SDK streams reporting success
  ([#8](https://github.com/ricotrevisan/hermes-claude-bridge/issues/8)): a stream that ends
  without a terminal result now fails the turn instead of finishing cleanly — 502 before
  streaming starts, and the usual in-band `[bridge error]` notice once it has. A transport that
  dies before the SDK's init message no longer misreports as a 401 telling the user to run
  `claude login`.

- Authenticated the local endpoint ([#9](https://github.com/ricotrevisan/hermes-claude-bridge/issues/9)):
  the installer now generates a random per-install `CLAUDE_BRIDGE_API_KEY` instead of a
  placebo placeholder, the server validates it as a bearer token on every route except
  `/healthz`, and it refuses to start without one.
- Hardened full-agent mode: `CLAUDE_BRIDGE_*` variables are stripped from the SDK child
  environment, and the default working directory is `~/.hermes/claude-bridge-workspace`
  instead of `$HOME`.
- Added header and request-body timeouts so a stalled client cannot hold a connection open.
- Stopped writing replay history into the user's real `~/.claude/projects/`
  ([#6](https://github.com/ricotrevisan/hermes-claude-bridge/issues/6)): history is kept in
  memory and resumed through the Agent SDK's `sessionStore` adapter, so a bridge turn can no
  longer leave a ghost session in the interactive `claude --resume` picker.

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
