// Uninstaller for hermes-claude-bridge: stop + remove the service and the plugin dir.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { isMap, parseDocument } from "yaml";

const LABEL = "com.ricotrevisan.hermes-claude-bridge";
const ENV_KEY = "CLAUDE_BRIDGE_API_KEY";
// What install writes; anything else in the entry or plugin dir is the user's.
const OWNED_PROVIDER_KEYS = ["name", "base_url", "key_env", "transport", "api_mode"];
const OWNED_PLUGIN_FILES = ["__init__.py", "plugin.yaml"];

function hermesHome() {
	return process.env.HERMES_HOME || join(homedir(), ".hermes");
}

export function removeConfigProvider() {
	const configPath = join(hermesHome(), "config.yaml");
	if (!existsSync(configPath)) return;
	try {
		const doc = parseDocument(readFileSync(configPath, "utf8"));
		const entry = doc.getIn(["providers", "claude-bridge"], true);
		if (entry === undefined) return;
		// Install merges around user-added sibling keys — uninstall must too. A
		// non-map entry is a user replacement holding nothing install wrote.
		if (!isMap(entry)) return;
		for (const key of OWNED_PROVIDER_KEYS) doc.deleteIn(["providers", "claude-bridge", key]);
		const removedAll = entry.items.length === 0;
		if (removedAll) doc.deleteIn(["providers", "claude-bridge"]);
		writeFileSync(configPath, doc.toString());
		console.log(
			removedAll
				? `• Removed providers.claude-bridge from ${configPath}`
				: `• Removed the installed keys from providers.claude-bridge in ${configPath} (kept your custom keys)`,
		);
	} catch {
		/* leave config untouched on parse error */
	}
}

export function removePlugin() {
	const pluginDir = join(hermesHome(), "plugins", "model-providers", "claude-bridge");
	if (!existsSync(pluginDir)) {
		console.log(`• Plugin dir not found (already removed): ${pluginDir}`);
		return;
	}
	for (const f of OWNED_PLUGIN_FILES) {
		rmSync(join(pluginDir, f), { force: true });
		rmSync(join(pluginDir, `${f}.tmp`), { force: true }); // stranded atomic-write temp
	}
	rmSync(join(pluginDir, "__pycache__"), { recursive: true, force: true });
	try {
		rmdirSync(pluginDir);
		console.log(`• Removed plugin ${pluginDir}`);
	} catch {
		console.log(`• Removed plugin files from ${pluginDir} (kept files install did not create)`);
	}
}

function removeEnvKey() {
	const envPath = join(hermesHome(), ".env");
	if (!existsSync(envPath)) return;
	const lines = readFileSync(envPath, "utf8").split("\n");
	// The token only ever authenticates this bridge, so it is dead weight now.
	const kept = lines.filter((l) => !l.trim().startsWith(`${ENV_KEY}=`));
	if (kept.length !== lines.length) {
		writeFileSync(envPath, kept.join("\n"));
		console.log(`• Removed ${ENV_KEY} from ${envPath}`);
	}
}

function removeRuntime() {
	const dir = join(hermesHome(), "claude-bridge");
	if (existsSync(dir)) {
		rmSync(dir, { recursive: true, force: true });
		console.log(`• Removed runtime ${dir}`);
	}
}

function removeService() {
	if (platform() === "darwin") {
		const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
		try {
			execFileSync("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`], { stdio: "ignore" });
		} catch {
			/* not loaded */
		}
		if (existsSync(plist)) {
			rmSync(plist);
			console.log(`• Removed ${plist}`);
		}
		return;
	}
	const unit = join(homedir(), ".config", "systemd", "user", "hermes-claude-bridge.service");
	try {
		execFileSync("systemctl", ["--user", "disable", "--now", "hermes-claude-bridge.service"], { stdio: "ignore" });
	} catch {
		/* not enabled */
	}
	if (existsSync(unit)) {
		rmSync(unit);
		console.log(`• Removed ${unit}`);
		try {
			execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
		} catch {
			/* ignore */
		}
	}
}

export async function uninstall() {
	if (platform() === "win32") {
		throw new Error("Windows is not supported — nothing to uninstall (no service is registered on win32).");
	}
	console.log("• Stopping and removing the auto-start service…");
	removeService();
	removeRuntime();
	removePlugin();
	removeEnvKey();
	removeConfigProvider();

	console.log(`
✅ Uninstalled. The bridge service and Hermes plugin are gone.
   (Your Claude Code login and Hermes config are untouched.)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	uninstall(process.argv.slice(2)).catch((e) => {
		console.error(`uninstall failed: ${e?.message ?? e}`);
		process.exit(1);
	});
}
