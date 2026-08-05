import { test } from "node:test";
import assert from "node:assert/strict";
import {
	createMcpServer,
	createToolBridgeState,
	deliverToolResult,
	mcpToolNameToHermes,
	recordToolUses,
	MCP_SERVER_NAME,
	type HermesToolDef,
} from "./toolbridge.js";

type RegisteredTool = { handler: (args: unknown, extra?: unknown) => Promise<unknown> };

function registeredHandler(
	server: ReturnType<typeof createMcpServer>,
	name: string,
): RegisteredTool["handler"] {
	const tools = (server.instance as any)._registeredTools as Record<string, RegisteredTool>;
	const tool = tools?.[name];
	assert.ok(tool, `expected tool ${name} to be registered`);
	return tool.handler;
}

test("mcpToolNameToHermes strips the MCP server prefix", () => {
	assert.equal(mcpToolNameToHermes(`mcp__${MCP_SERVER_NAME}__web_search`), "web_search");
	assert.equal(mcpToolNameToHermes("web_search"), "web_search");
});

test("recordToolUses assigns ids in order and strips names + serializes args", () => {
	const state = createToolBridgeState();
	const calls = recordToolUses(state, [
		{ id: "toolu_1", name: `mcp__${MCP_SERVER_NAME}__read`, input: { path: "README.md" } },
		{ id: "toolu_2", name: `mcp__${MCP_SERVER_NAME}__bash`, input: { command: "ls" } },
	]);
	assert.deepEqual(calls, [
		{ id: "toolu_1", name: "read", arguments: JSON.stringify({ path: "README.md" }) },
		{ id: "toolu_2", name: "bash", arguments: JSON.stringify({ command: "ls" }) },
	]);
	assert.deepEqual(state.turnToolCallIds, ["toolu_1", "toolu_2"]);
	assert.equal(state.nextHandlerIdx, 0);
});

test("deliverToolResult resolves a blocked handler", async () => {
	const state = createToolBridgeState();
	const tools: HermesToolDef[] = [
		{ type: "function", function: { name: "echo", description: "echo", parameters: { type: "object", properties: { msg: { type: "string" } } } } },
	];
	const server = createMcpServer(tools, state);
	// Claude calls the MCP tool: the SDK records the tool_use first, then the
	// MCP handler reads the id by index and blocks.
	recordToolUses(state, [{ id: "toolu_1", name: `mcp__${MCP_SERVER_NAME}__echo`, input: { msg: "hi" } }]);
	const blocked = registeredHandler(server, "echo")({ msg: "hi" }, {});
	const settled = await Promise.race([blocked.then(() => "resolved"), new Promise((r) => setTimeout(() => r("pending"), 50))]);
	assert.equal(settled, "pending");

	assert.equal(deliverToolResult(state, "toolu_1", "echoed: hi"), true);
	const result: any = await blocked;
	assert.deepEqual(result, { content: [{ type: "text", text: "echoed: hi" }] });
	assert.equal(state.pendingToolCalls.size, 0);
});

test("deliverToolResult queues a result that arrives before the handler blocks", async () => {
	const state = createToolBridgeState();
	recordToolUses(state, [{ id: "toolu_9", name: `mcp__${MCP_SERVER_NAME}__echo`, input: {} }]);
	assert.equal(deliverToolResult(state, "toolu_9", "early result"), true);
	const tools: HermesToolDef[] = [{ type: "function", function: { name: "echo", description: "echo", parameters: { type: "object", properties: {} } } }];
	const server = createMcpServer(tools, state);
	const result: any = await registeredHandler(server, "echo")({}, {});
	assert.deepEqual(result, { content: [{ type: "text", text: "early result" }] });
});

test("createMcpServer exposes only real function tools", () => {
	const state = createToolBridgeState();
	const tools: HermesToolDef[] = [
		{ type: "function", function: { name: "real", description: "d", parameters: { type: "object", properties: {} } } },
		{ type: "function", function: { name: "" } },
	] as HermesToolDef[];
	const server = createMcpServer(tools, state);
	const registered = (server.instance as any)._registeredTools as Record<string, unknown>;
	assert.deepEqual(Object.keys(registered), ["real"]);
});

test("tool input schemas are surfaced (model sees parameters, not an empty shape)", () => {
	const state = createToolBridgeState();
	const tools: HermesToolDef[] = [
		{
			type: "function",
			function: {
				name: "read",
				description: "Read a file",
				parameters: {
					type: "object",
					properties: { path: { type: "string", description: "File path" }, lines: { type: "integer" } },
					required: ["path"],
				},
			},
		},
	];
	const server = createMcpServer(tools, state);
	const registered = (server.instance as any)._registeredTools as Record<string, { inputSchema: any }>;
	const schema = registered.read.inputSchema;
	// The SDK stores a Zod schema; verify it compiles to the JSON Schema we
	// advertised by inspecting its parsed shape via a round-trip call.
	assert.ok(schema, "inputSchema should be set");
	// Zod schemas expose .parse; JSON Schema objects do not — proves the
	// conversion happened rather than silently falling back to an empty shape.
	assert.equal(typeof schema.parse, "function");
	const parsed = schema.parse({ path: "README.md", lines: 3 });
	assert.deepEqual(parsed, { path: "README.md", lines: 3 });
});
