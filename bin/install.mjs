// Installer for hermes-claude-bridge.
//
// 1. Copy the server to a STABLE app dir ($HERMES_HOME/claude-bridge/) and
//    install the pinned Agent SDK runtime there, outside the ephemeral npx cache.
// 2. Write the Hermes model-provider plugin to $HERMES_HOME/plugins/model-providers/claude-bridge/.
// 3. Add a providers entry to config.yaml + a placeholder key to .env so the
//    `hermes model` picker and runtime both recognize the provider.
// 4. Register a background auto-start service (launchd on macOS, systemd --user
//    on Linux) running the stable server copy. Health-check, print next steps.

import { execFileSync, execSync } from "node:child_process";
import { createConnection } from "node:net";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, parseDocument } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");
const LABEL = "com.ricotrevisan.hermes-claude-bridge";
const DEFAULT_PORT = "8787";
const ENV_KEY = "CLAUDE_BRIDGE_API_KEY";
const ENV_VALUE = "claude-code-subscription";
const PACKAGE_JSON = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
const AGENT_SDK_VERSION = PACKAGE_JSON.dependencies?.["@anthropic-ai/claude-agent-sdk"];
if (!/^\d+\.\d+\.\d+$/.test(AGENT_SDK_VERSION ?? "")) {
	throw new Error("package.json must pin @anthropic-ai/claude-agent-sdk to an exact version");
}

function parseArgs(argv) {
	const args = { port: process.env.CLAUDE_BRIDGE_PORT || DEFAULT_PORT, link: false, service: true };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--port") args.port = argv[++i];
		else if (argv[i] === "--link") args.link = true;
		else if (argv[i] === "--no-service") args.service = false;
	}
	if (!/^\d+$/.test(String(args.port)) || Number(args.port) < 1 || Number(args.port) > 65535) {
		throw new Error(`--port must be an integer 1-65535 (got ${args.port})`);
	}
	return args;
}

function hermesHome() {
	return process.env.HERMES_HOME || join(homedir(), ".hermes");
}

function stableRuntimeDir() {
	return join(hermesHome(), "claude-bridge");
}

// Escape values interpolated into the launchd plist XML.
function xmlEscape(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

// Build dist/server.js (bundled) if it's missing — only happens for a local
// clone; the published package ships dist/.
function ensureDist() {
	const distServer = join(PKG_ROOT, "dist", "server.js");
	if (existsSync(distServer)) return distServer;
	console.log("• Building dist/ …");
	try {
		execSync("npm run build", { cwd: PKG_ROOT, stdio: "inherit" });
	} catch {
		throw new Error("could not build dist/server.js — run `npm install && npm run build` in the package dir first");
	}
	if (!existsSync(distServer)) throw new Error("build did not produce dist/server.js");
	return distServer;
}

// Copy the server into a stable location so the service survives npx-cache
// eviction, then install the Agent SDK beside it. The SDK is intentionally not
// bundled: it discovers its platform-specific Claude Code executable relative
// to its own package directory.
function installRuntime(distServer) {
	const dir = stableRuntimeDir();
	mkdirSync(dir, { recursive: true });
	const stableServer = join(dir, "server.js");
	copyFileSync(distServer, stableServer);
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({
			name: "hermes-claude-bridge-runtime",
			private: true,
			type: "module",
			dependencies: { "@anthropic-ai/claude-agent-sdk": AGENT_SDK_VERSION },
		}, null, 2) + "\n",
	);
	console.log(`• Installing Claude Agent SDK ${AGENT_SDK_VERSION} runtime (includes a platform-specific Claude Code executable)…`);
	try {
		execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--save-exact"], {
			cwd: dir,
			stdio: "inherit",
		});
	} catch (error) {
		throw new Error(
			`could not install the Claude Agent SDK runtime in ${dir}; ensure npm can reach the registry and re-run install`,
			{ cause: error },
		);
	}
	return stableServer;
}

function writePlugin(pluginDir, port, link) {
	mkdirSync(pluginDir, { recursive: true });
	if (link) {
		for (const f of ["__init__.py", "plugin.yaml"]) {
			const target = join(pluginDir, f);
			if (existsSync(target)) rmSync(target);
			symlinkSync(join(PKG_ROOT, "plugin", f), target);
		}
		return;
	}
	let init = readFileSync(join(PKG_ROOT, "plugin", "__init__.py"), "utf8");
	init = init.replace('os.environ.get("CLAUDE_BRIDGE_PORT", "8787")', `os.environ.get("CLAUDE_BRIDGE_PORT", "${port}")`);
	writeFileSync(join(pluginDir, "__init__.py"), init);
	writeFileSync(join(pluginDir, "plugin.yaml"), readFileSync(join(PKG_ROOT, "plugin", "plugin.yaml"), "utf8"));
}

