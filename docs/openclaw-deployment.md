# openclaw deployment context

Operational state of the Hermes host `openclaw` (SSH alias) as of 2026-08-05,
with the v0.3.0 bridge (commit `f8718da`, Hermes tool bridging) deployed. See
`docs/adr/0001-bridge-over-claude-agent-acp.md` for the decision.

## Current state

- Bridge v0.3.0 deployed 2026-08-05 via the stock installer. Source clone:
  `~/src/hermes-claude-bridge` (deploy = `git pull && npm install
  && PATH=~/.hermes/node/bin:$PATH node bin/cli.mjs install`; reinstall is
  idempotent and re-uses the bearer token). **Gotcha:** `dist/` is gitignored,
  so after pulling new code the local `dist/server.js` may be stale — remove it
  (`rm dist/server.js`) before `install` so the installer rebuilds, or the
  health check fails with "port still answers as v0.2.0" against the new
  version string.
- Service `hermes-claude-bridge` (systemd --user) on 127.0.0.1:8787; logs at
  `~/.hermes/logs/claude-bridge.log`; `/healthz` reports
  `{service, version: "0.3.0"}`.
- Verified 2026-08-05: one `hermes -z` turn on `claude-fable-5` via
  `--provider claude-bridge`; a live tool round-trip through :8787
  (Claude → `finish_reason: "tool_calls"` → result delivered → Claude answers
  with it, same turn); no new `request_dump_*.json`, journald clean. Billing:
  success is proof of the subscription lane — the bridge fails overage turns
  (src/bridge.ts) and the account has org-level overage disabled.
- SDK pinned at 0.3.220 (was 0.2.141). The newer bundled Claude Code refreshes
  genuinely-expired OAuth tokens that 0.2.141's bundled CLI wedged on — the
  recurring "OAuth access token has expired" 401 that broke turns ~8h after
  the last login is fixed by this bump alone.
- Hermes tool bridging ships in 0.3.0: sending `tools` in a completion request
  exposes those schemas to Claude via an in-process MCP server; the bridge
  never executes tools (Hermes stays the tool authority). Full-agent mode
  (`CLAUDE_BRIDGE_FULL_AGENT`) was removed.
- Known wart: the SDK reports usage under `claude-fable-5[1m]` /
  `claude-opus-5[1m]` keys; the bridge's measured catalog logs "no modelUsage
  entry" drift warnings until the catalog learns the `[1m]` variants.
- Hermes v0.19.1, editable git checkout at `~/.hermes/hermes-agent`, updated
  2026-08-02 to upstream HEAD `26e0b1c1` via `hermes update --yes`.
- **Local hermes patch (uncommitted working-tree change)**: `resolve_provider_full`
  falls back to the plugin registry so `/model … --provider claude-bridge` and
  `hermes doctor` accept plugin-only providers. Artifact:
  `docs/patches/hermes-plugin-provider-resolution.patch` in this repo; reapply
  with `git apply` if the checkout is ever reset. `hermes update` auto-stashes
  and restores it (files untouched upstream). Upstream: same bug is
  NousResearch/hermes-agent#69576 with pending fix PR #69993 (same shape,
  plus switch_model tests) — once that merges, DISCARD the local patch
  (`git checkout -- hermes_cli/providers.py`, or skip the stash restore during
  that `hermes update`) instead of restoring it, or the two blocks will
  collide in the same function tail.
- `providers.claude-bridge` was **removed from config.yaml** (2026-08-02, option
  B): the plugin registers the provider natively, the config entry only
  produced a duplicate picker row and `billing_provider: custom` labels.
  `model.provider` is now the plugin slug `claude-bridge`. Backup:
  `config.yaml.bak-optB-20260802-143157`.
- Active model config: currently `gpt-5.6-sol` / `openai-codex` (Rico switched back
  after the 0.2.1-era 401 wedge; the bridge is reachable per-session via
  `/model … --provider claude-bridge` or a `model_override`). Deploying 0.3.0 did
  not change the default.
