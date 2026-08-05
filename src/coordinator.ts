// Tool-call coordinator: carries a live Agent SDK query across multiple HTTP
// requests while Hermes executes a tool.
//
// Lifecycle (per Hermes turn that calls a tool):
//   1. Request #1 arrives with `tools` + messages. The server starts runClaude
//      with a shared ToolBridgeState and streams events. When Claude emits
//      tool_use blocks, runClaude yields a `tool_call` BridgeEvent; the server
//      streams OpenAI tool_calls + finish_reason "tool_calls" and ends the
//      response, but keeps the query generator alive (the MCP handler blocks).
//   2. Hermes executes the tool and sends request #2 whose messages include
//      `role: "tool"` results with tool_call_id matching what we emitted.
//   3. The server matches each tool_call_id here, delivers the result into the
//      shared ToolBridgeState (resolving the blocked MCP handler), then resumes
//      pulling the same runClaude generator and streams the continuation into
//      response #2. If Claude calls more tools, the cycle repeats.
//
// The coordinator is deliberately small: it owns pending tool calls and their
// parent queries, and it must never execute a tool itself. Hermes remains the
// tool authority (SECURITY.md).

import { createToolBridgeState, deliverToolResult, type ToolBridgeState } from "./toolbridge.js";
import type { BridgeEvent } from "./bridge.js";

export type PendingQuery = {
	queryId: string;
	/** The runClaude generator, suspended at the tool_call yield. */
	generator: AsyncGenerator<BridgeEvent>;
	/** Shared with the MCP handlers so a delivered result unblocks them. */
	state: ToolBridgeState;
	/** Called when the turn is abandoned (timeout, disconnect). */
	abort: () => void;
	/** Last activity timestamp for expiry. */
	lastSeen: number;
};

export type PendingToolCall = {
	toolCallId: string;
	/** Hermes tool name (MCP prefix stripped). */
	toolName: string;
	/** Parent query that owns this call. */
	query: PendingQuery;
	/** When the call was emitted (for expiry). */
	createdAt: number;
};

const DEFAULT_TTL_MS = 10 * 60_000;
const CLEANUP_INTERVAL_MS = 60_000;

export class ToolCallCoordinator {
	private pendingCalls = new Map<string, PendingToolCall>();
	private queries = new Map<string, PendingQuery>();
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;
	private ttlMs: number;

	constructor(ttlMs = DEFAULT_TTL_MS) {
		this.ttlMs = ttlMs;
	}

	/** Register a fresh query (tool-call capable). */
	registerQuery(query: PendingQuery): void {
		this.queries.set(query.queryId, query);
		this.startCleanup();
	}

	/** Record an emitted tool call against a registered query. */
	recordCall(queryId: string, toolCallId: string, toolName: string): void {
		const query = this.queries.get(queryId);
		if (!query) return;
		query.lastSeen = Date.now();
		this.pendingCalls.set(toolCallId, { toolCallId, toolName, query, createdAt: Date.now() });
	}

	/** True when the id belongs to a call we emitted and are awaiting. */
	hasPending(toolCallId: string): boolean {
		return this.pendingCalls.has(toolCallId);
	}

	/**
	 * Deliver Hermes' tool results for a request's tool messages. Resolves the
	 * blocked MCP handlers and returns the parent queries to resume (one per
	 * distinct query, deduplicated). Unrecognised ids are ignored — they belong
	 * to a different/lapsed turn and the caller treats the request as fresh.
	 */
	deliverResults(results: Array<{ toolCallId: string; content: string; isError?: boolean }>): PendingQuery[] {
		const resumed = new Map<string, PendingQuery>();
		for (const { toolCallId, content, isError } of results) {
			const call = this.pendingCalls.get(toolCallId);
			if (!call) continue;
			this.pendingCalls.delete(toolCallId);
			deliverToolResult(call.query.state, toolCallId, content, isError);
			call.query.lastSeen = Date.now();
			resumed.set(call.query.queryId, call.query);
		}
		return [...resumed.values()];
	}

	/** Forget a query and all its pending calls (abort path). */
	releaseQuery(queryId: string): void {
		const query = this.queries.get(queryId);
		if (!query) return;
		for (const call of this.pendingCalls.values()) {
			if (call.query === query) this.pendingCalls.delete(call.toolCallId);
		}
		this.queries.delete(queryId);
	}

	/** Number of in-flight calls (for diagnostics/tests). */
	get pendingCount(): number {
		return this.pendingCalls.size;
	}

	get queryCount(): number {
		return this.queries.size;
	}

	private startCleanup(): void {
		if (this.cleanupTimer) return;
		this.cleanupTimer = setInterval(() => this.expireStale(), CLEANUP_INTERVAL_MS);
		this.cleanupTimer.unref?.();
	}

	/** Expire calls and abandoned queries past their TTL. */
	private expireStale(): void {
		const now = Date.now();
		for (const call of [...this.pendingCalls.values()]) {
			if (now - call.createdAt > this.ttlMs) {
				this.pendingCalls.delete(call.toolCallId);
				call.query.abort();
				this.releaseQuery(call.query.queryId);
			}
		}
		for (const query of [...this.queries.values()]) {
			if (now - query.lastSeen > this.ttlMs) {
				query.abort();
				this.queries.delete(query.queryId);
			}
		}
	}

	/** Stop timers (tests / shutdown). */
	dispose(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
		this.pendingCalls.clear();
		this.queries.clear();
	}
}

/** Extract OpenAI tool-result messages from a request's messages array. */
export function extractToolResults(
	messages: Array<{ role?: string; tool_call_id?: string; content?: unknown }>,
): Array<{ toolCallId: string; content: string; isError?: boolean }> {
	const results: Array<{ toolCallId: string; content: string; isError?: boolean }> = [];
	for (const message of messages) {
		if (message?.role !== "tool" || typeof message.tool_call_id !== "string" || !message.tool_call_id) continue;
		const content = Array.isArray(message.content)
			? message.content
					.map((part: any) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : ""))
					.join("")
			: typeof message.content === "string"
				? message.content
				: "";
		results.push({ toolCallId: message.tool_call_id, content });
	}
	return results;
}

/** Create a fresh tool-bridge state for a new query. */
export function newToolBridgeState(): ToolBridgeState {
	return createToolBridgeState();
}
