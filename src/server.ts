// OpenAI-compatible HTTP edge for the Hermes ↔ Claude Code bridge.
//
// Endpoints:
//   GET  /healthz               → liveness
//   GET  /v1/models             → advertised model ids
//   POST /v1/chat/completions   → streaming (SSE) and non-streaming
//
// Binds to 127.0.0.1 only. Port from CLAUDE_BRIDGE_PORT (default 8787) — this
// MUST match the Hermes plugin's base_url (the installer templates both).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runClaude, forceSubscriptionAuth, describeError, type BridgeEvent } from "./bridge.js";
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

const DEFAULT_PORT = 8787;
const DEFAULT_MODEL = "claude-opus-4-8";
const MODELS = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"];
const MODEL_ALIASES: Record<string, string> = {
	opus: "claude-opus-4-8",
	sonnet: "claude-sonnet-4-6",
	haiku: "claude-haiku-4-5",
};

function resolveModel(requested: string | undefined): string {
	if (!requested) return DEFAULT_MODEL;
	return MODEL_ALIASES[requested.toLowerCase()] ?? requested;
}

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
		data: MODELS.map((id) => ({ id, object: "model", created, owned_by: "anthropic" })),
	};
}

async function handleChatCompletion(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

	const model = resolveModel(parsed?.model);
	const stream = parsed?.stream === true;
	const reasoning = parsed?.reasoning_effort ?? parsed?.reasoning?.effort;

	// Client disconnect → abort the underlying query.
	const ac = new AbortController();
	res.on("close", () => {
		if (!res.writableEnded) ac.abort();
	});

	const events = runClaude(messages, { model, reasoning, signal: ac.signal });
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
	let usage: AnthropicUsage = {};
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
		res.write(sseFrame(usageChunk(id, created, model, mapUsage(usage))));
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
						sendError(res, 502, msg, "upstream_error");
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
					break;
			}
		}
	} catch (err) {
		errorMessage = describeError(err instanceof Error ? err.message : String(err));
	}

	if (errorMessage && !content) {
		sendError(res, 502, errorMessage, "upstream_error");
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

function handler(req: IncomingMessage, res: ServerResponse): void {
	const url = (req.url ?? "").split("?")[0];
	const method = req.method ?? "GET";

	if (method === "GET" && (url === "/healthz" || url === "/health")) {
		sendJson(res, 200, { status: "ok", service: "hermes-claude-bridge" });
		return;
	}
	if (method === "GET" && (url === "/v1/models" || url === "/models")) {
		sendJson(res, 200, modelsResponse());
		return;
	}
	if (method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
		void handleChatCompletion(req, res).catch((err) => {
			const msg = err instanceof Error ? err.message : String(err);
			if (!res.headersSent) sendError(res, 500, msg);
			else if (!res.writableEnded) res.end();
		});
		return;
	}

	sendError(res, 404, `no route for ${method} ${url}`, "not_found");
}

export function startServer(port = Number(process.env.CLAUDE_BRIDGE_PORT) || DEFAULT_PORT): ReturnType<typeof createServer> {
	forceSubscriptionAuth();
	const server = createServer(handler);
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
		console.log(`hermes-claude-bridge listening on http://127.0.0.1:${port} (models: ${MODELS.join(", ")})`);
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
	startServer();
}
