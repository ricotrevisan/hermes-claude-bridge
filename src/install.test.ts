// Installer/uninstaller behavior (issue #10): symlink-safe plugin writes,
// uninstall preserving user-owned config keys and plugin files, health-check
// identity, and previous-port detection. Everything runs against temp dirs —
// never the real ~/.hermes or the repo's plugin/ sources.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { healthCheck, installedPluginPort, writePlugin } from "../bin/install.mjs";
import { removeConfigProvider, removePlugin } from "../bin/uninstall.mjs";

const PKG_VERSION = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const INIT_SRC = 'PORT = os.environ.get("CLAUDE_BRIDGE_PORT", "8787")\n';
const YAML_SRC = "name: claude-bridge\n";

const tmpDirs: string[] = [];
after(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

function fakePluginSrc(root: string): string {
	const src = join(root, "src-plugin");
	mkdirSync(src);
	writeFileSync(join(src, "__init__.py"), INIT_SRC);
	writeFileSync(join(src, "plugin.yaml"), YAML_SRC);
	return src;
}

test("normal install over a --link install replaces symlinks instead of writing through them", () => {
	const root = tempDir("bridge-plugin-");
	const src = fakePluginSrc(root);
	const dir = join(root, "installed");

	writePlugin(dir, "8787", true, src);
	assert.ok(lstatSync(join(dir, "__init__.py")).isSymbolicLink());
	assert.ok(lstatSync(join(dir, "plugin.yaml")).isSymbolicLink());

	writePlugin(dir, "9999", false, src);
	assert.ok(!lstatSync(join(dir, "__init__.py")).isSymbolicLink());
	assert.ok(!lstatSync(join(dir, "plugin.yaml")).isSymbolicLink());
	assert.match(readFileSync(join(dir, "__init__.py"), "utf8"), /"9999"/);
	// The bug: the port-substituted copy was written through the link into src.
	assert.equal(readFileSync(join(src, "__init__.py"), "utf8"), INIT_SRC);
	assert.equal(readFileSync(join(src, "plugin.yaml"), "utf8"), YAML_SRC);

	// And back to --link over regular files (and over dangling links) still works.
	writePlugin(dir, "8787", true, src);
	assert.ok(lstatSync(join(dir, "__init__.py")).isSymbolicLink());
	rmSync(join(src, "plugin.yaml"));
	writePlugin(dir, "8787", true, src); // plugin.yaml link now dangling
	assert.ok(lstatSync(join(dir, "plugin.yaml")).isSymbolicLink());
});

test("installedPluginPort reads the previously templated port for change detection", () => {
	const root = tempDir("bridge-plugin-");
	const src = fakePluginSrc(root);
	const dir = join(root, "installed");

	assert.equal(installedPluginPort(dir), undefined);
	writePlugin(dir, "9191", false, src);
	assert.equal(installedPluginPort(dir), "9191");
});

const OWNED_ENTRY = `    name: Claude Bridge (Claude Code subscription)
    base_url: http://127.0.0.1:8787/v1
    key_env: CLAUDE_BRIDGE_API_KEY
    transport: openai_chat
    api_mode: chat_completions`;

test("uninstall removes only the installed provider keys, keeping user additions", () => {
	const home = tempDir("bridge-home-");
	process.env.HERMES_HOME = home;
	const cfg = join(home, "config.yaml");
	writeFileSync(
		cfg,
		`default_model: gpt\nproviders:\n  claude-bridge:\n${OWNED_ENTRY}\n    timeout: 99\n  other:\n    base_url: http://example.test\n`,
	);

	removeConfigProvider();
	const after: any = parseDocument(readFileSync(cfg, "utf8")).toJSON();
	assert.deepEqual(after.providers["claude-bridge"], { timeout: 99 });
	assert.equal(after.providers.other.base_url, "http://example.test");
	assert.equal(after.default_model, "gpt");
});

test("uninstall drops the provider entry entirely when only installed keys remain", () => {
	const home = tempDir("bridge-home-");
	process.env.HERMES_HOME = home;
	const cfg = join(home, "config.yaml");
	// default_model is Hermes bookkeeping on our entry — treated as owned.
	writeFileSync(
		cfg,
		`providers:\n  claude-bridge:\n${OWNED_ENTRY}\n    default_model: claude-fable-5\n  other:\n    base_url: http://example.test\n`,
	);

	removeConfigProvider();
	const after: any = parseDocument(readFileSync(cfg, "utf8")).toJSON();
	assert.equal(after.providers["claude-bridge"], undefined);
	assert.equal(after.providers.other.base_url, "http://example.test");
});

function installedPluginDir(home: string, extraUserFile: boolean): string {
	const dir = join(home, "plugins", "model-providers", "claude-bridge");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "__init__.py"), INIT_SRC);
	writeFileSync(join(dir, "plugin.yaml"), YAML_SRC);
	mkdirSync(join(dir, "__pycache__"));
	writeFileSync(join(dir, "__pycache__", "__init__.cpython-312.pyc"), "");
	if (extraUserFile) writeFileSync(join(dir, "notes.txt"), "mine");
	return dir;
}

