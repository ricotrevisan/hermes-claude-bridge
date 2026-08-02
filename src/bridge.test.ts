import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { describeError, runClaude, servedContextWindow, type BridgeEvent, type RunOptions } from "./bridge.js";

function init(apiKeySource = "none"): any {
	return { type: "system", subtype: "init", apiKeySource };
}

function result(overrides: Record<string, unknown> = {}): any {
	return {
		type: "result",
		subtype: "success",
		is_error: false,
		result: "",
		stop_reason: "end_turn",
		usage: { input_tokens: 3, output_tokens: 4 },
		...overrides,
	};
}

function fakeQuery(
	messages: any[],
	controls: {
		onInterrupt?: () => void;
		onClose?: () => void;
		account?: { apiProvider?: string; subscriptionType?: string };
	} = {},
): Query {
	const iterable = (async function* () {
		for (const message of messages) yield message;
	})() as Query;
	iterable.interrupt = async () => controls.onInterrupt?.();
	iterable.close = () => controls.onClose?.();
	iterable.accountInfo = async () => controls.account ?? ({ apiProvider: "firstParty", subscriptionType: "Claude Max" } as any);
	return iterable;
}

async function collect(messages: Parameters<typeof runClaude>[0], opts: RunOptions): Promise<BridgeEvent[]> {
	const events: BridgeEvent[] = [];
	for await (const event of runClaude(messages, opts)) events.push(event);
	return events;
}

async function firstPrompt(prompt: any): Promise<any> {
	if (typeof prompt === "string") return prompt;
	for await (const message of prompt) return message;
	return undefined;
}

