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
			version: "dev", // esbuild injects the real version at build time
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

test("streaming tool-call round-trip: request #1 ends with tool_calls, request #2 resumes the same query", async () => {
	// The runner simulates a query that emits one tool call, then — once the
	// MCP handler resolves — the final answer. The state flows through the
	// server's coordinator: the tool_call event is recorded, request #2's tool
	// results are delivered, and the generator is resumed into response #2.
	const events: BridgeEvent[] = [];
	let released = 0;

	const runner: BridgeRunner = (async function* (messages: unknown, options: any) {
		const state = options.toolBridge;
		// The real SDK records the tool_use, then asynchronously invokes the MCP
		// handler (which blocks). Simulate that: register a blocked handler in
		// pendingToolCalls before yielding the tool_call event.
		state.turnToolCallIds.push("toolu_1");
		let handlerSettled: () => void = () => {};
		const handlerDone = new Promise<void>((resolve) => { handlerSettled = resolve; });
		void (async () => {
			const entry: any = { toolName: "echo", resolve: (r: unknown) => { void r; } };
			await new Promise<void>((resolve) => {
				entry.resolve = (result: unknown) => { void result; handlerSettled(); };
				state.pendingToolCalls.set("toolu_1", entry);
				resolve();
			});
		})();
		yield {
			type: "tool_call",
			calls: [{ id: "toolu_1", name: "echo", arguments: "{}" }],
		};
		// Block until the coordinator delivers the result (resolves the handler).
		await handlerDone;
		yield { type: "text", delta: "The result was echoed: hi" };
		yield { type: "usage", usage: { input_tokens: 10, output_tokens: 5 } };
		yield { type: "done", stopReason: "end_turn" };
	}) as BridgeRunner;

	const server = createBridgeServer(runner, TOKEN);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as AddressInfo).port;
	const baseUrl = `http://127.0.0.1:${port}`;
	try {
		// Request #1: stream=true, tools declared, no tool results yet.
		const resp1 = await fetch(`${baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify({
				model: "fable",
				stream: true,
				tools: [{ type: "function", function: { name: "echo", description: "e", parameters: { type: "object", properties: {} } } }],
				messages: [{ role: "user", content: "call echo" }],
			}),
		});
		assert.equal(resp1.status, 200);
		const text1 = await resp1.text();
		const payloads1 = text1
			.trim()
			.split("\n\n")
			.filter((f) => f.startsWith("data: ") && f !== "data: [DONE]")
			.map((f) => JSON.parse(f.replace(/^data: /, "")));
		// role chunk + tool_calls chunk + finish chunk
		const toolFrame = payloads1.find((p) => p.choices?.[0]?.delta?.tool_calls);
		assert.ok(toolFrame, "expected a tool_calls delta frame");
		assert.equal(toolFrame.choices[0].delta.tool_calls[0].id, "toolu_1");
		assert.equal(toolFrame.choices[0].delta.tool_calls[0].function.name, "echo");
		const finishFrame = payloads1.find((p) => p.choices?.[0]?.finish_reason);
		assert.equal(finishFrame.choices[0].finish_reason, "tool_calls");

		// Request #2: tool result with matching tool_call_id → continuation.
		const resp2 = await fetch(`${baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify({
				model: "fable",
				stream: true,
				messages: [
					{ role: "user", content: "call echo" },
					{ role: "assistant", content: null, tool_calls: [{ id: "toolu_1", type: "function", function: { name: "echo", arguments: "{}" } }] },
					{ role: "tool", tool_call_id: "toolu_1", content: "echoed: hi" },
				],
			}),
		});
		assert.equal(resp2.status, 200);
		const text2 = await resp2.text();
		const payloads2 = text2
			.trim()
			.split("\n\n")
			.filter((f) => f.startsWith("data: ") && f !== "data: [DONE]")
			.map((f) => JSON.parse(f.replace(/^data: /, "")));
		assert.ok(payloads2.some((p) => p.choices?.[0]?.delta?.content === "The result was echoed: hi"));
		const finish2 = payloads2.find((p) => p.choices?.[0]?.finish_reason);
		assert.equal(finish2.choices[0].finish_reason, "stop");
	} finally {
		server.close();
		await once(server, "close");
	}
});

test("buffered tool-call round-trip: response #1 returns tool_calls, response #2 completes", async () => {
	const runner: BridgeRunner = (async function* (messages: unknown, options: any) {
		const state = options.toolBridge;
		state.turnToolCallIds.push("toolu_1");
		let handlerSettled: () => void = () => {};
		const handlerDone = new Promise<void>((resolve) => { handlerSettled = resolve; });
		state.pendingToolCalls.set("toolu_1", {
			toolName: "echo",
			resolve: () => handlerSettled(),
		} as any);
		yield { type: "tool_call", calls: [{ id: "toolu_1", name: "echo", arguments: "{}" }] };
		await handlerDone;
		yield { type: "text", delta: "done" };
		yield { type: "usage", usage: { input_tokens: 4, output_tokens: 2 } };
		yield { type: "done", stopReason: "end_turn" };
	}) as BridgeRunner;

	const server = createBridgeServer(runner, TOKEN);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as AddressInfo).port;
	const baseUrl = `http://127.0.0.1:${port}`;
	try {
		const body1 = {
			model: "fable",
			tools: [{ type: "function", function: { name: "echo", description: "e", parameters: { type: "object", properties: {} } } }],
			messages: [{ role: "user", content: "call echo" }],
		};
		const resp1 = await fetch(`${baseUrl}/v1/chat/completions`, { method: "POST", headers: authHeaders, body: JSON.stringify(body1) });
		assert.equal(resp1.status, 200);
		const json1: any = await resp1.json();
		assert.equal(json1.choices[0].finish_reason, "tool_calls");
		assert.equal(json1.choices[0].message.tool_calls[0].id, "toolu_1");
		assert.equal(json1.choices[0].message.tool_calls[0].function.name, "echo");
		assert.equal(json1.choices[0].message.content, null);

		const body2 = {
			model: "fable",
			messages: [
				{ role: "user", content: "call echo" },
				{ role: "assistant", content: null, tool_calls: [{ id: "toolu_1", type: "function", function: { name: "echo", arguments: "{}" } }] },
				{ role: "tool", tool_call_id: "toolu_1", content: "echoed: hi" },
			],
		};
		const resp2 = await fetch(`${baseUrl}/v1/chat/completions`, { method: "POST", headers: authHeaders, body: JSON.stringify(body2) });
		assert.equal(resp2.status, 200);
		const json2: any = await resp2.json();
		assert.equal(json2.choices[0].message.content, "done");
		assert.equal(json2.choices[0].finish_reason, "stop");
	} finally {
		server.close();
		await once(server, "close");
	}
});
