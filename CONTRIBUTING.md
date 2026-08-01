# Contributing

Thanks for your interest! This is a small project — issues and PRs welcome.

## Dev setup

```bash
git clone https://github.com/ricotrevisan/hermes-claude-bridge
cd hermes-claude-bridge
npm install
npm test          # unit tests (message conversion + SSE framing)
npm run build     # type-check + esbuild bundle → dist/server.js
CLAUDE_BRIDGE_API_KEY=dev-token npm run dev   # run the bridge from source (tsx)
```

The bridge refuses to start without `CLAUDE_BRIDGE_API_KEY`; it validates that
value as the bearer token on every request except `/healthz`.

You'll need Claude Code installed and logged in (`claude login`) to exercise the
end-to-end path.

## Guidelines

- **Tests:** the conversion (`src/convert.ts`) and SSE-framing (`src/openai.ts`)
  layers are unit-tested with the Node test runner. Add a failing test before
  fixing a bug or adding behavior, and keep `npm test` green.
- The Agent SDK driver (`src/bridge.ts`) is tested offline through its injected
  `queryFn` seam. The HTTP edge can also be smoke-tested manually against a live
  subscription; describe any live verification in the PR.
- Keep authentication subscription-only: strip Anthropic API-key/base-URL and
  `CLAUDE_BRIDGE_*` variables from the child environment, require first-party
  subscription account metadata, and reject explicit SDK API-key credential sources.
- Pin and deliberately test Agent SDK upgrades. Its bundled Claude Code runtime,
  message shapes, and subscription entitlement can change independently.
- The installer mutates `~/.hermes` and registers an OS service — never run it in
  CI, and keep all changes reversible by `uninstall`.
- Match the existing code style (tabs, the surrounding patterns).

## Releasing (maintainers)

```bash
npm version <patch|minor|major>   # updates package.json + tags
npm publish                       # prepublishOnly runs the build
git push --follow-tags
```
