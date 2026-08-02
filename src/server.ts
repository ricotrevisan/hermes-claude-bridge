// OpenAI-compatible HTTP edge for the Hermes ↔ Claude Code bridge.
//
// Endpoints:
//   GET  /healthz               → liveness
//   GET  /v1/models             → advertised model ids
//   POST /v1/chat/completions   → streaming (SSE) and non-streaming
//
// Binds to 127.0.0.1 only. Port from CLAUDE_BRIDGE_PORT (default 8787) — this
// MUST match the Hermes plugin's base_url (the installer templates both).
//
// Every quota-spending route requires the per-install CLAUDE_BRIDGE_API_KEY as
// a bearer token, so a localhost bind is not the only thing standing between
// another local process and the Claude subscription.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runClaude, describeError, type BridgeEvent } from "./bridge.js";
import {
	completion,
	contentChunk,
	finishChunk,
	mapStopReason,
	mapUsage,
	reasoningChunk,
	roleChunk,
	sseFrame,
	SSE_DONE,
	usageChunk,
	type AnthropicUsage,
	type OpenAIFinishReason,
} from "./openai.js";
import type { OpenAIMessage } from "./convert.js";
import { expectedContextWindow, MODEL_IDS, resolveModel, runtimeModelId } from "./models.js";

// Injected by esbuild at build time; absent when running from source.
declare const __BRIDGE_VERSION__: string;
const BRIDGE_VERSION = typeof __BRIDGE_VERSION__ === "string" ? __BRIDGE_VERSION__ : "dev";

const DEFAULT_PORT = 8787;
const HEADERS_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 120_000;

function newId(): string {
	return "chatcmpl-" + randomBytes(12).toString("hex");
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
	res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string, type = "bridge_error"): void {
	sendJson(res, status, { error: { message, type, code: null } });
}

async function readBody(req: IncomingMessage, limitBytes = 64 * 1024 * 1024): Promise<string> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > limitBytes) throw new Error("request body too large");
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function modelsResponse(): unknown {
	const created = nowSeconds();
	return {
		object: "list",
		data: MODEL_IDS.map((id) => ({
			id,
			object: "model",
			created,
			owned_by: "anthropic",
			context_window: expectedContextWindow(id),
		})),
	};
}

export type BridgeRunner = typeof runClaude;

function hasBearerToken(req: IncomingMessage, token: string): boolean {
	const header = req.headers.authorization ?? "";
	if (!/^bearer /i.test(header)) return false;
	// Digest first so the comparison is constant-time regardless of length.
	const presented = createHash("sha256").update(header.slice(7).trim()).digest();
	return timingSafeEqual(presented, createHash("sha256").update(token).digest());
}

function errorHttpStatus(event: Extract<BridgeEvent, { type: "error" }>): number {
	if (event.status === "authentication_failed") return 401;
	if (event.status === "overage") return 402;
	if (event.status === "rate_limit" || event.httpStatus === 429) return 429;
	if (event.httpStatus === 400) return 400;
	return 502;
}

// Shape-check the request at the HTTP boundary so malformed payloads fail as
// 400 instead of throwing inside conversion and surfacing as upstream errors.
function validateMessages(messages: unknown[]): string | null {
	for (const message of messages) {
		if (!message || typeof message !== "object") return "each message must be an object";
		const m = message as OpenAIMessage;
		if (typeof m.role !== "string" || !m.role) return "each message must have a string `role`";
		const content = m.content;
		if (content !== undefined && content !== null && typeof content !== "string" && !Array.isArray(content)) {
			return "message `content` must be a string, an array of content parts, or null";
		}
		if (Array.isArray(content)) {
			for (const part of content) {
				if (!part || typeof part !== "object" || typeof (part as { type?: unknown }).type !== "string") {
					return "each content part must be an object with a string `type`";
				}
			}
		}
		if (m.tool_calls !== undefined && (!Array.isArray(m.tool_calls) || m.tool_calls.some((call) => !call || typeof call !== "object"))) {
			return "`tool_calls` must be an array of objects";
		}
	}
	return null;
}

