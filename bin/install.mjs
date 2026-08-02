// Installer for hermes-claude-bridge.
//
// 1. Copy the server to a STABLE app dir ($HERMES_HOME/claude-bridge/) and
//    install the pinned Agent SDK runtime there, outside the ephemeral npx cache.
// 2. Write the Hermes model-provider plugin to $HERMES_HOME/plugins/model-providers/claude-bridge/.
// 3. Add a providers entry to config.yaml + a per-install bearer token to .env
//    so the `hermes model` picker and runtime both recognize the provider and
//    can authenticate to the bridge.
// 4. Register a background auto-start service (launchd on macOS, systemd --user
//    on Linux) running the stable server copy. Health-check, print next steps.

import { execFileSync, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
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
// Identity the server reports on /healthz (src/server.ts) — keep in sync.
const SERVICE_NAME = "hermes-claude-bridge";
// The value 0.1.x installs wrote when the server still ignored the header.
const LEGACY_PLACEHOLDER = "claude-code-subscription";
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

// A prior `install --link` leaves symlinks at these paths; writeFileSync would
// follow them and corrupt the source checkout. rename(2) replaces the path
// itself — symlink included — without following it, so temp file + rename is
// symlink-safe and atomic: no window with a missing or half-written file.
function writeFileReplacing(target, content) {
	const tmp = `${target}.tmp`;
	writeFileSync(tmp, content);
	renameSync(tmp, target);
}

export function writePlugin(pluginDir, port, link, srcDir = join(PKG_ROOT, "plugin")) {
	mkdirSync(pluginDir, { recursive: true });
	if (link) {
		for (const f of ["__init__.py", "plugin.yaml"]) {
			const target = join(pluginDir, f);
			rmSync(target, { force: true }); // also clears dangling symlinks existsSync misses
			symlinkSync(join(srcDir, f), target);
		}
		return;
	}
	let init = readFileSync(join(srcDir, "__init__.py"), "utf8");
	init = init.replace('os.environ.get("CLAUDE_BRIDGE_PORT", "8787")', `os.environ.get("CLAUDE_BRIDGE_PORT", "${port}")`);
	writeFileReplacing(join(pluginDir, "__init__.py"), init);
	writeFileReplacing(join(pluginDir, "plugin.yaml"), readFileSync(join(srcDir, "plugin.yaml"), "utf8"));
}

// The bridge and Hermes share one secret: the server validates it as a bearer
// token, Hermes sends it via key_env. Reuse an existing real token so a re-run
// doesn't lock out a running Hermes session; replace the legacy placeholder.
function ensureApiToken() {
	const envPath = join(hermesHome(), ".env");
	let lines = [];
	if (existsSync(envPath)) {
		lines = readFileSync(envPath, "utf8").split("\n");
		const existing = lines.find((l) => l.trim().startsWith(`${ENV_KEY}=`));
		const value = existing?.trim().slice(ENV_KEY.length + 1).replace(/^["']|["']$/g, "");
		if (value && value !== LEGACY_PLACEHOLDER) {
			chmodSync(envPath, 0o600);
			return { envPath, token: value, generated: false };
		}
		lines = lines.filter((l) => !l.trim().startsWith(`${ENV_KEY}=`));
		if (lines.length && lines[lines.length - 1] !== "") lines.push("");
	}
	const token = randomBytes(32).toString("hex");
	lines.push(`${ENV_KEY}=${token}`);
	if (lines[lines.length - 1] !== "") lines.push("");
	writeFileSync(envPath, lines.join("\n"));
	chmodSync(envPath, 0o600);
	return { envPath, token, generated: true };
}

// Add providers.claude-bridge to config.yaml (the system the `hermes model`
// switch uses). Validates the file is a YAML map first, preserves comments and
// any user-added sibling keys under the entry.
export function ensureConfigProvider(port) {
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
	let previousPort;
	if (existed) {
		const prevUrl = String(doc.getIn(["providers", "claude-bridge", "base_url"]) ?? "");
		previousPort = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)\//.exec(prevUrl)?.[1];
	}
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
	return { configPath, existed, previousPort };
}

function servicePath(node, stableServer, port, logFile, token) {
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
    <key>${x(ENV_KEY)}</key><string>${x(token)}</string>
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
Environment=${ENV_KEY}=${token}
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
		if (await portIsFree(port)) return true;
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}

async function fetchHealthz(port) {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
		if (!res.ok) return null;
		const body = await res.json();
		return body && typeof body === "object" ? body : null;
	} catch {
		return null;
	}
}

// The only process install may displace is its own service (bootout above).
// Anything else still holding the port would leave the new service crash-
// looping on EADDRINUSE while the squatter answers the health check.
async function ensurePortFree(port) {
	if (await waitForPortFree(port)) return;
	const body = await fetchHealthz(port);
	const who =
		body?.service === SERVICE_NAME
			? `another ${SERVICE_NAME} instance${body.version ? ` (v${body.version})` : ""} — perhaps started manually`
			: "a process that does not identify as the bridge";
	throw new Error(`port ${port} is still in use by ${who}. Stop it or pick a different --port, then re-run install.`);
}

async function installService(node, stableServer, port, logFile, token) {
	const svc = servicePath(node, stableServer, port, logFile, token);
	mkdirSync(dirname(svc.file), { recursive: true });
	// The unit file carries the bearer token.
	writeFileSync(svc.file, svc.contents);
	chmodSync(svc.file, 0o600);

	if (platform() === "darwin") {
		const uid = process.getuid();
		const domain = `gui/${uid}`;
		try {
			execFileSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
		} catch {
			/* not loaded */
		}
		await ensurePortFree(port);
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

// A 200 alone is not proof: a foreign process or a stale bridge could hold
// the port. Require the service name and the exact version just installed.
export async function healthCheck(port, attempts = 40) {
	let saw = null;
	for (let i = 0; i < attempts; i++) {
		const body = await fetchHealthz(port);
		if (body) {
			if (body.service === SERVICE_NAME && body.version === PACKAGE_JSON.version) {
				return { ok: true, saw: body };
			}
			saw = body;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	return { ok: false, saw };
}

// Confirms the running service got the same token Hermes will send.
async function authCheck(port, token) {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		return res.ok;
	} catch {
		return false;
	}
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
  • add a random ${ENV_KEY} to ${join(home, ".env")} (the bridge requires it as a bearer token)
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

	const { envPath, token, generated } = ensureApiToken();
	console.log(`• ${generated ? "Generated" : "Reused"} ${ENV_KEY} in ${envPath} (bearer token — keep it secret)`);

	const { configPath, existed, previousPort } = ensureConfigProvider(port);
	console.log(`• ${existed ? "Updated" : "Added"} providers.claude-bridge in ${configPath}`);
	const portChanged = previousPort !== undefined && previousPort !== String(port);
	if (portChanged) console.log(`• Provider port changed: ${previousPort} → ${port}`);

	const logsDir = join(home, "logs");
	mkdirSync(logsDir, { recursive: true });
	const logFile = join(logsDir, "claude-bridge.log");

	if (service) {
		console.log(`• Registering auto-start service (port ${port})…`);
		const { svcFile, activated } = await installService(node, stableServer, port, logFile, token);
		console.log(`• Service: ${svcFile}`);
		console.log(`• Logs: ${logFile}`);
		if (activated) {
			const { ok, saw } = await healthCheck(port);
			if (ok) {
				console.log(`• Bridge v${PACKAGE_JSON.version} is up on http://127.0.0.1:${port}`);
				if (!(await authCheck(port, token))) {
					console.log(`• ⚠️  The running bridge rejected the ${ENV_KEY} in ${envPath} — an older instance may still hold the port.`);
				}
			} else if (saw?.service === SERVICE_NAME) {
				throw new Error(
					`port ${port} still answers as ${SERVICE_NAME} ${saw.version ? `v${saw.version}` : "(no version reported)"} — not the v${PACKAGE_JSON.version} just installed. A stale instance is holding the port; stop it and re-run install.`,
				);
			} else if (saw) {
				throw new Error(
					`port ${port} is serving something that is not hermes-claude-bridge — the service cannot bind. Pick a different --port and re-run install.`,
				);
			} else {
				console.log("• ⚠️  Bridge did not answer /healthz yet — check the log.");
			}
		}
	} else {
		if (portChanged && (await fetchHealthz(previousPort))?.service === SERVICE_NAME) {
			console.log(
				`• ⚠️  A bridge is still running on the old port ${previousPort}, but config.yaml now points at ${port}.\n` +
					`    Stop it (or restart it on port ${port}) — anything still using it runs the old install.`,
			);
		}
		console.log(
			"• Skipped service (--no-service). Run it with the token in the environment:\n" +
				`      export $(grep -m1 '^${ENV_KEY}=' ${envPath}) && hermes-claude-bridge start`,
		);
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
  • The bridge listens on 127.0.0.1:${port}, only locally, and only for callers that send the ${ENV_KEY} bearer token.
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