test("clean mode calls query with an isolated one-turn OAuth subscription configuration", async () => {
	const previous = {
		key: process.env.ANTHROPIC_API_KEY,
		token: process.env.ANTHROPIC_AUTH_TOKEN,
		legacyToken: process.env.ANTHROPIC_TOKEN,
		base: process.env.ANTHROPIC_BASE_URL,
		bedrock: process.env.CLAUDE_CODE_USE_BEDROCK,
		vertex: process.env.CLAUDE_CODE_USE_VERTEX,
		vertexProject: process.env.ANTHROPIC_VERTEX_PROJECT_ID,
		bin: process.env.CLAUDE_BRIDGE_CLAUDE_BIN,
		full: process.env.CLAUDE_BRIDGE_FULL_AGENT,
	};
	process.env.ANTHROPIC_API_KEY = "global-key";
	process.env.ANTHROPIC_AUTH_TOKEN = "global-token";
	process.env.ANTHROPIC_TOKEN = "legacy-global-token";
	process.env.ANTHROPIC_BASE_URL = "https://example.invalid";
	process.env.CLAUDE_CODE_USE_BEDROCK = "1";
	process.env.CLAUDE_CODE_USE_VERTEX = "1";
	process.env.ANTHROPIC_VERTEX_PROJECT_ID = "vertex-project";
	process.env.CLAUDE_BRIDGE_CLAUDE_BIN = "/custom/claude";
	delete process.env.CLAUDE_BRIDGE_FULL_AGENT;

	let params: any;
	let closes = 0;
	try {
		const events = await collect(
			[
				{ role: "system", content: "Use this exact system prompt." },
				{ role: "user", content: "hello" },
			],
			{
				model: "claude-test",
				reasoning: "xhigh",
				cwd: "/tmp",
				queryFn: ((value: any) => {
					params = value;
					return fakeQuery([init(), result()], { onClose: () => closes++ });
				}) as any,
			},
		);

		assert.deepEqual(events, [
			{ type: "usage", usage: { input_tokens: 3, output_tokens: 4 } },
			{ type: "done", stopReason: "end_turn" },
		]);
		assert.equal(closes, 1);
		assert.deepEqual(await firstPrompt(params.prompt), {
			type: "user",
			message: {
				role: "user",
				content: "<system-instructions>\nUse this exact system prompt.\n</system-instructions>\n\nhello",
			},
			parent_tool_use_id: null,
		});
		assert.equal(params.options.model, "claude-test");
		assert.equal(params.options.cwd, "/tmp");
		assert.equal(params.options.maxTurns, 1);
		assert.equal(params.options.persistSession, false);
		assert.equal(params.options.effort, "xhigh");
		assert.equal(params.options.includePartialMessages, true);
		assert.deepEqual(params.options.systemPrompt, { type: "preset", preset: "claude_code" });
		assert.deepEqual(params.options.tools, []);
		assert.deepEqual(params.options.mcpServers, {});
		assert.equal(params.options.strictMcpConfig, true);
		assert.deepEqual(params.options.settingSources, []);
		assert.deepEqual(params.options.skills, []);
		assert.deepEqual(params.options.hooks, {});
		assert.deepEqual(params.options.settings, { disableAllHooks: true });
		assert.equal(params.options.pathToClaudeCodeExecutable, "/custom/claude");
		assert.equal("ANTHROPIC_API_KEY" in params.options.env, false);
		assert.equal("ANTHROPIC_AUTH_TOKEN" in params.options.env, false);
		assert.equal("ANTHROPIC_TOKEN" in params.options.env, false);
		assert.equal("ANTHROPIC_BASE_URL" in params.options.env, false);
		assert.equal("CLAUDE_CODE_USE_BEDROCK" in params.options.env, false);
		assert.equal("CLAUDE_CODE_USE_VERTEX" in params.options.env, false);
		assert.equal("ANTHROPIC_VERTEX_PROJECT_ID" in params.options.env, false);
		// A prompt-injected turn must not read the bridge's own token or reconfigure it.
		assert.equal("CLAUDE_BRIDGE_CLAUDE_BIN" in params.options.env, false);
		assert.equal("CLAUDE_BRIDGE_FULL_AGENT" in params.options.env, false);
		assert.equal("CLAUDE_BRIDGE_API_KEY" in params.options.env, false);
		assert.equal(params.options.env.ENABLE_CLAUDEAI_MCP_SERVERS, "0");
		assert.equal(params.options.env.DISABLE_AUTO_COMPACT, "1");
		assert.equal(params.options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
		assert.equal(params.options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
		assert.equal(process.env.ANTHROPIC_API_KEY, "global-key");
		assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, "global-token");
		assert.equal(process.env.ANTHROPIC_TOKEN, "legacy-global-token");
		assert.equal(process.env.ANTHROPIC_BASE_URL, "https://example.invalid");
	} finally {
		for (const [name, value] of [
			["ANTHROPIC_API_KEY", previous.key],
			["ANTHROPIC_AUTH_TOKEN", previous.token],
			["ANTHROPIC_TOKEN", previous.legacyToken],
			["ANTHROPIC_BASE_URL", previous.base],
			["CLAUDE_CODE_USE_BEDROCK", previous.bedrock],
			["CLAUDE_CODE_USE_VERTEX", previous.vertex],
			["ANTHROPIC_VERTEX_PROJECT_ID", previous.vertexProject],
			["CLAUDE_BRIDGE_CLAUDE_BIN", previous.bin],
			["CLAUDE_BRIDGE_FULL_AGENT", previous.full],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

test("served context selects the requested model rather than auxiliary model usage", () => {
	assert.equal(servedContextWindow({
		"claude-haiku-4-5-20251001": { contextWindow: 200_000 },
		"claude-fable-5": { contextWindow: 1_000_000 },
	}, "claude-fable-5[1m]"), 1_000_000);
	assert.equal(servedContextWindow({}, "claude-fable-5[1m]"), undefined);
});

test("served context matches the exact runtime id or its dated snapshots, never a bare prefix", () => {
	// A new model (claude-opus-5-1) must not inherit claude-opus-5's expectations.
	assert.equal(servedContextWindow({ "claude-opus-5-1": { contextWindow: 1_000_000 } }, "claude-opus-5[1m]"), undefined);
	assert.equal(servedContextWindow({ "claude-opus-5": { contextWindow: 1_000_000 } }, "claude-opus-5[1m]"), 1_000_000);
	assert.equal(servedContextWindow({ "claude-opus-5-20260201": { contextWindow: 200_000 } }, "claude-opus-5[1m]"), 200_000);
	assert.equal(servedContextWindow({ "claude-opus-5": {} }, "claude-opus-5[1m]"), undefined);
});

test("warns loudly when the served model keys are unknown to the catalog", async (t) => {
	const warn = t.mock.method(console, "warn", () => {});
	await collect([{ role: "user", content: "hi" }], {
		model: "claude-opus-5[1m]",
		queryFn: (() => fakeQuery([
			init(),
			result({ modelUsage: { "claude-opus-5-1": { contextWindow: 1_000_000 } } }),
		])) as any,
	});
	const warnings = warn.mock.calls.map((call) => String(call.arguments[0]));
	assert.ok(warnings.some((line) => /no modelUsage entry/.test(line) && /claude-opus-5-1/.test(line)),
		`warnings: ${warnings.join(" | ")}`);
});

test("warns when the served entry reports no usable contextWindow", async (t) => {
	const warn = t.mock.method(console, "warn", () => {});
	await collect([{ role: "user", content: "hi" }], {
		model: "claude-opus-5[1m]",
		queryFn: (() => fakeQuery([
			init(),
			result({ modelUsage: { "claude-opus-5": {} } }),
		])) as any,
	});
	const warnings = warn.mock.calls.map((call) => String(call.arguments[0]));
	assert.ok(warnings.some((line) => /no usable contextWindow/.test(line)), `warnings: ${warnings.join(" | ")}`);
});

test("unknown-model errors are not misreported as a missing executable", () => {
	const message = "API Error: 404 model not found";
	assert.equal(describeError(message), message);
	assert.match(describeError("spawn claude ENOENT"), /Could not run Claude Code/);
});

test("clean mode keeps the Claude Code preset but still delivers system instructions", async () => {
	let params: any;
	await collect(
		[
			{ role: "system", content: "always answer in French" },
			{ role: "user", content: "hi" },
		],
		{
			model: "test",
			queryFn: ((value: any) => {
				params = value;
				return fakeQuery([init(), result()]);
			}) as any,
		},
	);
	assert.deepEqual(params.options.systemPrompt, { type: "preset", preset: "claude_code" });
	const prompt = await firstPrompt(params.prompt);
	assert.match(prompt.message.content, /always answer in French/);
});

test("full-agent mode uses Claude Code tools but still suppresses settings and MCP", async () => {
	const previous = process.env.CLAUDE_BRIDGE_FULL_AGENT;
	process.env.CLAUDE_BRIDGE_FULL_AGENT = "1";
	let params: any;
	try {
		await collect(
			[
				{ role: "system", content: "Extra instructions" },
				{ role: "user", content: "hi" },
			],
			{
				model: "test",
				cwd: "/tmp",
				queryFn: ((value: any) => {
					params = value;
					return fakeQuery([init(), result()]);
				}) as any,
			},
		);
		assert.deepEqual(params.options.tools, { type: "preset", preset: "claude_code" });
		assert.deepEqual(params.options.systemPrompt, { type: "preset", preset: "claude_code" });
		assert.equal(params.options.permissionMode, "bypassPermissions");
		assert.equal(params.options.allowDangerouslySkipPermissions, true);
		assert.equal(params.options.maxTurns, undefined);
		assert.equal(params.options.persistSession, false);
		assert.deepEqual(params.options.mcpServers, {});
		assert.equal(params.options.strictMcpConfig, true);
		assert.deepEqual(params.options.settingSources, []);
		assert.equal(params.options.env.ENABLE_CLAUDEAI_MCP_SERVERS, "0");
		assert.equal("CLAUDE_BRIDGE_FULL_AGENT" in params.options.env, false);
	} finally {
		if (previous === undefined) delete process.env.CLAUDE_BRIDGE_FULL_AGENT;
		else process.env.CLAUDE_BRIDGE_FULL_AGENT = previous;
	}
});

test("full-agent mode works in a dedicated workspace instead of the home directory", async () => {
	const previous = { full: process.env.CLAUDE_BRIDGE_FULL_AGENT, home: process.env.HERMES_HOME };
	const hermesHome = await mkdtemp(join(tmpdir(), "bridge-home-"));
	process.env.CLAUDE_BRIDGE_FULL_AGENT = "1";
	process.env.HERMES_HOME = hermesHome;
	let params: any;
	try {
		await collect([{ role: "user", content: "hi" }], {
			model: "test",
			queryFn: ((value: any) => {
				params = value;
				return fakeQuery([init(), result()]);
			}) as any,
		});
		const workspace = join(hermesHome, "claude-bridge-workspace");
		assert.equal(params.options.cwd, workspace);
		assert.deepEqual(await readdir(workspace), []);
	} finally {
		if (previous.full === undefined) delete process.env.CLAUDE_BRIDGE_FULL_AGENT;
		else process.env.CLAUDE_BRIDGE_FULL_AGENT = previous.full;
		if (previous.home === undefined) delete process.env.HERMES_HOME;
		else process.env.HERMES_HOME = previous.home;
		await rm(hermesHome, { recursive: true, force: true });
	}
});

test("streams thinking and text, skips duplicate assistant fallback, and trusts result usage", async () => {
	const events = await collect([{ role: "user", content: "hi" }], {
		model: "test",
		queryFn: (() =>
			fakeQuery([
				init(),
				{ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 99 } } } },
				{ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } },
				{ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } } },
				{ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
				result({ usage: { input_tokens: 7, output_tokens: 8, cache_read_input_tokens: 2 } }),
			])) as any,
	});
	assert.deepEqual(events, [
		{ type: "reasoning", delta: "hmm" },
		{ type: "text", delta: "Hello" },
		{ type: "usage", usage: { input_tokens: 7, output_tokens: 8, cache_read_input_tokens: 2 } },
		{ type: "done", stopReason: "end_turn" },
	]);
});

test("a zero in result usage does not clobber token counts observed in the stream", async () => {
	const events = await collect([{ role: "user", content: "hi" }], {
		model: "test",
		queryFn: (() =>
			fakeQuery([
				init(),
				{ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 500 } } } },
				result({ usage: { input_tokens: 0, output_tokens: 8 } }),
			])) as any,
	});
	assert.deepEqual(events, [
		{ type: "usage", usage: { input_tokens: 500, output_tokens: 8 } },
		{ type: "done", stopReason: "end_turn" },
	]);
});