test("uninstall leaves a user-replaced non-map provider entry untouched", () => {
	const home = tempDir("bridge-home-");
	process.env.HERMES_HOME = home;
	const cfg = join(home, "config.yaml");
	writeFileSync(cfg, "providers:\n  claude-bridge: disabled\n");

	removeConfigProvider();
	const after: any = parseDocument(readFileSync(cfg, "utf8")).toJSON();
	assert.equal(after.providers["claude-bridge"], "disabled");
});

test("uninstall keeps user files in the plugin dir", () => {
	const home = tempDir("bridge-home-");
	process.env.HERMES_HOME = home;
	const dir = installedPluginDir(home, true);

	removePlugin();
	assert.equal(readFileSync(join(dir, "notes.txt"), "utf8"), "mine");
	assert.ok(!existsSync(join(dir, "__init__.py")));
	assert.ok(!existsSync(join(dir, "plugin.yaml")));
	assert.ok(!existsSync(join(dir, "__pycache__")));
});

test("uninstall removes the plugin dir when it holds only installed files", () => {
	const home = tempDir("bridge-home-");
	process.env.HERMES_HOME = home;
	const dir = installedPluginDir(home, false);
	writeFileSync(join(dir, "plugin.yaml.tmp"), ""); // stranded atomic-write temp

	removePlugin();
	assert.ok(!existsSync(dir));
});

test("uninstall removes plugin symlinks without touching their targets", () => {
	const home = tempDir("bridge-home-");
	process.env.HERMES_HOME = home;
	const src = fakePluginSrc(home);
	const dir = join(home, "plugins", "model-providers", "claude-bridge");
	mkdirSync(dir, { recursive: true });
	symlinkSync(join(src, "__init__.py"), join(dir, "__init__.py"));
	symlinkSync(join(src, "plugin.yaml"), join(dir, "plugin.yaml"));

	removePlugin();
	assert.ok(!existsSync(dir));
	assert.equal(readFileSync(join(src, "__init__.py"), "utf8"), INIT_SRC);
});

async function withStubHealthz(body: unknown, fn: (port: number) => Promise<void>): Promise<void> {
	const srv = createServer((_req, res) => {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(body));
	});
	await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
	try {
		await fn((srv.address() as any).port);
	} finally {
		await new Promise((resolve) => srv.close(resolve));
	}
}

test("healthCheck accepts only the bridge reporting the installed version", async () => {
	await withStubHealthz({ status: "ok", service: "hermes-claude-bridge", version: PKG_VERSION }, async (port) => {
		assert.equal((await healthCheck(port, 1)).ok, true);
	});
});

test("healthCheck rejects a foreign process answering 200 on /healthz", async () => {
	await withStubHealthz({ status: "ok" }, async (port) => {
		const result = await healthCheck(port, 1);
		assert.equal(result.ok, false);
		assert.equal(result.saw?.status, "ok");
	});
});

test("healthCheck rejects a stale bridge without the installed version", async () => {
	await withStubHealthz({ status: "ok", service: "hermes-claude-bridge" }, async (port) => {
		const result = await healthCheck(port, 1);
		assert.equal(result.ok, false);
		assert.equal(result.saw?.service, "hermes-claude-bridge");
	});
});
