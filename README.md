# hermes-claude-bridge

Use Claude as a model provider in [Hermes Agent](https://github.com/NousResearch/hermes-agent) through the Claude Agent SDK and your Claude subscription OAuth login. No `ANTHROPIC_API_KEY` is required or accepted by the bridge.

Adapted from [`pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge).

```text
Hermes ── OpenAI chat/completions ──▶ localhost bridge ──▶ Claude Agent SDK ──▶ Claude subscription
       http://127.0.0.1:8787/v1        this package          OAuth from `claude login`
```

As observed by `pi-claude-bridge`, Anthropic restored Agent SDK use against Claude subscription quota in June 2026. This is an upstream entitlement and can change independently of this package. The bridge verifies that the SDK reports a first-party account with a subscription, rejects explicit API-key credential sources, and aborts if a rate-limit event says the turn selected Extra Usage.

## Prerequisites

- Claude Code logged into a subscription account: `claude login`
- Hermes Agent installed
- Node.js 20 or newer
- macOS or Linux (Windows users can use WSL)

## Install

```bash
npx hermes-claude-bridge install
```

The installer:

1. Installs a stable runtime under `~/.hermes/claude-bridge/`.
2. Installs the Claude Agent SDK and its platform-specific Claude Code executable there (about 200 MB).
3. Installs the Hermes provider plugin, which registers the `claude-bridge` provider directly
   (hermes-agent ≥ 2026-05 shows plugin providers in every picker — no `config.yaml` entry
   needed; the obsolete entry older installs wrote is cleaned up to avoid a duplicate row).
4. Generates a random `CLAUDE_BRIDGE_API_KEY` in `~/.hermes/.env` and gives the same token to the service.
5. Registers a launchd or systemd user service unless `--no-service` is passed.

Then choose **Claude Bridge** with `hermes model`, or from a running session:

```text
/model claude-opus-5 --provider claude-bridge
```

> Stock hermes-agent has a gap: `/model … --provider claude-bridge` and `hermes doctor`
> resolve providers without consulting the plugin registry, so they reject plugin-only
> providers that every picker happily shows. Tracked upstream as
> [NousResearch/hermes-agent#69576](https://github.com/NousResearch/hermes-agent/issues/69576),
> fix pending in [PR #69993](https://github.com/NousResearch/hermes-agent/pull/69993).
> Until that merges, apply
> [`docs/patches/hermes-plugin-provider-resolution.patch`](./docs/patches/hermes-plugin-provider-resolution.patch)
> to the hermes-agent checkout (keep it as an uncommitted working-tree change —
> `hermes update` auto-stashes and restores it), and discard it once the upstream
> fix lands.

Uninstall everything created by the installer with:

```bash
npx hermes-claude-bridge uninstall
```

## Models

The bridge advertises the current `pi-claude-bridge` Claude Code catalog:

- `claude-fable-5`
- `claude-opus-5`
- `claude-opus-4-8`
- `claude-opus-4-7`
- `claude-opus-4-6`
- `claude-sonnet-5`
- `claude-sonnet-4-6`
- `claude-haiku-4-5`

Aliases `fable`, `opus`, `sonnet`, and `haiku` resolve to the newest advertised model in each family. Requests using any other model ID are rejected with HTTP 400 before Claude Code starts; runtime-only forms such as `claude-sonnet-4-6[1m]` cannot bypass the measured catalog.

The bridge keeps these stable public IDs while using a measured runtime context policy:

| Public model | Claude Code runtime ID | Advertised context |
| --- | --- | ---: |
| `claude-fable-5` | `claude-fable-5[1m]` | 1M |
| `claude-opus-5` | `claude-opus-5[1m]` | 1M |
| `claude-opus-4-8` | `claude-opus-4-8[1m]` | 1M |
| `claude-opus-4-7` | same (bare ID serves 1M) | 1M |
| `claude-sonnet-5` | `claude-sonnet-5[1m]` | 1M |
| `claude-opus-4-6` | same | 200K |
| `claude-sonnet-4-6` | same | 200K |
| `claude-haiku-4-5` | same | 200K |

This table is hard-coded from measured Agent SDK subscription behavior; probing would spend quota and result metadata arrives too late for Hermes's current turn. The bridge checks the served `modelUsage.contextWindow` after each result and logs a warning if Anthropic's behavior drifts. It never enables a long-context form known to require Extra Usage.

## How it works

The local server implements:

- `POST /v1/chat/completions` (streaming and buffered)
- `GET /v1/models`
- `GET /healthz`

For each request it:

1. Converts OpenAI history to a Claude Code transcript held in memory.
2. Sends the trailing user turn through Agent SDK `query()`, resuming from that transcript via the SDK's `sessionStore` adapter.
3. Streams text, reasoning, usage, stop reasons, and errors back as OpenAI-compatible output.
4. Closes the SDK query.

Replayed history never enters your real `~/.claude/projects/`. The SDK materializes the transcript into a private temporary directory for the child process and removes it when the child exits, so bridge turns never appear in your interactive `claude --resume` picker.

The child environment removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_TOKEN`, `ANTHROPIC_BASE_URL`, and every `CLAUDE_BRIDGE_*` variable (including the bridge's own token). It also disables auto-loaded settings, skills, hooks, filesystem/cloud MCP servers, auto-memory, and auto-compaction in the default mode.

The bridge uses the Agent SDK's official Claude Code system-prompt preset and never forwards inbound system content as the SDK's system prompt. This boundary is load-bearing for subscription routing: a raw custom system prompt, or appending the full Hermes harness prompt, was observed to route the request through Extra Usage instead. `system` and `developer` messages are instead delivered inside the live user turn, wrapped in a `<system-instructions>` block, so instructions like "always answer in French" still take effect.

### Default and full-agent modes

**Default:** Claude behaves as a clean conversational model. Claude Code tools are disabled. Hermes tool bridging is not implemented yet.

**Full agent:** set `CLAUDE_BRIDGE_FULL_AGENT=1` before starting the bridge. Claude Code gets its own built-in tools with bypass permissions. This is powerful and can read, write, or execute commands starting from `CLAUDE_BRIDGE_CWD` (default `~/.hermes/claude-bridge-workspace`); it still does not execute Hermes tools.

### Roadmap

Hermes tool passthrough is deliberately outside the `0.2.0` scope. The proposed stateful MCP adapter is specified in [GitHub issue #1](https://github.com/ricotrevisan/hermes-claude-bridge/issues/1). Until that work is implemented and hardened, default mode remains tool-free and full-agent mode uses only Claude Code's tools.

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `CLAUDE_BRIDGE_PORT` | `8787` | Local HTTP port. |
| `CLAUDE_BRIDGE_API_KEY` | none (required) | Bearer token every request except `/healthz` must present. The installer generates it. |
| `CLAUDE_BRIDGE_CWD` | process working directory, or `~/.hermes/claude-bridge-workspace` in full-agent mode | Claude Code working directory. |
| `CLAUDE_BRIDGE_CLAUDE_BIN` | SDK bundled executable | Override the Claude Code executable used by the SDK. |
| `CLAUDE_BRIDGE_FULL_AGENT` | unset | Set to `1` for Claude Code's built-in agent tools. |
| `CLAUDE_CONFIG_DIR` | Claude Code default | Alternate Claude Code credentials/session directory. On macOS, setting this requires `~/.claude/.credentials.json` to exist in that directory; a Keychain-only login there cannot be replayed into the SDK's temporary session directory. |

## Development

```bash
npm install
npm test
npm run build
CLAUDE_BRIDGE_API_KEY=dev-token npm run dev
```

Manual smoke test:

```bash
curl localhost:8787/healthz
curl localhost:8787/v1/models -H "Authorization: Bearer $CLAUDE_BRIDGE_API_KEY"
curl localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $CLAUDE_BRIDGE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"Reply with only: bridge-ok"}]}'
```

The normal test suite uses an injected fake SDK query and consumes no Claude quota. A manual smoke test uses the real OAuth subscription.

## Security

The server binds only to `127.0.0.1`, requires the per-install `CLAUDE_BRIDGE_API_KEY` bearer token on every route except `/healthz`, rejects browser `Origin` requests, and requires `application/json`. It refuses to start without a token. Any process that can read `~/.hermes/.env` can still spend subscription quota through it. See [`SECURITY.md`](./SECURITY.md), especially before enabling full-agent mode.

## Attribution and license

The SDK transport, session ideas, and conversion logic are adapted from `pi-claude-bridge` by Eli Dickinson under the MIT License. See [`NOTICE`](./NOTICE).

MIT © Rico Trevisan.