test("uses assistant text as a fallback when partial text is absent", async () => {
	const events = await collect([{ role: "user", content: "hi" }], {
		model: "test",
		queryFn: (() =>
			fakeQuery([
				init(),
				{ type: "assistant", message: { content: [{ type: "text", text: "fallback" }] } },
				result({ result: "fallback" }),
			])) as any,
	});
	assert.deepEqual(events.filter((event) => event.type === "text"), [{ type: "text", delta: "fallback" }]);
});

test("rejects explicit API-key auth before forwarding assistant output", async () => {
	const events = await collect([{ role: "user", content: "hi" }], {
		model: "test",
		queryFn: (() => fakeQuery([init("user"), { type: "assistant", message: { content: [{ type: "text", text: "billed" }] } }])) as any,
	});
	assert.equal(events.length, 1);
	assert.equal(events[0].type, "error");
	assert.equal((events[0] as any).status, "authentication_failed");
	assert.match((events[0] as any).message, /API-key source/);
});

test("rejects an SDK account that is not a first-party Claude subscription", async () => {
	const events = await collect([{ role: "user", content: "hi" }], {
		model: "test",
		queryFn: (() => fakeQuery([init(), result()], {
			account: { apiProvider: "firstParty" },
		})) as any,
	});
	assert.deepEqual(events, [{
		type: "error",
		status: "authentication_failed",
		message: "Claude Agent SDK did not report a first-party Claude subscription account; refusing non-subscription execution.",
	}]);
});