- Backups on openclaw: `~/.hermes/config.yaml.bak-bridge-v020-install-20260802-135118`
  and `.env.bak-bridge-v020-install-20260802-135118` (pre-install), plus the
  older `bak-pre-claude-acp` / `bak-pre-decommission` series.

## Dormant claude-agent-acp path (leave in place)

- `@agentclientprotocol/claude-agent-acp@0.64.0` installed at `~/.local/bin/`
  (npm global prefix is `~/.local`).
- Wrapper `~/.local/bin/claude-agent-acp-hermes`: pins PATH to
  `~/.hermes/node/bin` (node v22.x for the shebang), **unsets
  `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_TOKEN`/`ANTHROPIC_BASE_URL`**,
  then execs the adapter by absolute path.
- `HERMES_COPILOT_ACP_COMMAND=/home/rico/.local/bin/claude-agent-acp-hermes` in
  `~/.hermes/.env`.
- `~/.claude/settings.json` has `permissions.defaultMode: "bypassPermissions"`
  (global for all Claude/SDK sessions on openclaw) plus `effortLevel: high`.
- To use it: `hermes model` → provider `copilot-acp`. Claude Code then runs the
  turn with its own tools (delegation semantics, ~10 s spawn per turn).

## Billing invariants (the reason everything above exists)

- Claude auth on openclaw: `~/.claude/.credentials.json`, OAuth,
  `subscriptionType: "max"`, account r@rico.wtf.
- `~/.hermes/.env` contains `ANTHROPIC_API_KEY` and `ANTHROPIC_TOKEN`, and
  Hermes' copilot shim spawns children with `inherit_credentials=True` — any
  Claude-side child process **must strip these** or billing silently flips to
  API. The bridge's `childEnvironment()` and the wrapper both do this.
- Ground-truth telemetry: SDK `rate_limit_event` → `rate_limit_info`. Healthy
  subscription turn: `rateLimitType: "five_hour"`, `isUsingOverage: false`.
  The account has overage disabled org-level (`overageStatus: "rejected"`,
  `org_level_disabled`), so misrouted turns fail rather than bill.
- Hermes writes failed API requests to `~/.hermes/sessions/request_dump_*.json`
  — first place to look when turns fail (that's where the old bridge's
  "out of extra usage" failure was found).

## Redeploy checklist (done 2026-08-02 — kept for the next upgrade)

Steps 1–4 of the old manual checklist are now the installer's job. Upgrading:

1. On openclaw: `cd ~/src/hermes-claude-bridge && git pull && npm install &&
   PATH=~/.hermes/node/bin:$PATH node bin/cli.mjs install`. Run the installer
   with the `~/.hermes/node` binary on PATH — the service `ExecStart` inherits
   `process.execPath`. Keep `model.default` on `gpt-5.6-sol` (install doesn't
   touch it).
2. Restart `hermes-gateway` + `hermes-webui`; the picker cache
   (`~/.hermes/provider_models_cache.json`) repopulates on catalog fetch.
3. Verify: one turn on `claude-fable-5` and one on `claude-opus-5` via
   `hermes -z` (or the Discord picker), then confirm no
   `request_dump_*` appears and journald (`journalctl --user -u
   hermes-claude-bridge`) is clean. A routing regression must surface as the
   bridge's own 402 "overage" refusal, never as silent API billing.

## Tooling notes

- ACP probe scripts (generic, reusable): `/tmp/acp-subscription-probe.mjs` and
  `/tmp/acp-tool-probe.mjs` on both the Mac and openclaw — drive
  initialize → session/new → session/prompt and print rate-limit telemetry,
  tool calls, and permission traffic.
- The Mac's npm has a registry time-travel pin (`before=2026-07-30T07:43Z`);
  bypass per-invocation with `npm_config_before= npm_config_min_release_age=0`
  when installing newer packages. openclaw has no such pin.
