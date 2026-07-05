#!/usr/bin/env node
// hermes-claude-bridge CLI: install | uninstall | start | help
//
// Fresh installs are disabled by default because this package is deprecated.
// `npx hermes-claude-bridge uninstall` removes historical installs. If someone
// deliberately passes --force-deprecated-install, the service itself runs
// `node dist/server.js` — npx only runs the one-shot installer, never the
// long-lived server.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cmd = process.argv[2];
const rest = process.argv.slice(3);

function help() {
	console.log(`hermes-claude-bridge — DEPRECATED

This bridge is no longer maintained. Use Hermes' native Anthropic provider for
API-key usage, or Hermes' claude-code skill for explicit Claude Code delegation.

Usage:
  npx hermes-claude-bridge uninstall
  npx hermes-claude-bridge install [--force-deprecated-install] [--port N] [--link] [--no-service]
  npx hermes-claude-bridge start [--port N]

Commands:
  uninstall    Remove the plugin and the service from an existing install.
  install      Disabled unless --force-deprecated-install is passed.
  start        Run the deprecated bridge server in the foreground (mainly for cleanup/debugging).

Options:
  --force-deprecated-install  Override the deprecation guard and install anyway.
  --port N                    Port to bind (default 8787, or $CLAUDE_BRIDGE_PORT).
  --link                      Symlink the repo's plugin/ dir instead of copying (dev workflow).
  --no-service                Skip registering the launchd/systemd service.`);
}

async function run(fn) {
	try {
		await fn();
	} catch (e) {
		console.error(`hermes-claude-bridge ${cmd} failed: ${e?.message ?? e}`);
		process.exit(1);
	}
}

switch (cmd) {
	case "install": {
		const { install } = await import("./install.mjs");
		await run(() => install(rest));
		break;
	}
	case "uninstall": {
		const { uninstall } = await import("./uninstall.mjs");
		await run(() => uninstall(rest));
		break;
	}
	case "start":
	case "serve": {
		const portFlag = rest.indexOf("--port");
		if (portFlag !== -1 && rest[portFlag + 1]) process.env.CLAUDE_BRIDGE_PORT = rest[portFlag + 1];
		const { startServer } = await import(join(__dirname, "..", "dist", "server.js"));
		startServer();
		break;
	}
	case "help":
	case "--help":
	case "-h":
	case undefined:
		help();
		break;
	default:
		console.error(`unknown command: ${cmd}\n`);
		help();
		process.exit(1);
}