test("a missing API-key source is refused as unverifiable, not treated as a value", async () => {
	const events = await collect([{ role: "user", content: "hi" }], {
		model: "test",
		queryFn: (() => fakeQuery([{ type: "system", subtype: "init" }, result()])) as any,
	});
	assert.equal(events.length, 1);
	assert.equal(events[0].type, "error");
	assert.equal((events[0] as any).status, "authentication_failed");
	assert.match((events[0] as any).message, /did not report an API-key source/);
});

test("a rejected account never has its prompt consumed", async () => {
	const consumed: any[] = [];
	const events = await collect([{ role: "user", content: "secret prompt" }], {
		model: "test",
		queryFn: ((params: any) => {
			void (async () => {
				for await (const message of params.prompt) consumed.push(message);
			})();
			return fakeQuery([init(), result()], { account: { apiProvider: "bedrock" } });
		}) as any,
	});
	assert.equal(events.length, 1);
	assert.equal(events[0].type, "error");
	assert.equal((events[0] as any).status, "authentication_failed");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(consumed, []);
});

test("normalizes result, assistant, and rejected rate-limit failures", async (t) => {
	const cases = [
		{
			name: "success subtype with is_error",
			messages: [init(), result({ is_error: true, result: "API failed", api_error_status: 529 })],
			status: "error_during_execution",
			message: /API failed/,
			httpStatus: 529,
		},
		{
			name: "SDK result error",
			messages: [init(), result({ subtype: "error_max_turns", is_error: true, errors: ["too many turns"] })],
			status: "error_max_turns",
			message: /too many turns/,
		},
		{
			name: "assistant error",
			messages: [init(), { type: "assistant", error: "billing_error", message: { content: [{ type: "text", text: "payment required" }] } }],
			status: "billing_error",
			message: /payment required/,
		},
		{
			name: "rate limit rejection",
			messages: [init(), { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } }],
			status: "rate_limit",
			message: /rate limit/i,
			httpStatus: 429,
		},
		{
			name: "typed overage rejection without isUsingOverage",
			messages: [init(), { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "overage" } }],
			status: "overage",
			message: /Extra Usage/,
			httpStatus: 402,
		},
		{
			name: "Extra Usage selected",
			messages: [init(), { type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: true } }],
			status: "overage",
			message: /Extra Usage/,
			httpStatus: 402,
		},
		{
			name: "Extra Usage exhausted before a rate-limit event",
			messages: [init(), result({ is_error: true, result: "API Error: 400 You're out of extra usage. Add more and keep going.", api_error_status: 400 })],
			status: "overage",
			message: /out of extra usage/,
			httpStatus: 402,
		},
	];

	for (const item of cases) {
		await t.test(item.name, async () => {
			const events = await collect([{ role: "user", content: "hi" }], {
				model: "test",
				queryFn: (() => fakeQuery(item.messages)) as any,
			});
			assert.equal(events.length, 1);
			assert.equal(events[0].type, "error");
			assert.equal((events[0] as any).status, item.status);
			assert.match((events[0] as any).message, item.message);
			if (item.httpStatus) assert.equal((events[0] as any).httpStatus, item.httpStatus);
		});
	}
});

