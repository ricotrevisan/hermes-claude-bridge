import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { createBridgeServer, type BridgeRunner } from "./server.js";
import type { BridgeEvent } from "./bridge.js";

const TOKEN = "test-bridge-token";

async function withServer(
	events: BridgeEvent[],
	run: (baseUrl: string) => Promise<void>,
	onRun?: (options: Parameters<BridgeRunner>[1]) => void,
) {
	const runner: BridgeRunner = (async function* (_messages: unknown, options: Parameters<BridgeRunner>[1]) {
		onRun?.(options);
		for (const event of events) yield event;
	}) as BridgeRunner;
	const server = createBridgeServer(runner, TOKEN);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as AddressInfo).port;
	try {
		await run(`http://127.0.0.1:${port}`);
	} finally {
		server.close();
		await once(server, "close");
	}
}

const requestBody = JSON.stringify({
	model: "fable",
	messages: [{ role: "user", content: "hello" }],
});

const authHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };

test("HTTP edge serves context metadata and sends the measured runtime model", async () => {
	let runtimeModel: string | undefined;
	await withServer([
		{ type: "text", delta: "hello" },
		{ type: "usage", usage: { input_tokens: 2, output_tokens: 1 } },
		{ type: "done", stopReason: "end_turn" },
	], async (baseUrl) => {
		assert.deepEqual(await (await fetch(`${baseUrl}/healthz`)).json(), {
			status: "ok",
			service: "hermes-claude-bridge",
		});
		const models: any = await (await fetch(`${baseUrl}/v1/models`, { headers: authHeaders })).json();
		assert.equal(models.data.length, 8);
		assert.equal(models.data[0].id, "claude-fable-5");
		assert.equal(models.data[0].context_window, 1_000_000);
		assert.equal(models.data.at(-1).context_window, 200_000);

		const response = await fetch(`${baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: authHeaders,
			body: requestBody,
		});
		assert.equal(response.status, 200);
		const completion: any = await response.json();
		assert.equal(completion.model, "claude-fable-5");
		assert.equal(completion.choices[0].message.content, "hello");
		assert.equal(completion.usage.total_tokens, 3);
		assert.equal(runtimeModel, "claude-fable-5[1m]");
	}, (options) => {
		runtimeModel = options.model;
	});
});

test("streaming response preserves Hermes' required SSE frame order", async () => {
	await withServer([
		{ type: "text", delta: "hello" },
		{ type: "usage", usage: { input_tokens: 2, output_tokens: 1 } },
		{ type: "done", stopReason: "end_turn" },
	], async (baseUrl) => {
		const response = await fetch(`${baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify({ ...JSON.parse(requestBody), stream: true }),
		});
		assert.equal(response.status, 200);
		const frames = (await response.text()).trim().split("\n\n");
		assert.equal(frames.length, 5);
		const payloads = frames.slice(0, -1).map((frame) => JSON.parse(frame.replace(/^data: /, "")));
		assert.equal(payloads[0].choices[0].delta.role, "assistant");
		assert.equal(payloads[1].choices[0].delta.content, "hello");
		assert.equal(payloads[2].choices[0].finish_reason, "stop");
		assert.deepEqual(payloads[3].choices, []);
		assert.equal(payloads[3].usage.total_tokens, 3);
		assert.equal(frames[4], "data: [DONE]");
	});
});

test("a stream that ends without a usage event omits the usage frame instead of fabricating zeros", async () => {
	await withServer([
		{ type: "text", delta: "partial" },
	], async (baseUrl) => {
		const response = await fetch(`${baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify({ ...JSON.parse(requestBody), stream: true }),
		});
		assert.equal(response.status, 200);
		const frames = (await response.text()).trim().split("\n\n");
		assert.equal(frames.at(-1), "data: [DONE]");
		const payloads = frames.slice(0, -1).map((frame) => JSON.parse(frame.replace(/^data: /, "")));
		assert.ok(payloads.every((payload) => !("usage" in payload)), "no fabricated zero-usage frame");
		assert.equal(payloads.at(-1).choices[0].finish_reason, "stop");
	});
});

test("HTTP edge rejects malformed messages and reasoning effort as 400 before starting Claude", async () => {
	let runnerStarted = false;
	await withServer([], async (baseUrl) => {
		const malformed = [
			{ name: "null message", payload: { messages: [null] } },
			{ name: "non-object message", payload: { messages: ["hello"] } },
			{ name: "missing role", payload: { messages: [{ content: "hi" }] } },
			{ name: "numeric content", payload: { messages: [{ role: "user", content: 42 }] } },
			{ name: "null content part", payload: { messages: [{ role: "user", content: [null] }] } },
			{ name: "content part without a type", payload: { messages: [{ role: "user", content: [{ text: "hi" }] }] } },
			{ name: "non-array tool_calls", payload: { messages: [{ role: "assistant", content: "hi", tool_calls: {} }] } },
			{ name: "numeric reasoning_effort", payload: { messages: [{ role: "user", content: "hi" }], reasoning_effort: 3 } },
		];
		for (const { name, payload } of malformed) {
			const response = await fetch(`${baseUrl}/v1/chat/completions`, {
				method: "POST",
				headers: authHeaders,
				body: JSON.stringify({ model: "fable", ...payload }),
			});
			assert.equal(response.status, 400, name);
			assert.equal((await response.json() as any).error.type, "invalid_request_error", name);
		}
		assert.equal(runnerStarted, false);
	}, () => {
		runnerStarted = true;
	});
});

test("HTTP edge accepts well-formed content parts and string reasoning effort", async () => {
	let reasoning: unknown;
	await withServer([
		{ type: "usage", usage: { input_tokens: 2, output_tokens: 1 } },
		{ type: "done", stopReason: "end_turn" },
	], async (baseUrl) => {
		const response = await fetch(`${baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify({
				model: "fable",
				messages: [
					{ role: "user", content: [
						{ type: "text", text: "what is this?" },
						{ type: "image_url", image_url: { url: "https://example.com/x.png" } },
					] },
				],
				reasoning_effort: "high",
			}),
		});
		assert.equal(response.status, 200);
	}, (options) => {
		reasoning = options.reasoning;
	});
	assert.equal(reasoning, "high");
});