async function handleChatCompletion(req: IncomingMessage, res: ServerResponse, runner: BridgeRunner): Promise<void> {
	if (req.headers.origin) {
		sendError(res, 403, "browser-origin requests are not allowed", "forbidden");
		return;
	}
	const contentType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
	if (contentType !== "application/json") {
		sendError(res, 415, "Content-Type must be application/json", "invalid_request_error");
		return;
	}

	let parsed: any;
	try {
		parsed = JSON.parse(await readBody(req));
	} catch {
		sendError(res, 400, "invalid JSON body", "invalid_request_error");
		return;
	}

	const messages = parsed?.messages as OpenAIMessage[] | undefined;
	if (!Array.isArray(messages) || messages.length === 0) {
		sendError(res, 400, "`messages` must be a non-empty array", "invalid_request_error");
		return;
	}
	const validationError = validateMessages(messages);
	if (validationError) {
		sendError(res, 400, validationError, "invalid_request_error");
		return;
	}

	if (parsed?.model !== undefined && typeof parsed.model !== "string") {
		sendError(res, 400, "`model` must be a string", "invalid_request_error");
		return;
	}
	const model = resolveModel(parsed?.model);
	if (!model) {
		sendError(
			res,
			400,
			`unsupported model ${JSON.stringify(parsed.model)}; allowed model IDs: ${MODEL_IDS.join(", ")}`,
			"invalid_request_error",
		);
		return;
	}
	const stream = parsed?.stream === true;
	const reasoning = parsed?.reasoning_effort ?? parsed?.reasoning?.effort;
	if (reasoning !== undefined && typeof reasoning !== "string") {
		sendError(res, 400, "`reasoning_effort` must be a string", "invalid_request_error");
		return;
	}

	// Client disconnect → abort the underlying query.
	const ac = new AbortController();
	res.on("close", () => {
		if (!res.writableEnded) ac.abort();
	});

	const events = runner(messages, { model: runtimeModelId(model), reasoning, signal: ac.signal });
	if (stream) {
		await streamResponse(res, events, model);
	} else {
		await bufferResponse(res, events, model);
	}
}

async function streamResponse(
	res: ServerResponse,
	events: AsyncGenerator<BridgeEvent>,
	model: string,
): Promise<void> {
	const id = newId();
	const created = nowSeconds();
	let headersSent = false;
	let usage: AnthropicUsage | null = null;
	let stopReason: string | null = null;

	const startStream = () => {
		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		res.write(sseFrame(roleChunk(id, created, model)));
		headersSent = true;
	};

	const finish = (reason: OpenAIFinishReason) => {
		res.write(sseFrame(finishChunk(id, created, model, reason)));
		// No usage frame without an observed usage event: emitting mapUsage({})
		// would make Hermes record a fabricated 0-token turn.
		if (usage) res.write(sseFrame(usageChunk(id, created, model, mapUsage(usage))));
		res.write(SSE_DONE);
		res.end();
	};

	try {
		for await (const ev of events) {
			switch (ev.type) {
				case "text":
					if (!headersSent) startStream();
					res.write(sseFrame(contentChunk(id, created, model, ev.delta)));
					break;
				case "reasoning":
					if (!headersSent) startStream();
					res.write(sseFrame(reasoningChunk(id, created, model, ev.delta)));
					break;
				case "usage":
					usage = ev.usage;
					break;
				case "done":
					stopReason = ev.stopReason;
					if (!headersSent) startStream();
					finish(mapStopReason(stopReason));
					return;
				case "error": {
					const msg = describeError(ev.message, ev.status);
					if (!headersSent) {
						sendError(res, errorHttpStatus(ev), msg, "upstream_error");
						return;
					}
					// Mid-stream failure: surface the error as content, then finish
					// cleanly so Hermes doesn't treat it as a malformed SSE retry.
					res.write(sseFrame(contentChunk(id, created, model, `\n\n[bridge error] ${msg}`)));
					finish("stop");
					return;
				}
			}
		}
		// Generator ended without an explicit done (shouldn't happen) — close cleanly.
		if (!headersSent) startStream();
		finish(mapStopReason(stopReason));
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (!headersSent) {
			sendError(res, 502, describeError(msg), "upstream_error");
		} else {
			res.write(sseFrame(contentChunk(id, created, model, `\n\n[bridge error] ${msg}`)));
			finish("stop");
		}
	}
}

