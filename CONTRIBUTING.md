# Contributing

Thanks for your interest! This is a small project — issues and PRs welcome.

## Dev setup

```bash
git clone https://github.com/ricotrevisan/hermes-claude-bridge
cd hermes-claude-bridge
npm install
npm test          # unit tests (message conversion + SSE framing)
npm run build     # type-check + esbuild bundle → dist/server.js
npm run dev       # run the bridge from source (tsx)
```

You'll need Claude Code installed and logged in (`claude login`) to exercise the
end-to-end path.

## Guidelines

- **Tests:** the conversion (`src/convert.ts`) and SSE-framing (`src/openai.ts`)
  layers are unit-tested with the Node test runner. Add a failing test before
  fixing a bug or adding behavior, and keep `npm test` green.
- The `claude -p` driver (`src/bridge.ts`) and the HTTP edge (`src/server.ts`)
  are integration-tested manually against a live subscription — describe how you
  verified changes there in the PR.
- Keep the bridge on the **subscription** entrypoint (`claude -p`); don't
  reintroduce the Agent SDK `query()` path (it meters as overage).
- The installer mutates `~/.hermes` and registers an OS service — never run it in
  CI, and keep all changes reversible by `uninstall`.
- Match the existing code style (tabs, the surrounding patterns).

## Releasing (maintainers)

```bash
npm version <patch|minor|major>   # updates package.json + tags
npm publish                       # prepublishOnly runs the build
git push --follow-tags
```