test("overage wording in non-400 errors is not remapped to a non-retryable 402", async (t) => {
	const cases = [
		{
			name: "quoted user text inside an API 529 result",
			messages: [init(), result({ is_error: true, result: 'The request quoted "out of extra usage" from the user', api_error_status: 529 })],
			status: "error_during_execution",
			httpStatus: 529,
		},
		{
			name: "assistant error text mentioning extra usage with no API status",
			messages: [init(), { type: "assistant", error: "billing_error", message: { content: [{ type: "text", text: "extra usage unavailable for this workspace" }] } }],
			status: "billing_error",
			httpStatus: undefined,
		},
	];
	for (const item of cases) {
		await t.test(item.name, async () => {
			const events = await collect([{ role: "user", content: "hi" }], {
				model: "test",
				queryFn: (() => fakeQuery(item.messages)) as any,
			});
			assert.equal(events.length, 1);
			assert.equal(events[0].type, "error");
			assert.equal((events[0] as any).status, item.status);
			assert.equal((events[0] as any).httpStatus, item.httpStatus);
		});
	}
});

test("a successful turn without rate-limit metadata warns that overage state is unverified", async (t) => {
	const warn = t.mock.method(console, "warn", () => {});
	const events = await collect([{ role: "user", content: "hi" }], {
		model: "test",
		queryFn: (() => fakeQuery([init(), result()])) as any,
	});
	assert.equal(events.at(-1)?.type, "done");
	const warnings = warn.mock.calls.map((call) => String(call.arguments[0]));
	assert.ok(warnings.some((line) => /overage state .*unverified/i.test(line)), `warnings: ${warnings.join(" | ")}`);
});

test("a turn with observed rate-limit metadata does not warn about unverified overage", async (t) => {
	const warn = t.mock.method(console, "warn", () => {});
	await collect([{ role: "user", content: "hi" }], {
		model: "test",
		queryFn: (() => fakeQuery([
			init(),
			{ type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: false } },
			result(),
		])) as any,
	});
	assert.equal(warn.mock.calls.length, 0);
});

test("overage detected after text has streamed still fails the turn without usage or done", async () => {
	const events = await collect([{ role: "user", content: "hi" }], {
		model: "test",
		queryFn: (() => fakeQuery([
			init(),
			{ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } } },
			{ type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: true } },
			result(),
		])) as any,
	});
	assert.deepEqual(events, [
		{ type: "text", delta: "partial" },
		{ type: "error", status: "overage", httpStatus: 402, message: "Claude Agent SDK selected Extra Usage instead of subscription quota; refusing the turn." },
	]);
});

