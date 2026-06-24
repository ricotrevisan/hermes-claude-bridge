# hermes-claude-bridge

Use **Claude** — powered by your **Claude Code Pro/Max subscription** — as a model
provider for the [Hermes agent](https://github.com/NousResearch/hermes-agent).
**No `ANTHROPIC_API_KEY` required.** Ported/adapted from
[`pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge) (the same
idea for the Pi agent).

```
Hermes ──HTTP (OpenAI chat/completions)──▶  local bridge server  ──▶  claude -p (stream-json)
        base_url=http://127.0.0.1:8787/v1     (this package, Node)      (Claude Code subscription)
```

The bridge is a tiny local HTTP server that speaks the **OpenAI Chat Completions**
API. Each request is run through your installed Claude Code CLI in print mode
(`claude -p --output-format stream-json`), and its streamed events are translated
back into OpenAI SSE. A declarative Hermes **provider plugin** points Hermes at
the bridge — Hermes reaches it over plain `chat_completions` HTTP and spawns
nothing itself.

> **Why `claude -p` and not the Claude Agent SDK?** The Agent SDK spawns its own
> bundled CLI tagged `CLAUDE_CODE_ENTRYPOINT=sdk-ts`, which Anthropic meters as
> SDK/API usage — it draws *extra usage* (overage), not your subscription
> allowance. The standalone `claude -p` (and `acp`) is the entrypoint Anthropic
> allows to run on the Pro/Max subscription. The bridge therefore shells out to
> your installed `claude` binary.

---

## Prerequisites

- **Claude Code installed and logged in** to a Pro/Max subscription: `claude login`.
  The bridge runs `claude` from your `PATH` (override with `CLAUDE_BRIDGE_CLAUDE_BIN`).
- **Hermes agent installed** (`hermes` on your `PATH`, `~/.hermes/` present).
- **Node.js ≥ 20.**
- **macOS or Linux.** (Windows: use WSL.)

---

## Install

```bash
npx hermes-claude-bridge install
```

This (it prints exactly what it will change first):

1. Copies the self-contained bridge server to `~/.hermes/claude-bridge/` (a stable
   location, so the background service never depends on an npx cache).
2. Writes the Hermes provider plugin to `~/.hermes/plugins/model-providers/claude-bridge/`.
3. Adds a placeholder `CLAUDE_BRIDGE_API_KEY` to `~/.hermes/.env` and a
   `providers.claude-bridge` entry to `~/.hermes/config.yaml` (see
   [What it changes](#what-the-installer-changes)).
4. Registers a background **auto-start service** running the stable server copy:
   - **macOS** — a `launchd` user agent (`RunAtLoad` + `KeepAlive`), logging to
     `~/.hermes/logs/claude-bridge.log`.
   - **Linux** — a `systemd --user` unit. Run `loginctl enable-linger $USER` once
     to start it before login.

Then, in Hermes:

```bash
hermes model     # pick 'claude-bridge', then pick a model (e.g. claude-opus-4-8)
```

That's it — turns now run on your Claude Code subscription. (If a Hermes session
is already open, restart it so it re-reads `config.yaml`. You must pick a specific
model — the bridge advertises three and Hermes only auto-picks when an endpoint
exposes exactly one.)

### Options

```bash
npx hermes-claude-bridge install --port 9000   # bind a different port (baked into the plugin + service)
npx hermes-claude-bridge install --no-service  # skip the service; run it yourself with 'hermes-claude-bridge start'
npx hermes-claude-bridge install --link        # symlink the repo's plugin/ dir (dev workflow)
```

### Uninstall

```bash
npx hermes-claude-bridge uninstall
```

Removes the service, the stable runtime copy, the plugin dir, the
`providers.claude-bridge` config entry, and the placeholder key (a key you set
yourself is left untouched). Your Claude Code login is unaffected.

---

## What the installer changes

For transparency — installing mutates these, and `uninstall` reverses all of them:

| Path | Change |
| --- | --- |
| `~/.hermes/claude-bridge/` | Self-contained server copy (created). |
| `~/.hermes/plugins/model-providers/claude-bridge/` | Provider plugin (`__init__.py` + `plugin.yaml`). |
| `~/.hermes/.env` | One placeholder line `CLAUDE_BRIDGE_API_KEY=…` (the bridge ignores its value; Hermes just needs *a* key to route). |
| `~/.hermes/config.yaml` | A `providers.claude-bridge` entry (comment-preserving; your other keys untouched). |
| launchd plist / systemd unit | The auto-start service. |

**Security/trust note:** the bridge binds to `127.0.0.1` only and is reachable
only from your machine. It runs on *your* Claude Code subscription, can read your
`~/.hermes` config, and (in full-agent mode) lets Claude run tools in a working
directory. At startup it unsets `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` /
`ANTHROPIC_BASE_URL` so turns can't silently fall through to a metered API key.
The source is small — read `src/` before trusting it.

---

## How it works

- **Endpoints:** `POST /v1/chat/completions` (streaming + non-streaming),
  `GET /v1/models`, `GET /healthz`. Bound to `127.0.0.1` only.
- **Inbound:** OpenAI `messages[]` → Anthropic-shaped messages. The trailing user
  turn becomes the live prompt; prior turns are replayed into a resumable
  [`cc-session-io`](https://www.npmjs.com/package/cc-session-io) session and
  continued via `claude --resume`, so multi-turn context is preserved.
- **Outbound:** the CLI's `stream-json` events are translated to OpenAI SSE — text
  deltas → `choices[0].delta.content`, thinking → `delta.reasoning_content`, then a
  chunk carrying `finish_reason`, a final `choices: []` chunk with `usage`, and
  `data: [DONE]` (the exact shape Hermes' streaming consumer requires).

### Clean assistant (default) vs. full agent

- **Clean assistant (default):** Claude answers as a plain conversational model —
  no tools (`--tools ""`), no MCP (`--strict-mcp-config`), no hooks
  (`--settings '{"disableAllHooks":true}'`), and a replaced system prompt (the
  inbound Hermes system prompt, or a minimal default). This keeps your Claude Code
  setup (skills, auto-memory, hooks) from leaking side-actions or tool narration
  into chat answers.
- **Full agent (`CLAUDE_BRIDGE_FULL_AGENT=1`):** Claude runs with your complete
  Claude Code config and its **own** tools (Read/Write/Bash/… via
  `bypassPermissions`), operating in `CLAUDE_BRIDGE_CWD` (default: your home dir).
  More capable, but verbose and prone to agentic side-actions on simple turns.
  Hermes' own tools are not used in either mode — the bridge streams text only.

---

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `CLAUDE_BRIDGE_PORT` | `8787` | Port the bridge binds (must match the plugin's `base_url`; the installer keeps them in sync). |
| `CLAUDE_BRIDGE_CWD` | home dir | Working directory Claude operates in (full-agent file/bash tools). |
| `CLAUDE_BRIDGE_CLAUDE_BIN` | `claude` | Path to the Claude Code CLI if it isn't on `PATH`. |
| `CLAUDE_BRIDGE_FULL_AGENT` | unset | `1` → full-agent mode (see above). |
| `CLAUDE_BRIDGE_DEBUG` | unset | `1` → log SDK message shapes + errors to stderr / the service log. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Honored for session files + credentials (standard Claude Code). |

Advertised models: `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`
(aliases `opus`, `sonnet`, `haiku` also resolve).

---

## Development

```bash
npm install
npm test          # unit tests (message conversion + SSE framing)
npm run build     # type-check (tsc --noEmit) + esbuild bundle → dist/server.js
npm run dev       # run the bridge from source via tsx (no build step)
```

Symlink workflow (edit the repo, no copy):

```bash
npx hermes-claude-bridge install --link --no-service
export CLAUDE_BRIDGE_PORT=8787   # in the same shell as both the bridge and hermes
npm run dev
```

Manual checks:

```bash
curl localhost:8787/healthz
curl localhost:8787/v1/models
curl localhost:8787/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"say hi"}]}'
```

---

## Troubleshooting

- **`Claude Code is not authenticated`** — run `claude login` (Pro/Max) and
  restart the bridge. The bridge has no API key of its own.
- **`You're out of extra usage`** — your Claude subscription window is exhausted.
  This comes from Claude, not the bridge. Verify with `claude -p "hi"` directly: if
  that also fails, wait for your window to reset (the bridge uses the same path).
- **`Could not run the Claude Code CLI`** — `claude` isn't on the service's `PATH`.
  Ensure Claude Code is installed/logged in and re-run the installer, or set
  `CLAUDE_BRIDGE_CLAUDE_BIN` to its absolute path.
- **`Unknown provider 'claude-bridge'`** in the picker — the `config.yaml` entry is
  missing; re-run the installer, then restart the Hermes session.
- **Port already in use** — stop the other listener or install with `--port`. The
  service self-heals once the port frees.
- **Check the bridge** — `curl localhost:8787/healthz`, then read
  `~/.hermes/logs/claude-bridge.log`. `CLAUDE_BRIDGE_DEBUG=1` adds verbose tracing.
- **Service stopped after upgrading the npm package** — re-run
  `npx hermes-claude-bridge install` to refresh the stable runtime copy.

---

## Acknowledgments

The Claude driver and message-conversion logic were ported/adapted from
[pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) by Eli
Dickinson (MIT). See [`NOTICE`](./NOTICE).

## License

MIT © Rico Trevisan. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