function ensureEnvKey() {
	const envPath = join(hermesHome(), ".env");
	let lines = [];
	if (existsSync(envPath)) {
		lines = readFileSync(envPath, "utf8").split("\n");
		if (lines.some((l) => l.trim().startsWith(`${ENV_KEY}=`))) {
			return { envPath, added: false };
		}
		if (lines.length && lines[lines.length - 1] !== "") lines.push("");
	}
	lines.push(`${ENV_KEY}=${ENV_VALUE}`);
	if (lines[lines.length - 1] !== "") lines.push("");
	writeFileSync(envPath, lines.join("\n"));
	return { envPath, added: true };
}

// Add providers.claude-bridge to config.yaml (the system the `hermes model`
// switch uses). Validates the file is a YAML map first, preserves comments and
// any user-added sibling keys under the entry.
function ensureConfigProvider(port) {
	const configPath = join(hermesHome(), "config.yaml");
	let doc;
	if (existsSync(configPath)) {
		doc = parseDocument(readFileSync(configPath, "utf8"));
		if (doc.errors && doc.errors.length) {
			throw new Error(`~/.hermes/config.yaml has YAML errors — fix it and re-run: ${doc.errors[0].message}`);
		}
		if (doc.contents != null && !isMap(doc.contents)) {
			throw new Error("~/.hermes/config.yaml is not a YAML mapping — cannot add a providers entry");
		}
	} else {
		doc = parseDocument("{}");
	}

	const existed = doc.hasIn(["providers", "claude-bridge"]);
	const owned = {
		name: "Claude Bridge (Claude Code subscription)",
		base_url: `http://127.0.0.1:${port}/v1`,
		key_env: ENV_KEY,
		transport: "openai_chat",
		api_mode: "chat_completions",
	};
	// Preserve any user-added sibling keys on an existing entry.
	let merged = owned;
	if (existed) {
		const cur = doc.getIn(["providers", "claude-bridge"]);
		const curObj = cur && typeof cur.toJSON === "function" ? cur.toJSON() : {};
		merged = { ...curObj, ...owned };
	}
	doc.setIn(["providers", "claude-bridge"], merged);
	const providersNode = doc.getIn(["providers"], true);
	if (providersNode && providersNode.flow) providersNode.flow = false;
	const entryNode = doc.getIn(["providers", "claude-bridge"], true);
	if (entryNode && entryNode.flow) entryNode.flow = false;
	writeFileSync(configPath, doc.toString());
	return { configPath, existed };
}

function servicePath(node, stableServer, port, logFile) {
	if (platform() === "darwin") {
		// Include the install-time PATH so the spawned `claude` (nvm/mise/brew/
		// npm-global) is discoverable, plus the usual fallbacks.
		const homePaths = `${dirname(node)}:${process.env.PATH || ""}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${join(homedir(), ".local", "bin")}`;
		const x = xmlEscape;
		return {
			file: join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`),
			contents: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${x(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${x(node)}</string>
    <string>${x(stableServer)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>WorkingDirectory</key><string>${x(homedir())}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${x(homePaths)}</string>
    <key>CLAUDE_BRIDGE_PORT</key><string>${x(port)}</string>
  </dict>
  <key>StandardOutPath</key><string>${x(logFile)}</string>
  <key>StandardErrorPath</key><string>${x(logFile)}</string>
</dict>
</plist>
`,
		};
	}
	// Linux: systemd --user unit. Quote ExecStart args (paths may contain spaces);
	// include the install-time PATH (systemd --user does NOT inherit the login PATH).
	const linuxPath = `${dirname(node)}:${(process.env.PATH || "/usr/local/bin:/usr/bin:/bin").replace(/[\r\n]/g, "")}`;
	return {
		file: join(homedir(), ".config", "systemd", "user", "hermes-claude-bridge.service"),
		contents: `[Unit]
Description=Hermes Claude Bridge (Claude Code subscription provider)
After=network.target

[Service]
ExecStart="${node}" "${stableServer}"
Environment=PATH=${linuxPath}
Environment=CLAUDE_BRIDGE_PORT=${port}
WorkingDirectory=${homedir()}
Restart=on-failure
RestartSec=3
StandardOutput=append:${logFile}
StandardError=append:${logFile}

[Install]
WantedBy=default.target
`,
	};
}

function portIsFree(port) {
	return new Promise((resolve) => {
		const sock = createConnection({ host: "127.0.0.1", port }, () => {
			sock.destroy();
			resolve(false);
		});
		sock.on("error", () => resolve(true));
		sock.setTimeout(500, () => {
			sock.destroy();
			resolve(true);
		});
	});
}

async function waitForPortFree(port, attempts = 20) {
	for (let i = 0; i < attempts; i++) {
		if (await portIsFree(port)) return;
		await new Promise((r) => setTimeout(r, 250));
	}
}