test("an unavailable overage lane does not reject an allowed subscription turn", async () => {
	const events = await collect([{ role: "user", content: "hi" }], {
		model: "test",
		queryFn: (() => fakeQuery([
			init(),
			{ type: "rate_limit_event", rate_limit_info: { status: "allowed", overageStatus: "rejected" } },
			result(),
		])) as any,
	});
	assert.deepEqual(events, [
		{ type: "usage", usage: { input_tokens: 3, output_tokens: 4 } },
		{ type: "done", stopReason: "end_turn" },
	]);
});

test("SDK iteration errors become bridge errors and the query is closed", async () => {
	let closes = 0;
	const broken = (async function* () {
		yield init();
		throw new Error("SDK transport broke");
	})() as Query;
	broken.interrupt = async () => {};
	broken.close = () => closes++;
	broken.accountInfo = async () => ({ apiProvider: "firstParty", subscriptionType: "Claude Max" });

	const events = await collect([{ role: "user", content: "hi" }], {
		model: "test",
		queryFn: (() => broken) as any,
	});
	assert.deepEqual(events, [{ type: "error", message: "SDK transport broke" }]);
	assert.equal(closes, 1);
});

test("a turn without a terminal result fails upstream instead of reporting success or a login prompt", async (t) => {
	const partialText = {
		type: "stream_event",
		event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } },
	};
	const cases = [
		{ name: "init only", messages: [init()] },
		{ name: "partial text then EOF", messages: [init(), partialText] },
		{ name: "zero messages after a verified account", messages: [] },
		{ name: "output before init", messages: [{ type: "assistant", message: { content: [{ type: "text", text: "early" }] } }, result()] },
	];
	for (const item of cases) {
		await t.test(item.name, async () => {
			const events = await collect([{ role: "user", content: "hi" }], {
				model: "test",
				queryFn: (() => fakeQuery(item.messages as any)) as any,
			});
			const last = events.at(-1) as any;
			assert.equal(last.type, "error");
			assert.equal(last.status, "transport_error");
			assert.equal(last.httpStatus, 502);
			assert.doesNotMatch(describeError(last.message, last.status), /claude login/);
			assert.ok(!events.some((event) => event.type === "done"), "must not report success");
		});
	}
});

test("abort interrupts and closes an active query", async () => {
	const controller = new AbortController();
	let release!: () => void;
	let interrupts = 0;
	let closes = 0;
	const active = (async function* () {
		yield init();
		await new Promise<void>((resolve) => {
			release = resolve;
		});
	})() as Query;
	active.accountInfo = async () => ({ apiProvider: "firstParty", subscriptionType: "Claude Max" });
	active.interrupt = async () => {
		interrupts++;
		release();
	};
	active.close = () => {
		closes++;
		release?.();
	};

	const collecting = collect([{ role: "user", content: "hi" }], {
		model: "test",
		signal: controller.signal,
		queryFn: (() => active) as any,
	});
	await new Promise((resolve) => setImmediate(resolve));
	controller.abort();
	assert.deepEqual(await collecting, []);
	assert.equal(interrupts, 1);
	assert.ok(closes >= 1);
});

test("history is replayed through an in-memory session store, never the user's claude dir", async () => {
	const claudeDir = await mkdtemp(join(tmpdir(), "hermes-bridge-test-"));
	const previous = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
	let options: any;
	try {
		await collect(
			[
				{ role: "user", content: "earlier" },
				{ role: "assistant", content: "reply" },
				{ role: "user", content: "now" },
			],
			{
				model: "test",
				cwd: claudeDir,
				queryFn: ((params: any) => {
					options = params.options;
					return fakeQuery([init(), result()]);
				}) as any,
			},
		);
		assert.match(options.resume, /^[0-9a-f-]{36}$/);
		assert.equal(options.persistSession, undefined);

		const entries = await options.sessionStore.load({ projectKey: "any", sessionId: options.resume });
		assert.deepEqual(
			entries.map((entry: any) => entry.message.content),
			["earlier", [{ type: "text", text: "reply" }]],
		);
		assert.equal(await options.sessionStore.load({ projectKey: "any", sessionId: "other" }), null);

		assert.deepEqual(await readdir(claudeDir), []);
	} finally {
		if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = previous;
		await rm(claudeDir, { recursive: true, force: true });
	}
});