async function bufferResponse(
	res: ServerResponse,
	events: AsyncGenerator<BridgeEvent>,
	model: string,
): Promise<void> {
	const id = newId();
	const created = nowSeconds();
	let content = "";
	let reasoning = "";
	let usage: AnthropicUsage = {};
	let stopReason: string | null = null;
	let errorMessage: string | null = null;
	let errorStatus = 502;

	try {
		for await (const ev of events) {
			switch (ev.type) {
				case "text":
					content += ev.delta;
					break;
				case "reasoning":
					reasoning += ev.delta;
					break;
				case "usage":
					usage = ev.usage;
					break;
				case "done":
					stopReason = ev.stopReason;
					break;
				case "error":
					errorMessage = describeError(ev.message, ev.status);
					errorStatus = errorHttpStatus(ev);
					break;
			}
		}
	} catch (err) {
		errorMessage = describeError(err instanceof Error ? err.message : String(err));
	}

	if (errorMessage) {
		sendError(res, errorStatus, errorMessage, "upstream_error");
		return;
	}

	sendJson(
		res,
		200,
		completion(id, created, model, {
			content,
			reasoning: reasoning || undefined,
			finishReason: mapStopReason(stopReason),
			usage: mapUsage(usage),
		}),
	);
}

function handler(req: IncomingMessage, res: ServerResponse, runner: BridgeRunner, token: string): void {
	const url = (req.url ?? "").split("?")[0];
	const method = req.method ?? "GET";

	// Liveness only; it exposes no user content and spends no quota. The
	// installer's health check matches service + version to spot squatters.
	if (method === "GET" && (url === "/healthz" || url === "/health")) {
		sendJson(res, 200, { status: "ok", service: "hermes-claude-bridge", version: BRIDGE_VERSION });
		return;
	}
	if (!hasBearerToken(req, token)) {
		sendError(res, 401, "missing or invalid bearer token (CLAUDE_BRIDGE_API_KEY)", "authentication_error");
		return;
	}
	if (method === "GET" && (url === "/v1/models" || url === "/models")) {
		sendJson(res, 200, modelsResponse());
		return;
	}
	if (method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
		void handleChatCompletion(req, res, runner).catch((err) => {
			const msg = err instanceof Error ? err.message : String(err);
			if (!res.headersSent) sendError(res, 500, msg);
			else if (!res.writableEnded) res.end();
		});
		return;
	}

	sendError(res, 404, `no route for ${method} ${url}`, "not_found");
}

export function createBridgeServer(
	runner: BridgeRunner = runClaude,
	token = process.env.CLAUDE_BRIDGE_API_KEY,
): ReturnType<typeof createServer> {
	if (!token) {
		throw new Error(
			"CLAUDE_BRIDGE_API_KEY is not set. The bridge refuses to serve unauthenticated requests — " +
				"run `hermes-claude-bridge install` to provision a token, or export the one in ~/.hermes/.env.",
		);
	}
	const server = createServer((req, res) => handler(req, res, runner, token));
	// Slow-loris hardening: cap how long a client may take to send headers and
	// the request body. Neither bounds the (possibly long) SSE response.
	server.headersTimeout = HEADERS_TIMEOUT_MS;
	server.requestTimeout = REQUEST_TIMEOUT_MS;
	return server;
}

export function startServer(port = Number(process.env.CLAUDE_BRIDGE_PORT) || DEFAULT_PORT): ReturnType<typeof createServer> {
	const server = createBridgeServer();
	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") {
			console.error(`hermes-claude-bridge: port ${port} is already in use — another bridge instance may be running. Exiting; the service will retry.`);
		} else {
			console.error(`hermes-claude-bridge: server error: ${err.message}`);
		}
		process.exit(1);
	});
	server.listen(port, "127.0.0.1", () => {
		// eslint-disable-next-line no-console
		console.log(`hermes-claude-bridge listening on http://127.0.0.1:${port} (models: ${MODEL_IDS.join(", ")})`);
	});
	return server;
}

// Run when invoked directly (node dist/server.js). realpath both sides so a
// symlinked path (e.g. /tmp → /private/tmp on macOS) still counts as main.
function isMainModule(): boolean {
	if (!process.argv[1]) return false;
	try {
		return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
	} catch {
		return false;
	}
}

if (isMainModule()) {
	try {
		startServer();
	} catch (err) {
		console.error(`hermes-claude-bridge: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}
