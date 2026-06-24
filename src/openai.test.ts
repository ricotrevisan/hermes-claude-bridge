import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mapStopReason,
	mapUsage,
	sseFrame,
	SSE_DONE,
	roleChunk,
	contentChunk,
	reasoningChunk,
	finishChunk,
	usageChunk,
	completion,
} from "./openai.js";

const ID = "chatcmpl-test";
const CREATED = 1750000000;
const MODEL = "claude-opus-4-8";

test("mapStopReason: Anthropic stop reasons → OpenAI finish_reason", () => {
	assert.equal(mapStopReason("end_turn"), "stop");
	assert.equal(mapStopReason("stop_sequence"), "stop");
	assert.equal(mapStopReason("max_tokens"), "length");
	assert.equal(mapStopReason("tool_use"), "tool_calls");
	assert.equal(mapStopReason(null), "stop");
	assert.equal(mapStopReason(undefined), "stop");
});

test("mapUsage: prompt_tokens includes cached + cache-write input; cached_tokens reported", () => {
	const u = mapUsage({
		input_tokens: 100,
		output_tokens: 40,
		cache_read_input_tokens: 200,
		cache_creation_input_tokens: 10,
	});
	assert.equal(u.prompt_tokens, 310); // 100 + 200 + 10
	assert.equal(u.completion_tokens, 40);
	assert.equal(u.total_tokens, 350);
	assert.deepEqual(u.prompt_tokens_details, { cached_tokens: 200 });
});

test("mapUsage: missing fields default to 0", () => {
	const u = mapUsage({});
	assert.equal(u.prompt_tokens, 0);
	assert.equal(u.completion_tokens, 0);
	assert.equal(u.total_tokens, 0);
	assert.deepEqual(u.prompt_tokens_details, { cached_tokens: 0 });
});

test("sseFrame wraps JSON as an SSE data line ending in a blank line", () => {
	assert.equal(sseFrame({ a: 1 }), 'data: {"a":1}\n\n');
});

test("SSE_DONE is the OpenAI stream terminator", () => {
	assert.equal(SSE_DONE, "data: [DONE]\n\n");
});

test("roleChunk: first chunk announces the assistant role with null finish_reason", () => {
	const c: any = roleChunk(ID, CREATED, MODEL);
	assert.equal(c.id, ID);
	assert.equal(c.object, "chat.completion.chunk");
	assert.equal(c.created, CREATED);
	assert.equal(c.model, MODEL);
	assert.deepEqual(c.choices, [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]);
});

test("contentChunk: streams a text delta with null finish_reason", () => {
	const c: any = contentChunk(ID, CREATED, MODEL, "hello");
	assert.equal(c.object, "chat.completion.chunk");
	assert.deepEqual(c.choices, [{ index: 0, delta: { content: "hello" }, finish_reason: null }]);
});

test("reasoningChunk: streams a thinking delta as reasoning_content", () => {
	const c: any = reasoningChunk(ID, CREATED, MODEL, "thinking...");
	assert.deepEqual(c.choices, [
		{ index: 0, delta: { reasoning_content: "thinking..." }, finish_reason: null },
	]);
});

test("finishChunk: carries finish_reason in choices[0] with an empty delta", () => {
	const c: any = finishChunk(ID, CREATED, MODEL, "stop");
	assert.deepEqual(c.choices, [{ index: 0, delta: {}, finish_reason: "stop" }]);
});

test("usageChunk: final chunk has empty choices[] and a populated usage object", () => {
	const usage = mapUsage({ input_tokens: 5, output_tokens: 7 });
	const c: any = usageChunk(ID, CREATED, MODEL, usage);
	assert.equal(c.object, "chat.completion.chunk");
	assert.deepEqual(c.choices, []);
	assert.deepEqual(c.usage, usage);
});

test("completion: non-streaming response carries message + finish_reason + usage", () => {
	const usage = mapUsage({ input_tokens: 5, output_tokens: 7 });
	const r: any = completion(ID, CREATED, MODEL, {
		content: "the answer",
		finishReason: "stop",
		usage,
	});
	assert.equal(r.id, ID);
	assert.equal(r.object, "chat.completion");
	assert.equal(r.created, CREATED);
	assert.equal(r.model, MODEL);
	assert.equal(r.choices.length, 1);
	assert.deepEqual(r.choices[0], {
		index: 0,
		message: { role: "assistant", content: "the answer" },
		finish_reason: "stop",
	});
	assert.deepEqual(r.usage, usage);
});

test("completion: includes reasoning_content on the message when provided", () => {
	const usage = mapUsage({});
	const r: any = completion(ID, CREATED, MODEL, {
		content: "answer",
		reasoning: "because",
		finishReason: "stop",
		usage,
	});
	assert.equal(r.choices[0].message.reasoning_content, "because");
});