async function installService(node, stableServer, port, logFile) {
	const svc = servicePath(node, stableServer, port, logFile);
	mkdirSync(dirname(svc.file), { recursive: true });
	writeFileSync(svc.file, svc.contents);

	if (platform() === "darwin") {
		const uid = process.getuid();
		const domain = `gui/${uid}`;
		try {
			execFileSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
		} catch {
			/* not loaded */
		}
		await waitForPortFree(port);
		execFileSync("launchctl", ["bootstrap", domain, svc.file], { stdio: "inherit" });
		try {
			execFileSync("launchctl", ["kickstart", "-k", `${domain}/${LABEL}`], { stdio: "ignore" });
		} catch {
			/* RunAtLoad already started it */
		}
		return { svcFile: svc.file, activated: true };
	}

	// Linux: systemd --user may be unreachable over SSH / without lingering.
	console.log("• Tip: to start the bridge before you log in: loginctl enable-linger $USER");
	try {
		execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
		execFileSync("systemctl", ["--user", "enable", "hermes-claude-bridge.service"], { stdio: "inherit" });
		// `enable --now` leaves an already-active process untouched, which means a
		// reinstall can report healthy while still serving the previous bundle.
		execFileSync("systemctl", ["--user", "restart", "hermes-claude-bridge.service"], { stdio: "inherit" });
		return { svcFile: svc.file, activated: true };
	} catch {
		console.log(
			"• ⚠️  Could not activate the systemd --user service in this session\n" +
				"    (common over SSH or without a login session). To finish:\n" +
				"      loginctl enable-linger $USER\n" +
				"      systemctl --user daemon-reload && systemctl --user enable --now hermes-claude-bridge.service\n" +
				"    Or run it manually:  hermes-claude-bridge start",
		);
		return { svcFile: svc.file, activated: false };
	}
}

async function healthCheck(port, attempts = 40) {
	const url = `http://127.0.0.1:${port}/healthz`;
	for (let i = 0; i < attempts; i++) {
		try {
			const res = await fetch(url);
			if (res.ok) return true;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	return false;
}

export async function install(argv) {
	if (platform() === "win32") {
		throw new Error(
			"Windows is not supported yet — use WSL. (You can still run the bridge manually with " +
				"`hermes-claude-bridge start` and add providers.claude-bridge to ~/.hermes/config.yaml by hand.)",
		);
	}

	const { port, link, service } = parseArgs(argv);
	const node = process.execPath;
	const home = hermesHome();

	// Transparency: state what will change before mutating anything.
	console.log(`hermes-claude-bridge install — this will:
  • copy the bridge server to ${stableRuntimeDir()}
  • write a provider plugin to ${join(home, "plugins", "model-providers", "claude-bridge")}
  • add a placeholder ${ENV_KEY} to ${join(home, ".env")} (the bridge ignores its value)
  • add providers.claude-bridge to ${join(home, "config.yaml")}${service ? `\n  • register a background auto-start service (${platform() === "darwin" ? "launchd" : "systemd --user"})` : ""}
  • install the Agent SDK runtime and force OAuth subscription auth for every turn
  (reverse all of this any time with: hermes-claude-bridge uninstall)
`);

	const distServer = ensureDist();
	const stableServer = installRuntime(distServer);
	console.log(`• Runtime → ${stableServer}`);

	const pluginDir = join(home, "plugins", "model-providers", "claude-bridge");
	console.log(`• Plugin → ${pluginDir}${link ? " (symlinked)" : ""}`);
	writePlugin(pluginDir, port, link);

	const { envPath, added } = ensureEnvKey();
	console.log(`• ${added ? "Wrote" : "Found"} ${ENV_KEY} in ${envPath} (placeholder — ignored)`);

	const { configPath, existed } = ensureConfigProvider(port);
	console.log(`• ${existed ? "Updated" : "Added"} providers.claude-bridge in ${configPath}`);

	const logsDir = join(home, "logs");
	mkdirSync(logsDir, { recursive: true });
	const logFile = join(logsDir, "claude-bridge.log");

	if (service) {
		console.log(`• Registering auto-start service (port ${port})…`);
		const { svcFile, activated } = await installService(node, stableServer, port, logFile);
		console.log(`• Service: ${svcFile}`);
		console.log(`• Logs: ${logFile}`);
		if (activated) {
			const ok = await healthCheck(port);
			console.log(ok ? `• Bridge is up on http://127.0.0.1:${port}` : "• ⚠️  Bridge did not answer /healthz yet — check the log.");
		}
	} else {
		console.log("• Skipped service (--no-service). Run it with: hermes-claude-bridge start  (or: npm run dev)");
	}

	console.log(`
✅ Installed.

Next steps:
  1. Make sure Claude Code is logged in:   claude login
  2. Pick the provider AND a model:        hermes model  → 'claude-bridge' → e.g. claude-opus-5
     (or in a running session:  /model claude-opus-5 --provider claude-bridge)
     If a Hermes session is already open, restart it so it re-reads config.yaml.
  3. Chat as usual — Agent SDK turns run on your Claude subscription (no API key).

Notes:
  • The bridge listens on 127.0.0.1:${port} and is reachable only locally.
  • The Agent SDK runtime includes a platform-specific Claude Code executable (~200 MB).
  • Re-run install after upgrading the package to refresh the stable runtime copy.
  • Uninstall with: hermes-claude-bridge uninstall`);
}

// Allow direct execution: node bin/install.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
	install(process.argv.slice(2)).catch((e) => {
		console.error(`install failed: ${e?.message ?? e}`);
		console.error("If install stopped midway, run `hermes-claude-bridge uninstall` to roll back.");
		process.exit(1);
	});
}
