#!/usr/bin/env node
// hermes-claude-bridge CLI: install | uninstall | start | help

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cmd = process.argv[2];
const rest = process.argv.slice(3);

function help() {
	console.log(`hermes-claude-bridge

Use Claude models from Hermes through the Claude Agent SDK and your Claude
subscription OAuth login. The bridge exposes a localhost OpenAI-compatible API.

Usage:
  npx hermes-claude-bridge install [--port N] [--link] [--no-service]
  npx hermes-claude-bridge uninstall
  npx hermes-claude-bridge start [--port N]

Commands:
  install      Install the Hermes provider, stable SDK runtime, and optional service.
  uninstall    Remove the provider, runtime, and service.
  start        Run the bridge server in the foreground.

Options:
  --port N      Port to bind (default 8787, or $CLAUDE_BRIDGE_PORT).
  --link        Symlink the repo's plugin/ dir instead of copying (dev workflow).
  --no-service  Skip registering the launchd/systemd service.`);
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