test("HTTP edge requires the per-install bearer token on every quota-spending route", async () => {
	let runnerStarted = false;
	await withServer([], async (baseUrl) => {
		const rejected = [
			{ name: "missing", headers: { "Content-Type": "application/json" } },
			{ name: "wrong token", headers: { "Content-Type": "application/json", Authorization: "Bearer nope" } },
			{ name: "prefix of the token", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN.slice(0, -1)}` } },
			{ name: "wrong scheme", headers: { "Content-Type": "application/json", Authorization: `Basic ${TOKEN}` } },
		];
		for (const { name, headers } of rejected) {
			const completions = await fetch(`${baseUrl}/v1/chat/completions`, { method: "POST", headers, body: requestBody });
			assert.equal(completions.status, 401, name);
			assert.equal((await completions.json() as any).error.type, "authentication_error", name);
			assert.equal((await fetch(`${baseUrl}/v1/models`, { headers })).status, 401, name);
		}
		// Liveness carries no user content and spends no quota, so it stays open.
		assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
		assert.equal(runnerStarted, false);
	}, () => {
		runnerStarted = true;
	});
});

test("HTTP edge rejects models outside the measured catalog before starting Claude", async () => {
	let runnerStarted = false;
	await withServer([], async (baseUrl) => {
		for (const model of ["claude-sonnet-4-6[1m]", "future-model", "__proto__", "constructor"]) {
			const response = await fetch(`${baseUrl}/v1/chat/completions`, {
				method: "POST",
				headers: authHeaders,
				body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
			});

			assert.equal(response.status, 400, model);
			const body: any = await response.json();
			assert.equal(
				body.error.message,
				`unsupported model ${JSON.stringify(model)}; allowed model IDs: ` +
					"claude-fable-5, claude-opus-5, claude-opus-4-8, claude-opus-4-7, " +
					"claude-opus-4-6, claude-sonnet-5, claude-sonnet-4-6, claude-haiku-4-5",
			);
		}
		assert.equal(runnerStarted, false);
	}, () => {
		runnerStarted = true;
	});
});

test("HTTP edge rejects browser-origin, non-JSON, and malformed model requests", async () => {
	await withServer([], async (baseUrl) => {
		const browser = await fetch(`${baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: { ...authHeaders, Origin: "https://attacker.example", "Content-Type": "text/plain" },
			body: requestBody,
		});
		assert.equal(browser.status, 403);

		const nonJson = await fetch(`${baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: { ...authHeaders, "Content-Type": "text/plain" },
			body: requestBody,
		});
		assert.equal(nonJson.status, 415);

		const badModel = await fetch(`${baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify({ model: 42, messages: [{ role: "user", content: "hi" }] }),
		});
		assert.equal(badModel.status, 400);
	});
});

test("HTTP edge maps subscription failures without forwarding arbitrary status codes", async (t) => {
	const cases: Array<{ event: BridgeEvent; expected: number }> = [
		{ event: { type: "error", status: "authentication_failed", message: "login" }, expected: 401 },
		{ event: { type: "error", status: "overage", message: "extra", httpStatus: 402 }, expected: 402 },
		{ event: { type: "error", status: "rate_limit", message: "limited", httpStatus: 429 }, expected: 429 },
		{ event: { type: "error", status: "server_error", message: "bad", httpStatus: 999 }, expected: 502 },
	];
	for (const item of cases) {
		await t.test(String(item.expected), async () => {
			await withServer([item.event], async (baseUrl) => {
				const response = await fetch(`${baseUrl}/v1/chat/completions`, {
					method: "POST",
					headers: authHeaders,
					body: requestBody,
				});
				assert.equal(response.status, item.expected);
			});
		});
	}
});

test("buffered responses fail instead of returning truncated partial output", async () => {
	await withServer([
		{ type: "text", delta: "partial" },
		{ type: "error", message: "upstream broke" },
	], async (baseUrl) => {
		const response = await fetch(`${baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: authHeaders,
			body: requestBody,
		});
		assert.equal(response.status, 502);
		const body: any = await response.json();
		assert.match(body.error.message, /upstream broke/);
	});
});

test("a tokenless server refuses to start instead of serving unauthenticated", () => {
	assert.throws(() => createBridgeServer(undefined, ""), /CLAUDE_BRIDGE_API_KEY/);
});

test("header and body reads are bounded so a stalled client cannot hold a connection", () => {
	const server = createBridgeServer(undefined, TOKEN);
	assert.ok(server.headersTimeout > 0);
	assert.ok(server.requestTimeout > 0 && server.requestTimeout > server.headersTimeout);
});
