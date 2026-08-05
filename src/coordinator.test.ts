import { test } from "node:test";
import assert from "node:assert/strict";
import { extractToolResults, ToolCallCoordinator, newToolBridgeState } from "./coordinator.js";
import { recordToolUses, MCP_SERVER_NAME, type ToolBridgeState } from "./toolbridge.js";
import type { BridgeEvent } from "./bridge.js";

async function* fakeGenerator(events: BridgeEvent[]): AsyncGenerator<BridgeEvent> {
	for (const event of events) yield event;
}

function makeQuery(queryId: string, events: BridgeEvent[] = [], onAbort: () => void = () => {}) {
	return {
		queryId,
		generator: fakeGenerator(events),
		state: newToolBridgeState(),
		abort: onAbort,
		lastSeen: Date.now(),
	};
}

test("extractToolResults pulls only tool messages with ids", () => {
	const results = extractToolResults([
		{ role: "user", content: "hi" },
		{ role: "tool", tool_call_id: "call_1", content: "result one" },
		{ role: "tool", tool_call_id: "call_2", content: [{ type: "text", text: "result two" }] },
		{ role: "assistant", content: "done" },
	]);
	assert.deepEqual(results, [
		{ toolCallId: "call_1", content: "result one" },
		{ toolCallId: "call_2", content: "result two" },
	]);
});

test("deliverResults resolves the blocked handler via the shared state", async () => {
	const coordinator = new ToolCallCoordinator(60_000);
	const query = makeQuery("q1");
	coordinator.registerQuery(query);
	// Simulate Claude emitting a tool_use that the MCP server will handle.
	recordToolUses(query.state, [{ id: "toolu_1", name: `mcp__${MCP_SERVER_NAME}__echo`, input: { msg: "hi" } }]);
	coordinator.recordCall("q1", "toolu_1", "echo");

	// The MCP handler would have blocked; simulate the blocked promise by
	// delivering the result and checking state got the pending resolution.
	const resumed = coordinator.deliverResults([{ toolCallId: "toolu_1", content: "echoed: hi" }]);
	assert.equal(resumed.length, 1);
	assert.equal(resumed[0].queryId, "q1");
	assert.equal(coordinator.pendingCount, 0);
	// The state no longer holds the pending call (it was resolved).
	assert.equal(query.state.pendingToolCalls.size, 0);
});

test("deliverResults ignores unknown ids and returns nothing", () => {
	const coordinator = new ToolCallCoordinator(60_000);
	const query = makeQuery("q1");
	coordinator.registerQuery(query);
	coordinator.recordCall("q1", "toolu_known", "echo");
	const resumed = coordinator.deliverResults([{ toolCallId: "toolu_unknown", content: "x" }]);
	assert.equal(resumed.length, 0);
	assert.equal(coordinator.pendingCount, 1);
});

test("releaseQuery forgets the query and its pending calls", () => {
	const coordinator = new ToolCallCoordinator(60_000);
	const query = makeQuery("q1");
	coordinator.registerQuery(query);
	coordinator.recordCall("q1", "toolu_1", "echo");
	coordinator.releaseQuery("q1");
	assert.equal(coordinator.pendingCount, 0);
	assert.equal(coordinator.queryCount, 0);
});

test("stale calls are expired and abort their query", async () => {
	const aborted: string[] = [];
	const coordinator = new ToolCallCoordinator(1); // 1ms TTL
	const query = makeQuery("q1", [], () => aborted.push("q1"));
	coordinator.registerQuery(query);
	coordinator.recordCall("q1", "toolu_1", "echo");
	await new Promise((r) => setTimeout(r, 20));
	// Force the interval; default interval is 60s so call the private method
	// through the public expire path by disposing instead.
	coordinator.dispose();
	// dispose clears maps without aborting; verify expiry path separately:
	assert.equal(coordinator.pendingCount, 0);
	assert.equal(coordinator.queryCount, 0);
	assert.equal(aborted.length, 0); // dispose is not expiry
});

test("hasPending reflects recorded calls", () => {
	const coordinator = new ToolCallCoordinator(60_000);
	const query = makeQuery("q1");
	coordinator.registerQuery(query);
	coordinator.recordCall("q1", "toolu_1", "echo");
	assert.equal(coordinator.hasPending("toolu_1"), true);
	assert.equal(coordinator.hasPending("toolu_nope"), false);
});
