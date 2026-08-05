// OpenAI Chat Completions wire types + SSE framing helpers.
//
// This is the edge contract Hermes' chat_completions transport speaks. The two
// load-bearing rules (verified against hermes-agent's streaming consumer):
//   1. A clean turn REQUIRES finish_reason to be set on some chunk
//      (choices[0].finish_reason). Closing the stream without it makes Hermes
//      raise "empty stream ... malformed SSE" and retry the turn.
//   2. Hermes always sends stream_options:{include_usage:true}, so the final
//      chunk must have choices:[] plus a populated usage object.
// We therefore emit: [role] → content/reasoning deltas → finish chunk → usage
// chunk → [DONE].

export type OpenAIUsage = {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_tokens_details?: { cached_tokens: number };
};

export type AnthropicUsage = {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
};

export type OpenAIFinishReason = "stop" | "length" | "tool_calls";

/** Map an Anthropic stop_reason to an OpenAI finish_reason. */
export function mapStopReason(reason: string | null | undefined): OpenAIFinishReason {
	switch (reason) {
		case "max_tokens":
			return "length";
		// Hermes tool-call deltas are not bridged yet. Advertising tool_calls
		// without a corresponding call would leave the client waiting forever.
		case "tool_use":
			return "stop";
		case "end_turn":
		case "stop_sequence":
		default:
			return "stop";
	}
}

/** Map Anthropic token usage to OpenAI usage. prompt_tokens counts all input
 *  (fresh + cache-read + cache-write); cached_tokens reports the cache-read share. */
export function mapUsage(u: AnthropicUsage): OpenAIUsage {
	const input = u.input_tokens ?? 0;
	const output = u.output_tokens ?? 0;
	const cacheRead = u.cache_read_input_tokens ?? 0;
	const cacheWrite = u.cache_creation_input_tokens ?? 0;
	const prompt = input + cacheRead + cacheWrite;
	return {
		prompt_tokens: prompt,
		completion_tokens: output,
		total_tokens: prompt + output,
		prompt_tokens_details: { cached_tokens: cacheRead },
	};
}

/** Serialize an object as a single SSE `data:` frame. */
export function sseFrame(obj: unknown): string {
	return `data: ${JSON.stringify(obj)}\n\n`;
}

/** The OpenAI stream terminator. */
export const SSE_DONE = "data: [DONE]\n\n";

type ChunkDelta = { role?: string; content?: string; reasoning_content?: string };

function chunk(
	id: string,
	created: number,
	model: string,
	choices: unknown[],
	usage?: OpenAIUsage,
): Record<string, unknown> {
	const base: Record<string, unknown> = {
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices,
	};
	if (usage) base.usage = usage;
	return base;
}

function deltaChoice(delta: ChunkDelta, finishReason: OpenAIFinishReason | null) {
	return [{ index: 0, delta, finish_reason: finishReason }];
}

/** First streamed chunk: announce the assistant role. */
export function roleChunk(id: string, created: number, model: string) {
	return chunk(id, created, model, deltaChoice({ role: "assistant" }, null));
}

/** Stream a text delta. */
export function contentChunk(id: string, created: number, model: string, content: string) {
	return chunk(id, created, model, deltaChoice({ content }, null));
}

/** Stream a thinking delta as reasoning_content. */
export function reasoningChunk(id: string, created: number, model: string, reasoning: string) {
	return chunk(id, created, model, deltaChoice({ reasoning_content: reasoning }, null));
}

/**
 * Stream tool calls. Each call is delivered in a single delta carrying its
 * full id, name, and serialized arguments. Hermes' streaming consumer accepts
 * a whole-arguments delta (it accumulates arguments with +=, so one complete
 * delta is equivalent to many partial ones) and keys slots by index.
 */
export function toolCallChunk(
	id: string,
	created: number,
	model: string,
	calls: Array<{ index: number; id: string; name: string; arguments: string }>,
) {
	const toolCalls = calls.map((call) => ({
		index: call.index,
		id: call.id,
		type: "function",
		function: { name: call.name, arguments: call.arguments },
	}));
	return chunk(id, created, model, [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }]);
}

/** Terminating content chunk: carries finish_reason with an empty delta. */
export function finishChunk(
	id: string,
	created: number,
	model: string,
	finishReason: OpenAIFinishReason,
) {
	return chunk(id, created, model, deltaChoice({}, finishReason));
}

/** Final chunk for stream_options.include_usage: empty choices + usage. */
export function usageChunk(id: string, created: number, model: string, usage: OpenAIUsage) {
	return chunk(id, created, model, [], usage);
}

/** Non-streaming chat.completion response. */
export function completion(
	id: string,
	created: number,
	model: string,
	opts: { content: string; reasoning?: string; finishReason: OpenAIFinishReason; usage: OpenAIUsage },
): Record<string, unknown> {
	const message: Record<string, unknown> = { role: "assistant", content: opts.content };
	if (opts.reasoning) message.reasoning_content = opts.reasoning;
	return {
		id,
		object: "chat.completion",
		created,
		model,
		choices: [{ index: 0, message, finish_reason: opts.finishReason }],
		usage: opts.usage,
	};
}

/** Non-streaming response carrying tool calls for Hermes to execute. */
export function completionWithToolCalls(
	id: string,
	created: number,
	model: string,
	opts: { content: string; reasoning?: string; toolCalls: Array<{ id: string; name: string; arguments: string }> },
): Record<string, unknown> {
	const message: Record<string, unknown> = {
		role: "assistant",
		content: opts.content || null,
		tool_calls: opts.toolCalls.map((call) => ({
			id: call.id,
			type: "function",
			function: { name: call.name, arguments: call.arguments },
		})),
	};
	if (opts.reasoning) message.reasoning_content = opts.reasoning;
	return {
		id,
		object: "chat.completion",
		created,
		model,
		choices: [{ index: 0, message, finish_reason: "tool_calls" }],
		usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
	};
}
