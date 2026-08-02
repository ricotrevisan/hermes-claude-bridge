# 0001 — Redeploy the bridge (thin mode) instead of claude-agent-acp for selectable Claude models

Status: accepted (2026-08-01)

## Context

Requirement on the openclaw Hermes deployment: default model stays `gpt-5.6-sol`
(openai-codex); Claude models (`claude-fable-5`, `claude-opus-5`) must be
selectable on demand from the Hermes model pickers (Discord/TUI); billing must
come from the Claude Max subscription, never API/Extra Usage.

Two candidates were evaluated hands-on:

1. **Hermes' `copilot-acp` provider pointed at `@agentclientprotocol/claude-agent-acp`**
   (no bridge code at all). Proven working end-to-end on subscription quota:
   the adapter locks the SDK `systemPrompt` to the `claude_code` preset and
   forwards billing telemetry (`_meta["_claude/rateLimit"]`, `isUsingOverage:
   false`, `five_hour` window). But Hermes' shim sends the picked model only as
   *prompt text* ("model hint") — the real model is chosen Claude-side
   (`~/.claude/settings.json`), so per-pick Fable/Opus switching is impossible
   without patching the Hermes checkout. Hermes pickers also filter the
   provider out entirely. Semantics differ too: Claude Code runs its own tools
   (delegation), bypassing Hermes' toolset.
2. **This bridge (thin mode)** — an OpenAI-compatible localhost endpoint.
   Models appear natively in every Hermes picker; Hermes remains the agent.

## Why the deployed bridge had failed

The openclaw deployment was a pre-revival build. Request dump
`request_dump_20260731_133746_*` shows the failure: `API Error: 400 You're out
of extra usage`. That build forwarded Hermes' harness system prompt, which
makes Anthropic route SDK turns to Extra Usage instead of subscription quota;
the pool exhausted and every turn 400'd. The v0.2.0 revival fixes exactly
this: `claude_code`-preset-locked system prompt (the same load-bearing trick
claude-agent-acp uses), first-party subscription account verification, and
hard 402 refusal when `rate_limit_info.isUsingOverage` is true.

## Decision

Deploy the v0.2.0 revival to openclaw as the selectable-Claude provider. Keep
the claude-agent-acp path installed but dormant (wrapper + env override) for
optional full Claude-Code delegation later.

## Consequences

- One localhost service to operate again (systemd user unit, port 8787).
- Extra Usage is now impossible twice over: the revival fails turns with 402
  client-side, and the account has overage disabled org-level (fails closed).
- Deployment state, artifact inventory, and verification recipe live in
  `docs/openclaw-deployment.md`.
