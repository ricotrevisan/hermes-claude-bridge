# hermes-claude-bridge

Local OpenAI-compatible bridge that lets the Hermes agent use Claude models
through the Claude Agent SDK on a Claude Pro/Max subscription. See `README.md`
for architecture and `SECURITY.md` for the billing-safety boundaries — those
boundaries are regression-tested and load-bearing; do not weaken them casually.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root (created lazily). See `docs/agents/domain.md`.
