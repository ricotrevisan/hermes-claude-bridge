// Build step: type-check with tsc, then bundle project code into dist/server.js.
// The Agent SDK stays external because it resolves a platform-specific Claude
// Code executable relative to its installed package at runtime.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

// Type-check (no emit) — fails the build on type errors.
execFileSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"], { stdio: "inherit" });

// Clean any stale multi-file output so the tarball ships only the bundle.
rmSync("dist", { recursive: true, force: true });

await build({
	entryPoints: ["src/server.ts"],
	outfile: "dist/server.js",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	external: ["@anthropic-ai/claude-agent-sdk"],
	define: { __BRIDGE_VERSION__: JSON.stringify(version) },
	// Shim require() for any CJS dependency that needs it at runtime.
	banner: { js: "import{createRequire as _cr}from'module';const require=_cr(import.meta.url);" },
});

console.log("built dist/server.js (Agent SDK external)");
