// Hermes tool bridging: expose Hermes' OpenAI tool definitions to Claude Code
// through an in-process MCP server whose handlers BLOCK until Hermes delivers
// the tool result across the HTTP boundary.
//
// The bridge never executes tools. It advertises Hermes' schemas, and when
// Claude Code calls one, the MCP handler blocks on a promise. The bridge emits
// an OpenAI tool_call to Hermes (finish_reason "tool_calls"); Hermes executes
// the tool with its own permissions and sends the result back in the next
// request; the bridge resolves the blocked handler with that result and Claude
// Code continues the same turn.
//
// This mirrors pi-claude-bridge's mechanism, with the coordination carried
// across HTTP instead of in-process.

import { z } from "zod";
import { createSdkMcpServer, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

export const MCP_SERVER_NAME = "hermes-tools";

/** One OpenAI function tool definition as Hermes sends it in the request. */
export type HermesToolDef = {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
};

/** A tool call surfaced to Hermes (the OpenAI tool_call payload). */
export type ToolCallInvocation = {
	/** OpenAI tool_call id — matches the SDK's tool_use block id. */
	id: string;
	/** Hermes tool name (MCP prefix stripped). */
	name: string;
	/** JSON-serialized arguments string. */
	arguments: string;
};

/** The result an MCP handler returns to Claude Code. */
export type McpResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

/**
 * Per-query bridge state shared between the MCP server handlers and the HTTP
 * coordinator. Handlers and the coordinator both close over this object, so a
 * tool result arriving in a later HTTP request resolves the handler that is
 * blocking the currently-running Agent SDK query.
 */
export type ToolBridgeState = {
	/** tool_use ids observed in the current assistant message, in order. */
	turnToolCallIds: string[];
	/** Index of the next handler invocation within turnToolCallIds. */
	nextHandlerIdx: number;
	/** Blocked handlers awaiting a result, keyed by tool_use id. */
	pendingToolCalls: Map<string, { toolName: string; resolve: (result: McpResult) => void }>;
	/** Results that arrived before the handler was invoked (parallel calls). */
	pendingResults: Map<string, McpResult>;
};

export function createToolBridgeState(): ToolBridgeState {
	return {
		turnToolCallIds: [],
		nextHandlerIdx: 0,
		pendingToolCalls: new Map(),
		pendingResults: new Map(),
	};
}

// --- JSON Schema → Zod conversion -------------------------------------------
//
// The SDK's MCP tools/list handler calls zodToJsonSchema() on each tool's
// inputSchema. It detects Zod via the `~standard` marker or `_def`/`_zod`
// properties; plain JSON Schema objects silently fall back to an empty shape,
// so the model would see no parameters. Ported from pi-claude-bridge.

function jsonSchemaPropertyToZod(prop: Record<string, unknown>): z.ZodTypeAny {
	let base: z.ZodTypeAny;
	if (Array.isArray(prop.enum)) base = z.enum(prop.enum as [string, ...string[]]);
	else
		switch (prop.type) {
			case "string":
				base = z.string();
				break;
			case "number":
			case "integer":
				base = z.number();
				break;
			case "boolean":
				base = z.boolean();
				break;
			case "array":
				base = prop.items ? z.array(jsonSchemaPropertyToZod(prop.items as Record<string, unknown>)) : z.array(z.unknown());
				break;
			case "object":
				base = z.record(z.string(), z.unknown());
				break;
			default:
				base = z.unknown();
		}
	if (typeof prop.description === "string") base = base.describe(prop.description);
	return base;
}

function jsonSchemaToZodShape(schema: unknown): Record<string, z.ZodTypeAny> {
	const s = schema as Record<string, unknown>;
	if (!s || s.type !== "object" || !s.properties) return {};
	const props = s.properties as Record<string, Record<string, unknown>>;
	const required = new Set(Array.isArray(s.required) ? (s.required as string[]).map(String) : []);
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const [key, prop] of Object.entries(props)) {
		const zodProp = jsonSchemaPropertyToZod(prop);
		shape[key] = required.has(key) ? zodProp : zodProp.optional();
	}
	return shape;
}

/** Strip the MCP tool prefix (mcp__hermes-tools__web_search → web_search). */
export function mcpToolNameToHermes(toolName: string): string {
	const prefix = `mcp__${MCP_SERVER_NAME}__`;
	return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
}

/**
 * Build the in-process MCP server that advertises Hermes' tool schemas.
 * Handlers block on a promise registered in `state.pendingToolCalls`; the HTTP
 * coordinator resolves it when Hermes returns the tool result.
 */
export function createMcpServer(
	tools: HermesToolDef[],
	state: ToolBridgeState,
): McpSdkServerConfigWithInstance {
	const mcpTools = tools
		.filter((tool) => tool?.type === "function" && typeof tool.function?.name === "string" && tool.function.name)
		.map((tool) => ({
			name: tool.function.name,
			description: tool.function.description || "",
			inputSchema: jsonSchemaToZodShape(tool.function.parameters),
			handler: async (args: unknown): Promise<McpResult> => {
				const toolCallId = state.turnToolCallIds[state.nextHandlerIdx++];
				if (!toolCallId) {
					return {
						content: [{ type: "text", text: "bridge internal error: no tool call id assigned to this handler" }],
						isError: true,
					};
				}
				// A result may have arrived before the handler was invoked
				// (parallel tool calls resolved out of order).
				const already = state.pendingResults.get(toolCallId);
				if (already) {
					state.pendingResults.delete(toolCallId);
					return already;
				}
				return new Promise<McpResult>((resolve) => {
					state.pendingToolCalls.set(toolCallId, { toolName: tool.function.name, resolve });
				});
			},
		}));
	const server = createSdkMcpServer({
		name: MCP_SERVER_NAME,
		version: "1.0.0",
		tools: mcpTools,
		alwaysLoad: true,
	});
	return server;
}

/**
 * Record the tool_use blocks of an assistant message in handler-invocation
 * order and surface them as OpenAI tool calls for Hermes.
 */
export function recordToolUses(state: ToolBridgeState, toolUses: Array<{ id?: string; name?: string; input?: unknown }>): ToolCallInvocation[] {
	const calls: ToolCallInvocation[] = [];
	for (const block of toolUses) {
		if (!block || typeof block.id !== "string" || typeof block.name !== "string") continue;
		state.turnToolCallIds.push(block.id);
		calls.push({
			id: block.id,
			name: mcpToolNameToHermes(block.name),
			arguments: JSON.stringify(block.input ?? {}),
		});
	}
	return calls;
}

/**
 * Deliver a Hermes tool result for the given tool_call_id.
 * Resolves the blocked handler if it is already waiting; otherwise queues the
 * result for when the handler is invoked (parallel calls). Returns true when
 * the id was recognised.
 */
export function deliverToolResult(state: ToolBridgeState, toolCallId: string, content: string, isError = false): boolean {
	const pending = state.pendingToolCalls.get(toolCallId);
	const result: McpResult = { content: [{ type: "text", text: content }], ...(isError ? { isError: true } : {}) };
	if (pending) {
		state.pendingToolCalls.delete(toolCallId);
		pending.resolve(result);
		return true;
	}
	state.pendingResults.set(toolCallId, result);
	return true;
}
