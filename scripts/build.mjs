// Build step: type-check with tsc, then bundle the server into a single
// self-contained dist/server.js (cc-session-io + yaml inlined) so the installed
// service can run from a stable copy with no node_modules.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

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
	// Shim require() for any CJS dependency that needs it at runtime.
	banner: { js: "import{createRequire as _cr}from'module';const require=_cr(import.meta.url);" },
});

console.log("built dist/server.js (bundled)");
